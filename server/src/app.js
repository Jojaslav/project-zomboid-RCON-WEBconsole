const path = require('node:path');
const express = require('express');
const QRCode = require('qrcode');
const { Auth, getCookie, SESSION_TTL_MS } = require('./auth');
const { TwoFactor } = require('./twofactor');
const { RconService } = require('./rcon');
const { ServiceControl, ConfigFiles, cleanError } = require('./system');
const { MetricsCollector } = require('./metrics');
const { version } = require('../package.json');

const COOKIE = 'pz_admin';

function createApp(config, overrides = {}) {
  const auth = overrides.auth || new Auth({ password: config.password });
  const twofactor = overrides.twofactor || new TwoFactor(config.dataDir);
  const rcon = overrides.rcon || new RconService(config.rcon);
  const service = overrides.service || new ServiceControl(config);
  const files = overrides.files || new ConfigFiles(config);
  const metrics = overrides.metrics || new MetricsCollector({ getMainPid: () => service.mainPid() });

  const app = express();
  app.disable('x-powered-by');
  // Only trust forwarded headers from a reverse proxy on this machine.
  if (config.trustProxy) app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '2mb' }));
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...(req.secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
    });
    next();
  });

  const requireAuth = (req, res, next) => {
    if (!auth.isValid(getCookie(req, COOKIE))) return res.status(401).json({ error: 'Authentication required.' });
    next();
  };
  const handle = (fn) => async (req, res) => {
    try { await fn(req, res); }
    catch (error) { res.status(error.status || 500).json({ error: cleanError(error) }); }
  };
  const cookieFlags = (req) => `HttpOnly; SameSite=Strict; Path=/${req.secure ? '; Secure' : ''}`;
  const startSession = (req, res, token) => res.set('Set-Cookie', `${COOKIE}=${token}; ${cookieFlags(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
  const lockout = (res, retryAfter) => {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `Too many attempts. Try again in ${retryAfter}s.` });
  };
  // Sensitive 2FA changes need the password and a current code, and share the login rate limit.
  const reauthenticate = (req, res) => {
    const retryAfter = auth.lockedFor(req.ip);
    if (retryAfter) { lockout(res, retryAfter); return false; }
    if (!auth.checkPassword(String(req.body?.password || '')) || !twofactor.verify(String(req.body?.code || ''))) {
      auth.recordFailure(req.ip);
      res.status(403).json({ error: 'Password or code is incorrect.' });
      return false;
    }
    return true;
  };

  app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'pz-control', version }));
  app.get('/api/session', (req, res) => res.json({ authenticated: auth.isValid(getCookie(req, COOKIE)) }));

  app.post('/api/login', (req, res) => {
    const result = auth.login(String(req.body?.password || ''), req.ip, { twoFactor: twofactor.enabled });
    if (!result.ok) {
      if (result.retryAfter) res.set('Retry-After', String(result.retryAfter));
      return res.status(result.status).json({ error: result.error });
    }
    if (result.challenge) return res.json({ ok: true, twoFactorRequired: true, challenge: result.challenge });
    startSession(req, res, result.token);
    res.json({ ok: true });
  });
  app.post('/api/login/2fa', (req, res) => {
    const retryAfter = auth.lockedFor(req.ip);
    if (retryAfter) return lockout(res, retryAfter);
    const challenge = req.body?.challenge;
    if (!auth.getChallenge(challenge)) return res.status(401).json({ error: 'Login expired. Sign in again.', restart: true });
    if (!twofactor.verify(String(req.body?.code || ''))) {
      auth.failChallenge(challenge, req.ip);
      return res.status(401).json({ error: 'Invalid code.', restart: !auth.getChallenge(challenge) });
    }
    startSession(req, res, auth.completeChallenge(challenge, req.ip));
    res.json({ ok: true });
  });
  app.post('/api/logout', requireAuth, (req, res) => {
    auth.destroy(getCookie(req, COOKIE));
    res.set('Set-Cookie', `${COOKIE}=; ${cookieFlags(req)}; Max-Age=0`);
    res.json({ ok: true });
  });

  app.get('/api/2fa', requireAuth, (_req, res) => res.json({ enabled: twofactor.enabled, backupCodesLeft: twofactor.backupCodesLeft }));
  app.post('/api/2fa/setup', requireAuth, handle(async (_req, res) => {
    const { secret, uri } = twofactor.beginSetup();
    res.json({ secret, uri, qr: `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(uri, { type: 'svg', margin: 1 })).toString('base64')}` });
  }));
  app.post('/api/2fa/enable', requireAuth, (req, res) => {
    const retryAfter = auth.lockedFor(req.ip);
    if (retryAfter) return lockout(res, retryAfter);
    const codes = twofactor.confirmSetup(String(req.body?.code || ''));
    if (!codes) { auth.recordFailure(req.ip); return res.status(400).json({ error: 'That code is not valid. Check the app and your clock, then try again.' }); }
    auth.destroyOthers(getCookie(req, COOKIE));
    res.json({ ok: true, backupCodes: codes });
  });
  app.post('/api/2fa/backup-codes', requireAuth, (req, res) => {
    if (!twofactor.enabled) return res.status(409).json({ error: 'Two-factor authentication is not enabled.' });
    if (reauthenticate(req, res)) res.json({ backupCodes: twofactor.regenerateBackupCodes() });
  });
  app.post('/api/2fa/disable', requireAuth, (req, res) => {
    if (!twofactor.enabled) return res.status(409).json({ error: 'Two-factor authentication is not enabled.' });
    if (!reauthenticate(req, res)) return;
    twofactor.disable();
    auth.destroyOthers(getCookie(req, COOKIE));
    res.json({ ok: true });
  });

  app.get('/api/info', requireAuth, (_req, res) => res.json({
    version,
    rconConfigured: rcon.configured,
    controlsEnabled: service.controlsEnabled,
    files: Object.keys(config.files),
  }));

  app.post('/api/rcon/command', requireAuth, handle(async (req, res) => {
    const command = req.body?.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 1000 || /[\r\n\0]/.test(command)) {
      return res.status(400).json({ error: 'Invalid command.' });
    }
    res.json({ ok: true, response: await rcon.command(command) });
  }));

  app.get('/api/metrics', requireAuth, handle(async (_req, res) => res.json(await metrics.collect())));

  // "SERVER STARTED" is latched until the service stops or its main PID changes.
  const readiness = { ready: false, pid: null };
  app.get('/api/status', requireAuth, handle(async (_req, res) => {
    const status = await service.status();
    if (status.status !== 'active') {
      readiness.ready = false; readiness.pid = null;
    } else {
      try {
        const pid = await service.mainPid();
        if (pid !== readiness.pid) { readiness.pid = pid; readiness.ready = false; }
        if (!readiness.ready) {
          const text = await service.logs();
          const lastStart = Math.max(text.lastIndexOf('Started '), text.lastIndexOf('Starting '));
          readiness.ready = /SERVER STARTED/i.test(lastStart >= 0 ? text.slice(lastStart) : text);
        }
      } catch { /* leave the previous readiness value */ }
    }
    res.json({ ...status, ready: readiness.ready, controlsEnabled: service.controlsEnabled });
  }));
  app.post('/api/service/:action', requireAuth, handle(async (req, res) => {
    await service.act(req.params.action);
    res.json({ ok: true });
  }));
  app.get('/api/logs', requireAuth, handle(async (_req, res) => res.json({ logs: await service.logs() })));

  const knownKind = (req, res, next) => files.resolve(req.params.kind) ? next() : res.status(404).json({ error: 'Unknown config file.' });
  app.get('/api/config/:kind', requireAuth, knownKind, async (req, res) => {
    try { res.json({ content: await files.read(req.params.kind) }); }
    catch (error) { res.status(404).json({ error: `Could not read ${config.files[req.params.kind]}: ${error.message}` }); }
  });
  app.put('/api/config/:kind', requireAuth, knownKind, handle(async (req, res) => {
    const content = req.body?.content;
    if (typeof content !== 'string' || content.length > 2_000_000) return res.status(400).json({ error: 'Invalid config content.' });
    res.json({ ok: true, backup: await files.write(req.params.kind, content) });
  }));
  app.post('/api/config/:kind/backup', requireAuth, knownKind, handle(async (req, res) => {
    res.json({ ok: true, backup: await files.backup(req.params.kind) });
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));
  app.use((_req, res) => res.status(404).json({ error: 'Not found.' }));

  app.locals.services = { auth, rcon, service, files, metrics };
  return app;
}

module.exports = { createApp };

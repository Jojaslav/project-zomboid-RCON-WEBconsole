const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TwoFactor, base32Encode, base32Decode, hotp, verifyTotp } = require('../src/twofactor');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const PASSWORD = 'correct-horse-battery';
const SECRET = base32Encode(Buffer.from('12345678901234567890'));
const codeNow = (secret, offset = 0) => hotp(secret, Math.floor(Date.now() / 30000) + offset);

test('TOTP matches the RFC 6238 test vector', () => {
  assert.equal(base32Decode(SECRET).toString(), '12345678901234567890');
  assert.equal(hotp(SECRET, Math.floor(59 / 30)), '287082');
  assert.ok(verifyTotp(SECRET, '287082', 59_000));
  assert.equal(verifyTotp(SECRET, '287082', 59_000 + 120_000), null);
});

async function start() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-2fa-'));
  const config = loadConfig({ PZ_ADMIN_PASSWORD: PASSWORD, PZ_SERVER_DIR: dir, PZ_DATA_DIR: dir });
  const rcon = { configured: true, command: async () => '', close() {} };
  const service = { controlsEnabled: false, status: async () => ({}), act: async () => {}, logs: async () => '', mainPid: async () => 0 };
  const server = await new Promise((resolve) => { const s = createApp(config, { rcon, service }).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (url, body, cookie = '') => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body || {}) });
  return { dir, base, post, close: () => { server.close(); return fs.rm(dir, { recursive: true, force: true }); } };
}

async function signIn(t) {
  const res = await t.post('/api/login', { password: PASSWORD });
  return res.headers.get('set-cookie').split(';')[0];
}

async function enable(t) {
  const cookie = await signIn(t);
  const setup = await (await t.post('/api/2fa/setup', {}, cookie)).json();
  assert.match(setup.qr, /^data:image\/svg\+xml/);
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  const res = await t.post('/api/2fa/enable', { code: codeNow(setup.secret) }, cookie);
  assert.equal(res.status, 200);
  const { backupCodes } = await res.json();
  return { cookie, secret: setup.secret, backupCodes };
}

test('2FA enrolment, two-step login, and single-use backup codes', async () => {
  const t = await start();
  try {
    const { secret, backupCodes } = await enable(t);
    assert.equal(backupCodes.length, 10);
    const mode = (await fs.stat(path.join(t.dir, '2fa.json'))).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);

    const first = await t.post('/api/login', { password: PASSWORD });
    const body = await first.json();
    assert.equal(body.twoFactorRequired, true);
    assert.equal(first.headers.get('set-cookie'), null);

    const bad = await t.post('/api/login/2fa', { challenge: body.challenge, code: '000000' });
    assert.equal(bad.status, 401);
    // a TOTP step used during enrolment cannot be replayed; use the next step
    const ok = await t.post('/api/login/2fa', { challenge: body.challenge, code: codeNow(secret, 1) });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(`${t.base}/api/info`, { headers: { Cookie: cookie } })).status, 200);

    const second = await (await t.post('/api/login', { password: PASSWORD })).json();
    assert.equal((await t.post('/api/login/2fa', { challenge: second.challenge, code: backupCodes[0] })).status, 200);
    const third = await (await t.post('/api/login', { password: PASSWORD })).json();
    assert.equal((await t.post('/api/login/2fa', { challenge: third.challenge, code: backupCodes[0] })).status, 401);
  } finally { await t.close(); }
});

test('guessing codes is limited per challenge', async () => {
  const t = await start();
  try {
    await enable(t);
    const { challenge } = await (await t.post('/api/login', { password: PASSWORD })).json();
    let last;
    for (let i = 0; i < 5; i++) last = await t.post('/api/login/2fa', { challenge, code: '111111' });
    assert.equal((await last.json()).restart, true);
  } finally { await t.close(); }
});

test('disabling or regenerating requires password and code', async () => {
  const t = await start();
  try {
    const { cookie, secret } = await enable(t);
    assert.equal((await t.post('/api/2fa/disable', { password: 'nope', code: codeNow(secret, 1) }, cookie)).status, 403);
    const regen = await t.post('/api/2fa/backup-codes', { password: PASSWORD, code: codeNow(secret, 1) }, cookie);
    assert.equal(regen.status, 200);
    assert.equal((await regen.json()).backupCodes.length, 10);
    const { backupCodes } = await (await t.post('/api/2fa/backup-codes', { password: PASSWORD, code: codeNow(secret, -1) }, cookie)).json().catch(() => ({}));
    assert.equal(backupCodes, undefined);
  } finally { await t.close(); }
});

test('TwoFactor persists and fails closed on a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-2fa-'));
  try {
    const tf = new TwoFactor(dir);
    const { secret } = tf.beginSetup();
    tf.confirmSetup(codeNow(secret));
    assert.equal(new TwoFactor(dir).enabled, true);
    await fs.writeFile(path.join(dir, '2fa.json'), '{not json');
    assert.throws(() => new TwoFactor(dir).enabled);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Auth } = require('../src/auth');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');
const { parseStat, parseCpuTotals } = require('../src/metrics');

const PASSWORD = 'correct-horse-battery';

async function start(overrides = {}) {
  const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-test-'));
  await fs.writeFile(path.join(serverDir, 'servertest.ini'), 'Mods=a;b\n');
  const config = loadConfig({ PZ_ADMIN_PASSWORD: PASSWORD, PZ_SERVER_DIR: serverDir, PZ_DATA_DIR: serverDir });
  const rcon = { configured: true, command: async (c) => `ran:${c}`, close() {} };
  const service = { controlsEnabled: false, status: async () => ({ status: 'active' }), act: async () => {}, logs: async () => 'log', mainPid: async () => 0 };
  const app = createApp(config, { rcon, service, ...overrides });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, serverDir, close: () => { server.close(); return fs.rm(serverDir, { recursive: true, force: true }); } };
}

async function login(base) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}
const call = (base, cookie, url, method = 'GET', body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: body && JSON.stringify(body) });

test('behind a trusted proxy, HTTPS sessions get a Secure cookie and HSTS', async () => {
  const serverDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-test-'));
  await fs.writeFile(path.join(serverDir, 'servertest.ini'), 'Mods=a\n');
  const config = loadConfig({ PZ_ADMIN_PASSWORD: PASSWORD, PZ_SERVER_DIR: serverDir, PZ_DATA_DIR: serverDir, TRUST_PROXY: '1' });
  const rcon = { configured: false, command: async () => '', close() {} };
  const service = { controlsEnabled: false, status: async () => ({ status: 'active' }), act: async () => {}, logs: async () => '', mainPid: async () => 0 };
  const server = await new Promise((resolve) => { const s = createApp(config, { rcon, service }).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const post = (headers) => fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ password: PASSWORD }) });
    const secure = await post({ 'X-Forwarded-Proto': 'https' });
    assert.match(secure.headers.get('set-cookie'), /; Secure/);
    assert.ok(secure.headers.get('strict-transport-security'));
    const plain = await post({});
    assert.doesNotMatch(plain.headers.get('set-cookie'), /Secure/);
  } finally { server.close(); await fs.rm(serverDir, { recursive: true, force: true }); }
});

test('api requires authentication', async () => {
  const t = await start();
  try {
    for (const url of ['/api/info', '/api/status', '/api/logs', '/api/metrics', '/api/config/ini']) assert.equal((await fetch(t.base + url)).status, 401, url);
    assert.equal((await fetch(`${t.base}/api/rcon/command`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${t.base}/api/health`)).status, 200);
  } finally { await t.close(); }
});

test('login, rcon command, config round-trip with backup', async () => {
  const t = await start();
  try {
    const cookie = await login(t.base);
    const rcon = await (await call(t.base, cookie, '/api/rcon/command', 'POST', { command: 'players' })).json();
    assert.equal(rcon.response, 'ran:players');
    assert.equal((await call(t.base, cookie, '/api/rcon/command', 'POST', { command: 'a\nb' })).status, 400);

    assert.equal((await (await call(t.base, cookie, '/api/config/ini')).json()).content, 'Mods=a;b\n');
    const saved = await (await call(t.base, cookie, '/api/config/ini', 'PUT', { content: 'Mods=c\n' })).json();
    assert.match(saved.backup, /^servertest\.ini\..*\.bak$/);
    assert.equal(await fs.readFile(path.join(t.serverDir, 'servertest.ini'), 'utf8'), 'Mods=c\n');
    assert.equal((await call(t.base, cookie, '/api/config/passwd')).status, 404);
    assert.equal((await call(t.base, cookie, '/api/service/start', 'POST')).status, 200);
  } finally { await t.close(); }
});

test('wrong password is rejected and locks out after repeated failures', async () => {
  const t = await start();
  try {
    let last;
    for (let i = 0; i < 5; i++) last = await fetch(`${t.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(last.status, 401);
    const locked = await fetch(`${t.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    assert.equal(locked.status, 429);
  } finally { await t.close(); }
});

test('sessions expire and lockout clears with time', () => {
  let now = 1_000;
  const auth = new Auth({ password: PASSWORD, now: () => now });
  const { token } = auth.login(PASSWORD, 'ip');
  assert.ok(auth.isValid(token));
  now += 13 * 3600 * 1000;
  assert.equal(auth.isValid(token), false);
  for (let i = 0; i < 5; i++) auth.login('bad', 'ip');
  assert.equal(auth.login(PASSWORD, 'ip').status, 429);
  now += 6 * 60 * 1000;
  assert.ok(auth.login(PASSWORD, 'ip').ok);
});

test('config rejects weak or missing admin password', () => {
  assert.throws(() => loadConfig({}), /PZ_ADMIN_PASSWORD/);
  assert.throws(() => loadConfig({ PZ_ADMIN_PASSWORD: 'short' }), /12/);
  assert.throws(() => loadConfig({ PZ_ADMIN_PASSWORD: PASSWORD, PZ_INI_FILE: '../x.ini' }), /path/);
});

test('proc parsers handle odd process names', () => {
  const stat = '123 (my (weird) proc) S 1 123 123 0 -1 4194560 100 0 0 0 50 25 0 0 20 0 30 0 7777 1000 100 18446744073709551615';
  const p = parseStat(stat);
  assert.deepEqual([p.pid, p.comm, p.ppid, p.utime, p.stime, p.starttime], [123, 'my (weird) proc', 1, 50, 25, 7777]);
  assert.deepEqual(parseCpuTotals('cpu 10 0 10 70 10 0 0 0 0 0\ncpu0 1 1 1 1'), { idle: 80, total: 100 });
});

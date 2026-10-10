const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { hotp } = require('../src/twofactor');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/app');

const PASSWORD = 'correct-horse-battery';
const codeNow = (secret, offset = 0) => hotp(secret, Math.floor(Date.now() / 30000) + offset);

async function start(dir) {
  dir ||= await fs.mkdtemp(path.join(os.tmpdir(), 'pz-users-'));
  const config = loadConfig({ PZ_ADMIN_PASSWORD: PASSWORD, PZ_SERVER_DIR: dir, PZ_DATA_DIR: dir });
  const rcon = { configured: true, command: async () => '', close() {} };
  const service = { controlsEnabled: false, status: async () => ({}), act: async () => {}, logs: async () => '', mainPid: async () => 0 };
  const server = await new Promise((resolve) => { const s = createApp(config, { rcon, service }).listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method) => (url, body, cookie = '') => fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
  return { dir, base, post: call('POST'), get: call('GET'), del: call('DELETE'), close: () => { server.close(); return fs.rm(dir, { recursive: true, force: true }); } };
}

const cookieOf = (res) => res.headers.get('set-cookie').split(';')[0];

async function adminCookie(t) {
  return cookieOf(await t.post('/api/login', { password: PASSWORD }));
}

// Creates a user and walks through first-login enrolment.
async function addUser(t, admin, username, password) {
  const created = await t.post('/api/users', { username, newPassword: password, password: PASSWORD }, admin);
  assert.equal(created.status, 200);
  const login = await (await t.post('/api/login', { username, password })).json();
  assert.equal(login.enrollRequired, true);
  const setup = await (await t.post('/api/login/enroll/start', { challenge: login.challenge })).json();
  assert.match(setup.uri, new RegExp(`^otpauth://totp/.*${username}`));
  const done = await t.post('/api/login/enroll', { challenge: login.challenge, code: codeNow(setup.secret) });
  assert.equal(done.status, 200);
  const { backupCodes } = await done.json();
  return { cookie: cookieOf(done), secret: setup.secret, backupCodes };
}

test('added user enrols 2FA on first login and then signs in with a code', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    const alice = await addUser(t, admin, 'alice', 'alice-long-password');
    assert.equal(alice.backupCodes.length, 10);
    assert.equal((await t.get('/api/info', undefined, alice.cookie)).status, 200);
    assert.equal((await (await t.get('/api/session', undefined, alice.cookie)).json()).user, 'alice');

    const login = await (await t.post('/api/login', { username: 'ALICE', password: 'alice-long-password' })).json();
    assert.equal(login.twoFactorRequired, true);
    assert.equal((await t.post('/api/login/2fa', { challenge: login.challenge, code: codeNow(alice.secret, 1) })).status, 200);
    // an enrolment challenge cannot be used as a code challenge and vice versa
    assert.equal((await t.post('/api/login/enroll', { challenge: login.challenge, code: codeNow(alice.secret, 2) })).status, 401);

    const mode = (await fs.stat(path.join(t.dir, 'users.json'))).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);
    const raw = await fs.readFile(path.join(t.dir, 'users.json'), 'utf8');
    assert.ok(!raw.includes('alice-long-password'));
  } finally { await t.close(); }
});

test('users are independent and wrong credentials look identical', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    await addUser(t, admin, 'alice', 'alice-long-password');
    const wrongPass = await t.post('/api/login', { username: 'alice', password: 'nope-nope-nope' });
    const noUser = await t.post('/api/login', { username: 'ghost', password: 'nope-nope-nope' });
    assert.equal(wrongPass.status, 401);
    assert.equal(noUser.status, 401);
    assert.deepEqual(await wrongPass.json(), await noUser.json());
    // alice's password does not work for admin and vice versa
    assert.equal((await t.post('/api/login', { password: 'alice-long-password' })).status, 401);
  } finally { await t.close(); }
});

test('user management validates input and requires re-authentication', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    assert.equal((await t.post('/api/users', { username: 'bob', newPassword: 'long-enough-pass' })).status, 401);
    assert.equal((await t.post('/api/users', { username: 'bob', newPassword: 'long-enough-pass', password: 'wrong' }, admin)).status, 403);
    assert.equal((await t.post('/api/users', { username: 'bob', newPassword: 'short', password: PASSWORD }, admin)).status, 400);
    assert.equal((await t.post('/api/users', { username: 'Bad Name', newPassword: 'long-enough-pass', password: PASSWORD }, admin)).status, 400);
    assert.equal((await t.post('/api/users', { username: 'admin', newPassword: 'long-enough-pass', password: PASSWORD }, admin)).status, 409);
    assert.equal((await t.post('/api/users', { username: 'bob', newPassword: 'long-enough-pass', password: PASSWORD }, admin)).status, 200);
    assert.equal((await t.post('/api/users', { username: 'bob', newPassword: 'long-enough-pass', password: PASSWORD }, admin)).status, 409);
    const list = (await (await t.get('/api/users', undefined, admin)).json()).users;
    assert.deepEqual(list.map((u) => u.username), ['admin', 'bob']);
    assert.equal(list[1].twoFactor, false);
  } finally { await t.close(); }
});

test('added users have full access, can add users, but cannot disable their 2FA', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    const alice = await addUser(t, admin, 'alice', 'alice-long-password');
    const created = await t.post('/api/users', { username: 'carol', newPassword: 'carol-long-password', password: 'alice-long-password', code: codeNow(alice.secret, 1) }, alice.cookie);
    assert.equal(created.status, 200);
    assert.equal((await t.post('/api/users', { username: 'dave', newPassword: 'dave-long-password', password: 'alice-long-password' }, alice.cookie)).status, 403);
    assert.equal((await t.post('/api/2fa/disable', { password: 'alice-long-password', code: codeNow(alice.secret, 2) }, alice.cookie)).status, 403);
    assert.equal((await t.del('/api/users/alice', undefined, alice.cookie)).status, 400);
  } finally { await t.close(); }
});

test('deleting or resetting a user ends their sessions', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    const alice = await addUser(t, admin, 'alice', 'alice-long-password');
    const reset = await t.post('/api/users/alice/reset', { newPassword: 'brand-new-password', password: PASSWORD }, admin);
    assert.equal(reset.status, 200);
    assert.equal((await t.get('/api/info', undefined, alice.cookie)).status, 401);
    assert.equal((await t.post('/api/login', { username: 'alice', password: 'alice-long-password' })).status, 401);
    assert.equal((await (await t.post('/api/login', { username: 'alice', password: 'brand-new-password' })).json()).enrollRequired, true);

    const bob = await addUser(t, admin, 'bob', 'bob-long-password-1');
    assert.equal((await t.del('/api/users/bob', { password: PASSWORD }, admin)).status, 200);
    assert.equal((await t.get('/api/info', undefined, bob.cookie)).status, 401);
    assert.equal((await t.post('/api/login', { username: 'bob', password: 'bob-long-password-1' })).status, 401);
    assert.equal((await t.del('/api/users/admin', { password: PASSWORD }, admin)).status, 400);
  } finally { await t.close(); }
});

test('users change their own password and other sessions are signed out', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    const alice = await addUser(t, admin, 'alice', 'alice-long-password');
    const second = await (await t.post('/api/login', { username: 'alice', password: 'alice-long-password' })).json();
    const other = cookieOf(await t.post('/api/login/2fa', { challenge: second.challenge, code: codeNow(alice.secret, 1) }));
    const res = await t.post('/api/password', { password: 'alice-long-password', code: alice.backupCodes[0], newPassword: 'changed-long-password' }, alice.cookie);
    assert.equal(res.status, 200);
    assert.equal((await t.get('/api/info', undefined, other)).status, 401);
    assert.equal((await t.get('/api/info', undefined, alice.cookie)).status, 200);
    assert.equal((await t.post('/api/login', { username: 'alice', password: 'changed-long-password' })).status, 200);
    assert.equal((await t.post('/api/password', { password: PASSWORD, newPassword: 'whatever-long-password' }, admin)).status, 400);
  } finally { await t.close(); }
});

test('users survive a restart', async () => {
  const t = await start();
  try {
    const admin = await adminCookie(t);
    await addUser(t, admin, 'alice', 'alice-long-password');
    const again = await start(t.dir);
    try {
      const login = await (await again.post('/api/login', { username: 'alice', password: 'alice-long-password' })).json();
      assert.equal(login.twoFactorRequired, true);
    } finally { await again.close(); }
  } finally { await t.close(); }
});

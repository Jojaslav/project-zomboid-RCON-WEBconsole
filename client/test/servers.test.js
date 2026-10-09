const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { normalizeUrl, checkServer, loadServers, saveServer, forgetServer } = require('../servers');

test('normalizeUrl adds http and strips paths', () => {
  assert.equal(normalizeUrl('192.168.1.5:8080'), 'http://192.168.1.5:8080');
  assert.equal(normalizeUrl('https://pz.example.com/some/path'), 'https://pz.example.com');
  assert.throws(() => normalizeUrl(''), /Enter/);
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /http/);
  assert.throws(() => normalizeUrl('http://'), /valid/);
});

test('checkServer accepts only pz-control servers', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ app: 'pz-control' }) });
  const other = async () => ({ ok: true, json: async () => ({ app: 'something' }) });
  const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  assert.equal((await checkServer('http://x', ok)).app, 'pz-control');
  await assert.rejects(checkServer('http://x', other), /not a Project Zomboid/);
  await assert.rejects(checkServer('http://x', down), /ECONNREFUSED/);
});

test('server list is remembered, de-duplicated and forgettable', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pz-client-'));
  const file = path.join(dir, 'servers.json');
  try {
    assert.deepEqual(await loadServers(file), { last: '', servers: [] });
    await saveServer(file, 'http://a:1');
    await saveServer(file, 'http://b:2');
    const data = await saveServer(file, 'http://a:1');
    assert.deepEqual(data, { last: 'http://a:1', servers: ['http://a:1', 'http://b:2'] });
    assert.deepEqual(await forgetServer(file, 'http://a:1'), { last: '', servers: ['http://b:2'] });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

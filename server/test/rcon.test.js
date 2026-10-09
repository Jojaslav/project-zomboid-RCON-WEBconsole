const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { RconClient, RconService, encodePacket } = require('../src/rcon');

function startFakeRcon(password = 'secret') {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (data) => {
      buf = Buffer.concat([buf, data]);
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0) + 4) {
        const length = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, length + 2).toString('utf8');
        buf = buf.subarray(length + 4);
        if (type === 3) socket.write(encodePacket(body === password ? id : -1, 2, ''));
        else if (type === 2) socket.write(encodePacket(id, 0, body === 'players' ? 'Players connected (1):\n-alice' : `echo:${body}`));
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('client authenticates and runs commands', async () => {
  const server = await startFakeRcon();
  const client = new RconClient();
  try {
    await client.connect('127.0.0.1', server.address().port, 'secret');
    assert.equal(await client.command('players'), 'Players connected (1):\n-alice');
    assert.equal(await client.command('save'), 'echo:save');
  } finally { client.disconnect(); server.close(); }
});

test('client rejects a wrong password', async () => {
  const server = await startFakeRcon();
  const client = new RconClient();
  try {
    await assert.rejects(client.connect('127.0.0.1', server.address().port, 'nope'), /authentication failed/i);
  } finally { client.disconnect(); server.close(); }
});

test('service reconnects after the connection drops', async () => {
  const server = await startFakeRcon();
  const service = new RconService({ host: '127.0.0.1', port: server.address().port, password: 'secret' });
  try {
    assert.equal(await service.command('a'), 'echo:a');
    service.client.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await service.command('b'), 'echo:b');
  } finally { service.close(); server.close(); }
});

test('service without a password reports it is unconfigured', async () => {
  const service = new RconService({ host: '127.0.0.1', port: 1, password: '' });
  await assert.rejects(service.command('x'), /not configured/);
});

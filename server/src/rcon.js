const net = require('node:net');
const { EventEmitter } = require('node:events');

const AUTH = 3;
const AUTH_RESPONSE = 2;
const COMMAND = 2;
const RESPONSE_VALUE = 0;
const TIMEOUT_MS = 10_000;

function encodePacket(id, type, body) {
  const text = Buffer.from(String(body), 'utf8');
  const out = Buffer.alloc(14 + text.length);
  out.writeInt32LE(10 + text.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  text.copy(out, 12);
  return out;
}

class RconClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.nextId = 1;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.on('error', () => {});
  }

  connect(host, port, password) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => { if (!settled) { settled = true; this.disconnect(); reject(error); } };
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      socket.setTimeout(TIMEOUT_MS);
      socket.on('timeout', () => fail(new Error('Connection timed out.')));
      socket.on('error', (error) => { this.emit('error', error); fail(error); });
      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.socket === socket) this.socket = null;
        if (wasConnected) this.emit('disconnect');
        fail(new Error('Connection closed.'));
      });
      socket.on('data', (data) => this.receive(data));
      socket.once('connect', async () => {
        socket.setTimeout(0);
        try {
          await this.request(AUTH, password, (packet) => packet.type === AUTH_RESPONSE);
          this.connected = true;
          settled = true;
          resolve();
        } catch (error) { fail(error); }
      });
    });
  }

  request(type, body, match) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Not connected.'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Server did not respond in time.'));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, match });
      this.socket.write(encodePacket(id, type, body));
    });
  }

  async command(command) {
    const packet = await this.request(COMMAND, command, (p) => p.type === RESPONSE_VALUE);
    return packet.body || '(Command completed with no response)';
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readInt32LE(0);
      if (length < 10 || length > 10 * 1024 * 1024) {
        this.emit('error', new Error('Invalid RCON response.'));
        this.disconnect();
        return;
      }
      if (this.buffer.length < length + 4) return;
      const raw = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      const packet = { id: raw.readInt32LE(0), type: raw.readInt32LE(4), body: raw.subarray(8, -2).toString('utf8') };
      if (packet.type === AUTH_RESPONSE && packet.id === -1) {
        this.rejectAll(new Error('RCON authentication failed.'));
        continue;
      }
      const pending = this.pending.get(packet.id);
      if (pending && pending.match(packet)) {
        clearTimeout(pending.timer);
        this.pending.delete(packet.id);
        pending.resolve(packet);
      }
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.buffer = Buffer.alloc(0);
    if (socket) socket.destroy();
    this.rejectAll(new Error('Disconnected.'));
  }
}

// Keeps one lazily-created, auto-reconnecting RCON connection for the whole server.
class RconService {
  constructor({ host, port, password }) {
    this.options = { host, port, password };
    this.client = null;
    this.connecting = null;
  }

  get configured() { return Boolean(this.options.password); }
  get connected() { return Boolean(this.client?.connected); }

  async ensure() {
    if (this.client?.connected) return this.client;
    if (!this.connecting) {
      const client = new RconClient();
      this.connecting = client.connect(this.options.host, this.options.port, this.options.password)
        .then(() => {
          client.on('disconnect', () => { if (this.client === client) this.client = null; });
          this.client = client;
          return client;
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  async command(command) {
    if (!this.configured) throw new Error('RCON is not configured on the server (RCON_PASSWORD is empty).');
    const client = await this.ensure();
    try { return await client.command(command); }
    catch (error) {
      if (!client.connected) this.client = null;
      throw error;
    }
  }

  close() { this.client?.disconnect(); this.client = null; }
}

module.exports = { RconClient, RconService, encodePacket };

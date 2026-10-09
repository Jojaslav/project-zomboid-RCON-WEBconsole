const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD = 30;
const ISSUER = 'Project Zomboid Control';

function base32Encode(buffer) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0; let value = 0; const out = [];
  for (const char of String(text).toUpperCase().replace(/[\s=-]/g, '')) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret.');
    value = (value << 5) | index; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret, counter, digits = 6) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(message).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

// Returns the matching time step (so it can be recorded to block replays), or null.
function verifyTotp(secret, code, now = Date.now(), afterStep = -1, window = 1) {
  const candidate = String(code).trim();
  if (!/^\d{6}$/.test(candidate)) return null;
  const current = Math.floor(now / 1000 / PERIOD);
  let match = null;
  for (let offset = -window; offset <= window; offset++) {
    const step = current + offset;
    const expected = Buffer.from(hotp(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(candidate)) && step > afterStep && match === null) match = step;
  }
  return match;
}

function generateSecret() { return base32Encode(crypto.randomBytes(20)); }

function otpauthUri(secret, account = 'admin') {
  const label = `${encodeURIComponent(ISSUER)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=${PERIOD}`;
}

const normalizeBackup = (input) => String(input).replace(/[\s-]/g, '').toLowerCase();
const hashBackup = (input) => crypto.createHash('sha256').update(normalizeBackup(input)).digest('hex');

function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(7)).slice(0, 10).toLowerCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

class TwoFactor {
  constructor(dir, now = Date.now) {
    this.file = path.join(dir, '2fa.json');
    this.now = now;
    this.pending = null;
    this.state = this.read();
  }

  // A corrupt file throws on purpose: failing closed beats silently disabling 2FA.
  read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  get enabled() { return Boolean(this.state?.enabled); }
  get backupCodesLeft() { return this.state?.backup?.length ?? 0; }

  beginSetup() {
    if (this.enabled) throw Object.assign(new Error('Two-factor authentication is already enabled.'), { status: 409 });
    this.pending = generateSecret();
    return { secret: this.pending, uri: otpauthUri(this.pending) };
  }

  confirmSetup(code) {
    if (!this.pending) return null;
    const step = verifyTotp(this.pending, code, this.now());
    if (step === null) return null;
    const codes = generateBackupCodes();
    this.state = { enabled: true, secret: this.pending, lastStep: step, backup: codes.map(hashBackup) };
    this.pending = null;
    this.write();
    return codes;
  }

  // Accepts an authenticator code or a one-time backup code.
  verify(input) {
    if (!this.enabled) return false;
    const step = verifyTotp(this.state.secret, input, this.now(), this.state.lastStep ?? -1);
    if (step !== null) { this.state.lastStep = step; this.write(); return true; }
    if (/^\d{6}$/.test(String(input).trim())) return false;
    const hash = hashBackup(input);
    const index = this.state.backup.findIndex((h) => crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash)));
    if (index < 0) return false;
    this.state.backup.splice(index, 1);
    this.write();
    return true;
  }

  regenerateBackupCodes() {
    const codes = generateBackupCodes();
    this.state.backup = codes.map(hashBackup);
    this.write();
    return codes;
  }

  disable() {
    this.state = null;
    this.pending = null;
    fs.rmSync(this.file, { force: true });
  }
}

module.exports = { TwoFactor, base32Encode, base32Decode, hotp, verifyTotp, generateSecret, otpauthUri };

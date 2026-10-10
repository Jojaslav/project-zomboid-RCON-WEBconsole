const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TwoFactor } = require('./twofactor');

const ADMIN = 'admin';
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const MIN_PASSWORD = 12;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function checkHash(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// Compared against when the user does not exist, so timing does not reveal valid names.
const DUMMY_HASH = hashPassword(crypto.randomBytes(12).toString('hex'));

function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

// "admin" is the built-in account (password from the environment, 2FA optional, 2fa.json).
// Every other account lives in users.json with its own password hash and its own mandatory 2FA.
// All accounts have identical permissions.
class UserStore {
  constructor({ dir, adminPassword, now = Date.now }) {
    this.dir = dir;
    this.file = path.join(dir, 'users.json');
    this.adminPassword = adminPassword;
    this.now = now;
    this.twoFactors = new Map();
    this.state = this.read();
  }

  // A corrupt file throws on purpose: failing closed beats silently dropping accounts.
  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return { users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {} };
    } catch (error) {
      if (error.code === 'ENOENT') return { users: {} };
      throw error;
    }
  }

  save() {
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }

  normalize(name) { return String(name ?? '').trim().toLowerCase(); }
  isBuiltin(name) { return name === ADMIN; }
  has(name) { return this.isBuiltin(name) || Object.hasOwn(this.state.users, name); }

  verifyPassword(name, password) {
    const given = String(password ?? '');
    if (this.isBuiltin(name)) return safeEqual(given, this.adminPassword);
    const user = Object.hasOwn(this.state.users, name) ? this.state.users[name] : null;
    const ok = checkHash(given, user ? user.passwordHash : DUMMY_HASH);
    return Boolean(user) && ok;
  }

  twoFactor(name) {
    if (!this.has(name)) return null;
    if (!this.twoFactors.has(name)) {
      if (this.isBuiltin(name)) this.twoFactors.set(name, new TwoFactor(this.dir, this.now, name));
      else {
        const user = this.state.users[name];
        this.twoFactors.set(name, new TwoFactor({
          read: () => user.twofactor ?? null,
          write: (state) => { user.twofactor = state; this.save(); },
          clear: () => { user.twofactor = null; this.save(); },
        }, this.now, name));
      }
    }
    return this.twoFactors.get(name);
  }

  // Added users must enrol an authenticator before they get a session.
  needsEnrollment(name) { return !this.isBuiltin(name) && !this.twoFactor(name).enabled; }

  validatePassword(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD) throw httpError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
    if (password.length > 200) throw httpError(400, 'Password is too long.');
  }

  create(name, password, by) {
    if (!USERNAME.test(name)) throw httpError(400, 'Username must be 3-32 characters: lowercase letters, digits, dot, dash or underscore, starting with a letter or digit.');
    if (this.has(name)) throw httpError(409, 'That username already exists.');
    this.validatePassword(password);
    this.state.users[name] = { passwordHash: hashPassword(password), createdAt: new Date(this.now()).toISOString(), createdBy: by, twofactor: null };
    this.save();
  }

  requireManaged(name) {
    if (this.isBuiltin(name)) throw httpError(400, 'The built-in admin account is managed in /etc/pz-control/pz-control.env.');
    if (!this.has(name)) throw httpError(404, 'No such user.');
  }

  remove(name) {
    this.requireManaged(name);
    delete this.state.users[name];
    this.twoFactors.delete(name);
    this.save();
  }

  setPassword(name, password) {
    this.requireManaged(name);
    this.validatePassword(password);
    this.state.users[name].passwordHash = hashPassword(password);
    this.save();
  }

  // Sets a new password and removes the authenticator, so the user enrols again at next sign-in.
  reset(name, password) {
    this.requireManaged(name);
    this.validatePassword(password);
    this.state.users[name].passwordHash = hashPassword(password);
    this.state.users[name].twofactor = null;
    this.twoFactors.delete(name);
    this.save();
  }

  list() {
    const builtin = { username: ADMIN, builtin: true, twoFactor: this.twoFactor(ADMIN).enabled, createdAt: null, createdBy: null };
    const others = Object.entries(this.state.users)
      .map(([username, u]) => ({ username, builtin: false, twoFactor: this.twoFactor(username).enabled, createdAt: u.createdAt, createdBy: u.createdBy }))
      .sort((a, b) => a.username.localeCompare(b.username));
    return [builtin, ...others];
  }
}

module.exports = { UserStore, ADMIN, USERNAME, MIN_PASSWORD };

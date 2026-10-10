const crypto = require('node:crypto');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function safeEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a)).digest();
  const bh = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah, bh);
}

class Auth {
  constructor({ password, users = null, now = Date.now }) {
    this.password = password;
    this.users = users;
    this.now = now;
    this.sessions = new Map();
    this.failures = new Map();
    this.challenges = new Map();
  }

  lockedFor(ip) {
    const entry = this.failures.get(ip);
    if (!entry || entry.until <= this.now()) return 0;
    return Math.ceil((entry.until - this.now()) / 1000);
  }

  recordFailure(ip) {
    const entry = this.failures.get(ip) || { count: 0, until: 0 };
    entry.count = entry.until && entry.until <= this.now() ? 1 : entry.count + 1;
    entry.until = entry.count >= MAX_FAILURES ? this.now() + LOCKOUT_MS : 0;
    if (entry.count >= MAX_FAILURES) entry.count = 0;
    this.failures.set(ip, entry);
  }

  checkPassword(password, username = 'admin') {
    return this.users ? this.users.verifyPassword(username, password) : safeEqual(password, this.password);
  }

  // With a challenge kind ('code' or 'enroll'), a correct password only yields a short-lived
  // challenge; failures are deliberately not cleared until the second step succeeds, so code
  // guessing stays rate-limited.
  login(password, ip, { twoFactor = false, challenge = null, username = 'admin' } = {}) {
    const retryAfter = this.lockedFor(ip);
    if (retryAfter) return { ok: false, status: 429, error: `Too many attempts. Try again in ${retryAfter}s.`, retryAfter };
    if (!this.checkPassword(password, username)) {
      this.recordFailure(ip);
      return { ok: false, status: 401, error: 'Invalid username or password.' };
    }
    const kind = challenge || (twoFactor ? 'code' : null);
    if (kind) return { ok: true, kind, challenge: this.createChallenge(username, kind) };
    this.failures.delete(ip);
    return { ok: true, token: this.createSession(username) };
  }

  createChallenge(user = 'admin', kind = 'code') {
    const id = crypto.randomBytes(24).toString('hex');
    this.challenges.set(id, { expires: this.now() + CHALLENGE_TTL_MS, attempts: 0, user, kind });
    return id;
  }

  getChallenge(id, kind = null) {
    const entry = typeof id === 'string' ? this.challenges.get(id) : null;
    if (!entry || entry.expires < this.now()) { if (entry) this.challenges.delete(id); return null; }
    if (kind && entry.kind !== kind) return null;
    return entry;
  }

  failChallenge(id, ip) {
    const entry = this.challenges.get(id);
    if (entry && ++entry.attempts >= MAX_FAILURES) this.challenges.delete(id);
    this.recordFailure(ip);
  }

  completeChallenge(id, ip) {
    const entry = this.challenges.get(id);
    this.challenges.delete(id);
    this.failures.delete(ip);
    return this.createSession(entry?.user);
  }

  createSession(user = 'admin') {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, { expires: this.now() + SESSION_TTL_MS, user });
    return token;
  }

  userOf(token) {
    const entry = token && this.sessions.get(token);
    if (!entry || entry.expires < this.now()) {
      if (token) this.sessions.delete(token);
      return null;
    }
    return entry.user;
  }

  isValid(token) { return this.userOf(token) !== null; }

  destroy(token) { this.sessions.delete(token); }

  destroyOthers(keep, user) {
    for (const [token, entry] of this.sessions) {
      if (token !== keep && (user === undefined || entry.user === user)) this.sessions.delete(token);
    }
  }

  destroyUser(user) {
    for (const [token, entry] of this.sessions) if (entry.user === user) this.sessions.delete(token);
    for (const [id, entry] of this.challenges) if (entry.user === user) this.challenges.delete(id);
  }
}
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

module.exports = { Auth, getCookie, SESSION_TTL_MS };

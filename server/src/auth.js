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
  constructor({ password, now = Date.now }) {
    this.password = password;
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

  checkPassword(password) { return safeEqual(password, this.password); }

  // With twoFactor, a correct password only yields a short-lived challenge; failures are
  // deliberately not cleared until the second step succeeds, so code guessing stays rate-limited.
  login(password, ip, { twoFactor = false } = {}) {
    const retryAfter = this.lockedFor(ip);
    if (retryAfter) return { ok: false, status: 429, error: `Too many attempts. Try again in ${retryAfter}s.`, retryAfter };
    if (!this.checkPassword(password)) {
      this.recordFailure(ip);
      return { ok: false, status: 401, error: 'Invalid password.' };
    }
    if (twoFactor) return { ok: true, challenge: this.createChallenge() };
    this.failures.delete(ip);
    return { ok: true, token: this.createSession() };
  }

  createChallenge() {
    const id = crypto.randomBytes(24).toString('hex');
    this.challenges.set(id, { expires: this.now() + CHALLENGE_TTL_MS, attempts: 0 });
    return id;
  }

  getChallenge(id) {
    const entry = typeof id === 'string' ? this.challenges.get(id) : null;
    if (!entry || entry.expires < this.now()) { if (entry) this.challenges.delete(id); return null; }
    return entry;
  }

  failChallenge(id, ip) {
    const entry = this.challenges.get(id);
    if (entry && ++entry.attempts >= MAX_FAILURES) this.challenges.delete(id);
    this.recordFailure(ip);
  }

  completeChallenge(id, ip) {
    this.challenges.delete(id);
    this.failures.delete(ip);
    return this.createSession();
  }

  createSession() {
    const token = crypto.randomBytes(32).toString('hex');
    this.sessions.set(token, this.now() + SESSION_TTL_MS);
    return token;
  }

  isValid(token) {
    const expires = token && this.sessions.get(token);
    if (!expires || expires < this.now()) {
      if (token) this.sessions.delete(token);
      return false;
    }
    return true;
  }

  destroy(token) { this.sessions.delete(token); }

  destroyOthers(keep) {
    for (const token of this.sessions.keys()) if (token !== keep) this.sessions.delete(token);
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

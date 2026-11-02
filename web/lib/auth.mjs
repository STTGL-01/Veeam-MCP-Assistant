// Website accounts, password hashing, sessions and sign-in throttling.
//
// The account model:
//   - one administrator, the account named "admin", seeded as admin/admin
//   - anyone can request an account; it stays "pending" until the admin approves
//   - the admin decides which accounts are approvers, and for which action groups
//
// Differences that matter because this site is reachable over the network:
//   - the default admin password must be changed before anything else works
//   - passwords are hashed with scrypt and need at least MIN_PASSWORD characters
//   - sessions live only in server memory and are never written to disk
//   - repeated failed sign-ins are slowed down per address and per username

import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { JsonFile } from './store.mjs';
import { CATEGORY_IDS } from './categories.mjs';

const scrypt = promisify(crypto.scrypt);

export const ADMIN_USERNAME = 'admin';
export const MIN_PASSWORD = 12;
const MAX_PASSWORD = 256;
const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
const MAX_PENDING_REQUESTS = 50;

export const STATUS = { PENDING: 'pending', APPROVED: 'approved', DISABLED: 'disabled' };

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const dk = await scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), dk.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, n, r, p, saltB64, hashB64] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hashB64, 'base64');
    const dk = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return dk.length === expected.length && crypto.timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

// A real hash of a throwaway value, so an unknown username takes as long to
// reject as a wrong password does.
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password || 'x', dummyHash);
}

export function passwordProblem(password, username) {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return `Use no more than ${MAX_PASSWORD} characters.`;
  if (username && pw.toLowerCase().includes(String(username).toLowerCase())) {
    return 'The password cannot contain the username.';
  }
  if (/^(.)\1+$/.test(pw)) return 'Choose a password that is not one repeated character.';
  return null;
}

const now = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export class Users {
  constructor(dataDir) {
    this.store = new JsonFile(path.join(dataDir, 'users.json'), { users: {} });
    if (!this.store.data || typeof this.store.data.users !== 'object') this.store.data = { users: {} };
    this.ready = this._normalise();
  }

  get map() { return this.store.data.users; }

  async _normalise() {
    let changed = false;
    for (const [key, u] of Object.entries(this.map)) {
      // Only the designated account may ever hold the admin role, even if the
      // file on disk was edited by hand.
      if (u.role === 'admin' && key !== ADMIN_USERNAME) { u.role = 'user'; changed = true; }
      if (!Array.isArray(u.approver_for)) { u.approver_for = []; changed = true; }
      const clean = u.approver_for.filter((c) => CATEGORY_IDS.includes(c));
      if (clean.length !== u.approver_for.length) { u.approver_for = clean; changed = true; }
      if (!Array.isArray(u.approved_by_only)) { u.approved_by_only = []; changed = true; }
      const people = u.approved_by_only.filter((n) => this.map[n] && n !== key && n !== ADMIN_USERNAME);
      if (people.length !== u.approved_by_only.length) { u.approved_by_only = people; changed = true; }
    }
    if (!this.map[ADMIN_USERNAME]) {
      this.map[ADMIN_USERNAME] = {
        username: ADMIN_USERNAME,
        hash: await hashPassword('admin'),
        role: 'admin',
        status: STATUS.APPROVED,
        approver_for: [],
        created: now(),
        must_change_password: true,
      };
      changed = true;
      console.log('[auth] Created the default administrator account (admin / admin). ' +
        'It must be changed at first sign-in.');
    }
    if (changed) this.store.save();
  }

  get(username) {
    return this.map[String(username || '').trim().toLowerCase()] || null;
  }

  view(u) {
    return {
      username: u.username,
      role: u.role,
      status: u.status,
      approver_for: u.approver_for || [],
      approved_by_only: (u.approved_by_only || []).map((n) => (this.map[n] ? this.map[n].username : n)),
      created: u.created,
      approved_at: u.approved_at || null,
      approved_by: u.approved_by || null,
      last_login: u.last_login || null,
      must_change_password: Boolean(u.must_change_password),
    };
  }

  list() {
    return Object.values(this.map)
      .map((u) => this.view(u))
      .sort((a, b) => (a.role === 'admin' ? -1 : b.role === 'admin' ? 1 : a.username.localeCompare(b.username)));
  }

  // An approver either looks after one or more action groups, or has been named
  // as one of the people who approve a particular user's requests.
  isApprover(u) {
    if (!u || u.status !== STATUS.APPROVED) return false;
    return (u.approver_for || []).length > 0 || this.designatedFor(u.username).length > 0;
  }

  // Users whose requests this person has been named to approve.
  designatedFor(username) {
    const me = String(username).toLowerCase();
    return Object.values(this.map)
      .filter((r) => (r.approved_by_only || []).includes(me))
      .map((r) => r.username);
  }

  // The named approvers for one requester (lower-case keys), or [] if none are set.
  namedApprovers(requester) {
    const r = this.get(requester);
    return r ? (r.approved_by_only || []) : [];
  }

  // Who may approve this requester's request in this group, excluding the admin.
  approversForRequest(requester, category) {
    const named = this.namedApprovers(requester);
    if (named.length) {
      return named.map((n) => this.map[n])
        .filter((u) => u && u.status === STATUS.APPROVED)
        .map((u) => u.username);
    }
    return this.approversFor(category).filter((n) => n.toLowerCase() !== String(requester).toLowerCase());
  }

  approversFor(category) {
    return Object.values(this.map)
      .filter((u) => u.status === STATUS.APPROVED && (u.approver_for || []).includes(category))
      .map((u) => u.username);
  }

  async register(username, password) {
    const name = String(username || '').trim();
    if (!USERNAME_RE.test(name)) {
      return { ok: false, message: 'Usernames use letters, numbers, dot, dash or underscore, 2 to 32 characters.' };
    }
    const problem = passwordProblem(password, name);
    if (problem) return { ok: false, message: problem };
    const key = name.toLowerCase();
    // The same wording for a taken name and for "admin", so the form cannot be
    // used to find out which accounts exist.
    if (key === ADMIN_USERNAME || this.map[key]) return { ok: false, message: 'That username is not available.' };
    const pendingCount = Object.values(this.map).filter((u) => u.status === STATUS.PENDING).length;
    if (pendingCount >= MAX_PENDING_REQUESTS) {
      return { ok: false, message: 'Too many requests are waiting for approval. Ask the administrator to review them.' };
    }
    const hash = await hashPassword(password);
    if (this.map[key]) return { ok: false, message: 'That username is not available.' };
    this.map[key] = {
      username: name,
      hash,
      role: 'user',
      status: STATUS.PENDING,
      approver_for: [],
      approved_by_only: [],
      created: now(),
    };
    this.store.save();
    return { ok: true, message: 'Request sent. The administrator needs to approve it before you can sign in.' };
  }

  async authenticate(username, password) {
    const u = this.get(username);
    if (!u) {
      await burnTime(password);
      return { user: null, message: 'Incorrect username or password.' };
    }
    if (!(await verifyPassword(password, u.hash))) return { user: null, message: 'Incorrect username or password.' };
    // Only reveal the account state once the password has proved who is asking.
    if (u.status === STATUS.PENDING) return { user: null, message: 'This account is waiting for administrator approval.' };
    if (u.status !== STATUS.APPROVED) return { user: null, message: 'This account has been disabled. Contact the administrator.' };
    u.last_login = now();
    this.store.save();
    return { user: u, message: '' };
  }

  async setPassword(username, password, { mustChange = false } = {}) {
    const u = this.get(username);
    if (!u) return { ok: false, message: 'No such account.' };
    const problem = passwordProblem(password, u.username);
    if (problem) return { ok: false, message: problem };
    if (await verifyPassword(password, u.hash)) return { ok: false, message: 'Choose a password different from the current one.' };
    u.hash = await hashPassword(password);
    if (mustChange) u.must_change_password = true;
    else delete u.must_change_password;
    u.password_changed = now();
    this.store.save();
    return { ok: true, message: 'Password changed.' };
  }

  // Admin operations. Each returns { ok, message }.
  approve(username, by) {
    const u = this.get(username);
    if (!u || u.status !== STATUS.PENDING) return { ok: false, message: 'That request no longer exists.' };
    u.status = STATUS.APPROVED;
    u.approved_at = now();
    u.approved_by = by;
    this.store.save();
    return { ok: true, message: `${u.username} can now sign in.` };
  }

  remove(username) {
    const u = this.get(username);
    if (!u) return { ok: false, message: 'No such account.' };
    if (u.role === 'admin') return { ok: false, message: 'The administrator account cannot be removed.' };
    const key = u.username.toLowerCase();
    delete this.map[key];
    for (const other of Object.values(this.map)) {
      if (Array.isArray(other.approved_by_only)) other.approved_by_only = other.approved_by_only.filter((n) => n !== key);
    }
    this.store.save();
    return { ok: true, message: `${u.username} was removed.` };
  }

  setDisabled(username, disabled) {
    const u = this.get(username);
    if (!u || u.status === STATUS.PENDING) return { ok: false, message: 'No such approved account.' };
    if (u.role === 'admin') return { ok: false, message: 'The administrator account cannot be disabled.' };
    u.status = disabled ? STATUS.DISABLED : STATUS.APPROVED;
    this.store.save();
    return { ok: true, message: disabled ? `${u.username} was disabled.` : `${u.username} was enabled.` };
  }

  setApproverFor(username, categories) {
    const u = this.get(username);
    if (!u || u.status === STATUS.PENDING) return { ok: false, message: 'Approve the account first.' };
    const list = Array.isArray(categories) ? categories : [];
    u.approver_for = CATEGORY_IDS.filter((c) => list.includes(c));
    this.store.save();
    return { ok: true, message: u.approver_for.length ? `${u.username} is an approver.` : `${u.username} is no longer an approver.` };
  }
}

// ---------------------------------------------------------------------------
// Named approvers for one user's requests
// ---------------------------------------------------------------------------

Users.prototype.setApprovedByOnly = function setApprovedByOnly(username, names) {
  const u = this.get(username);
  if (!u || u.status === STATUS.PENDING) return { ok: false, message: 'Approve the account first.' };
  if (u.role === 'admin') return { ok: false, message: 'The administrator\'s requests always go to the approver groups.' };
  const key = u.username.toLowerCase();
  const picked = [];
  for (const raw of Array.isArray(names) ? names : []) {
    const n = String(raw).trim().toLowerCase();
    if (!n || picked.includes(n)) continue;
    const a = this.map[n];
    if (!a) return { ok: false, message: `There is no account called ${raw}.` };
    if (n === key) return { ok: false, message: 'Nobody can approve their own requests.' };
    if (n === ADMIN_USERNAME) continue;                      // the administrator is always included
    if (a.status !== STATUS.APPROVED) return { ok: false, message: `${a.username} is not an active account.` };
    picked.push(n);
  }
  u.approved_by_only = picked;
  this.store.save();
  return {
    ok: true,
    message: picked.length
      ? `Only the administrator and ${picked.map((n) => this.map[n].username).join(', ')} can now approve ${u.username}'s requests.`
      : `${u.username}'s requests now go to the normal approver groups.`,
  };
};

// ---------------------------------------------------------------------------
// Sessions (memory only: restarting the container signs everyone out)
// ---------------------------------------------------------------------------

export class Sessions {
  constructor({ idleMinutes = 60, maxHours = 12 } = {}) {
    this.idleMs = idleMinutes * 60_000;
    this.maxMs = maxHours * 3_600_000;
    this.byToken = new Map();
    setInterval(() => this.prune(), 60_000).unref();
  }

  static digest(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
  }

  create(username) {
    const token = crypto.randomBytes(32).toString('base64url');
    const t = Date.now();
    this.byToken.set(Sessions.digest(token), { username: username.toLowerCase(), created: t, last: t });
    return token;
  }

  get(token) {
    if (!token) return null;
    const key = Sessions.digest(token);
    const s = this.byToken.get(key);
    if (!s) return null;
    const t = Date.now();
    if (t - s.last > this.idleMs || t - s.created > this.maxMs) {
      this.byToken.delete(key);
      return null;
    }
    s.last = t;
    return { ...s, key };
  }

  end(token) {
    if (token) this.byToken.delete(Sessions.digest(token));
  }

  endAllFor(username, exceptToken) {
    const keep = exceptToken ? Sessions.digest(exceptToken) : null;
    const name = String(username).toLowerCase();
    for (const [k, s] of this.byToken) {
      if (s.username === name && k !== keep) this.byToken.delete(k);
    }
  }

  prune() {
    const t = Date.now();
    for (const [k, s] of this.byToken) {
      if (t - s.last > this.idleMs || t - s.created > this.maxMs) this.byToken.delete(k);
    }
  }
}

// ---------------------------------------------------------------------------
// Sign-in throttling
// ---------------------------------------------------------------------------

export class Throttle {
  constructor({ limit, windowMinutes }) {
    this.limit = limit;
    this.windowMs = windowMinutes * 60_000;
    this.hits = new Map();
    setInterval(() => this.prune(), 5 * 60_000).unref();
  }

  _recent(key) {
    const cutoff = Date.now() - this.windowMs;
    const list = (this.hits.get(key) || []).filter((t) => t > cutoff);
    this.hits.set(key, list);
    return list;
  }

  blocked(key) { return this._recent(key).length >= this.limit; }
  record(key) { this._recent(key).push(Date.now()); }
  clear(key) { this.hits.delete(key); }

  prune() {
    for (const key of [...this.hits.keys()]) {
      if (!this._recent(key).length) this.hits.delete(key);
    }
  }
}

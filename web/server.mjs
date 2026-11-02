// Veeam Assistant portal.
//
// Browser -> Nginx (HTTPS) -> this server on 127.0.0.1:3000
//   -> Veeam MCP server child process over STDIO -> Veeam Intelligence on VBR
//
// Built on Node's standard library only. Run `node server.mjs reset-admin` to
// set a new administrator password from the console (see SETUP_GUIDE.md).

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { Users, Sessions, Throttle, ADMIN_USERNAME, MIN_PASSWORD, STATUS } from './lib/auth.mjs';
import { Assistant } from './lib/assistant.mjs';
import { Audit } from './lib/audit.mjs';
import { publicCategories, CATEGORY_IDS } from './lib/categories.mjs';
import { Backends } from './lib/backends.mjs';
import { Claude } from './lib/claude.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

const env = process.env;
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const int = (v, d) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : d);

const config = {
  version: VERSION,
  port: int(env.PORT, 3000),
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || path.join(HERE, 'data'),
  siteTitle: env.SITE_TITLE || 'Veeam Assistant',
  siteSubtitle: env.SITE_SUBTITLE || 'Veeam Intelligence',
  cookieSecure: bool(env.COOKIE_SECURE, true),
  publicOrigins: String(env.PUBLIC_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean),
  trustProxy: bool(env.TRUST_PROXY, true),
  adminCanApprove: bool(env.ADMIN_CAN_APPROVE, true),
  maxConcurrent: int(env.MAX_CONCURRENT_QUESTIONS, 4),
  maxWaitingApprovals: int(env.MAX_WAITING_APPROVALS, 20),
  maxQuestionChars: int(env.MAX_QUESTION_CHARS, 4000),
  turnTimeoutMs: int(env.CHAT_TURN_TIMEOUT_SEC, 3600) * 1000,
  toolApprovalSeconds: int(env.TOOL_APPROVAL_TIMEOUT_SEC, 1500),
  backendsFile: env.BACKENDS_FILE || '/etc/veeam-assistant/backends.json',
  logMcp: bool(env.LOG_MCP, false),
};

const COOKIE = config.cookieSecure ? '__Host-va_session' : 'va_session';

// ---------------------------------------------------------------------------
// Console command: reset the administrator password
// ---------------------------------------------------------------------------

if (process.argv[2] === 'reset-admin') {
  const users = new Users(config.dataDir);
  await users.ready;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  console.log('Set a new password for the "admin" website account.');
  console.log(`At least ${MIN_PASSWORD} characters. Typed characters are visible.`);
  const a = await ask('New password: ');
  const b = await ask('Repeat it:    ');
  rl.close();
  if (a !== b) { console.error('The passwords do not match. Nothing changed.'); process.exit(1); }
  const r = await users.setPassword(ADMIN_USERNAME, a);
  if (!r.ok) { console.error(r.message + ' Nothing changed.'); process.exit(1); }
  const admin = users.get(ADMIN_USERNAME);
  admin.status = STATUS.APPROVED;
  users.store.save();
  new Audit(config.dataDir).write('admin_password_reset_console', {});
  console.log('Done. Start the web container again and sign in as admin.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

fs.mkdirSync(config.dataDir, { recursive: true });
const audit = new Audit(config.dataDir);
const users = new Users(config.dataDir);
await users.ready;
const sessions = new Sessions({ idleMinutes: int(env.SESSION_IDLE_MINUTES, 60), maxHours: int(env.SESSION_MAX_HOURS, 12) });
const ipThrottle = new Throttle({ limit: 20, windowMinutes: 15 });
const userThrottle = new Throttle({ limit: 6, windowMinutes: 15 });
const registerThrottle = new Throttle({ limit: 5, windowMinutes: 60 });
// The MCP servers get this container's environment, minus the Claude API key
// and the website's own settings, which they have no business seeing.
const PRIVATE_ENV = /^(ANTHROPIC_|CLAUDE_)|^(COOKIE_SECURE|PUBLIC_ORIGIN|SESSION_IDLE_MINUTES|SESSION_MAX_HOURS)$/;
const mcpBaseEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !PRIVATE_ENV.test(k)));
const backends = new Backends({ file: config.backendsFile, baseEnv: mcpBaseEnv });
const claude = new Claude({ apiKey: env.ANTHROPIC_API_KEY || '', baseUrl: env.ANTHROPIC_BASE_URL || '' });
const assistant = new Assistant({ dataDir: config.dataDir, users, audit, config, backends, claude });
if (backends.list.some((b) => b.agent)) {
  console.log(claude.configured
    ? '[startup] Claude API key found; written questions are on for agent servers.'
    : '[startup] An agent server is configured but ANTHROPIC_API_KEY is not set; its written questions are off.');
}

if (backends.problem) console.warn(`[startup] ${backends.problem}`);
for (const b of backends.list) {
  for (const part of b.parts) {
    const label = b.parts.length > 1 ? `"${b.id}" part ${part.index + 1}` : `"${b.id}"`;
    const files = [part.command.startsWith('/') ? part.command : null, part.args[0] && part.args[0].startsWith('/') ? part.args[0] : null];
    for (const f of files) {
      if (f && !fs.existsSync(f)) console.warn(`[startup] ${label}: ${f} does not exist. That server will fail until it does.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Static files (read once at startup)
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC = path.join(HERE, 'public');
const files = new Map();
for (const name of fs.readdirSync(PUBLIC)) {
  const ext = path.extname(name);
  if (TYPES[ext]) files.set(name, { body: fs.readFileSync(path.join(PUBLIC, name)), type: TYPES[ext] });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function json(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}

function redirect(res, to) {
  send(res, 303, '', { Location: to, 'Cache-Control': 'no-store' });
}

function page(res, name) {
  const f = files.get(name);
  send(res, 200, f.body, { 'Content-Type': f.type, 'Cache-Control': 'no-store' });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

function clientIp(req) {
  if (config.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}

// Browsers always send Origin on a cross-site POST. Accept a write only when it
// comes from this site: either a configured PUBLIC_ORIGIN, or the same host the
// browser addressed (Nginx passes it through unchanged as Host).
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const o = origin.replace(/\/+$/, '');
  if (config.publicOrigins.includes(o)) return true;
  if (config.publicOrigins.length) return false;
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return new URL(o).host.toLowerCase() === String(host || '').toLowerCase();
  } catch {
    return false;
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function currentUser(req) {
  const token = cookies(req)[COOKIE];
  const s = sessions.get(token);
  if (!s) return { token: null, user: null };
  const user = users.get(s.username);
  if (!user || user.status !== STATUS.APPROVED) {
    sessions.end(token);
    return { token: null, user: null };
  }
  return { token, user };
}

function sessionInfo(user) {
  const base = { site_title: config.siteTitle, site_subtitle: config.siteSubtitle, version: VERSION, min_password: MIN_PASSWORD };
  if (!user) return { ...base, authenticated: false };
  const approver = users.isApprover(user) || (user.role === 'admin' && config.adminCanApprove);
  return {
    ...base,
    authenticated: true,
    username: user.username,
    role: user.role,
    approver,
    approver_for: user.approver_for || [],
    approves_for_people: users.designatedFor(user.username),
    must_change_password: Boolean(user.must_change_password),
    waiting_approvals: approver ? assistant.waitingCount(user) : 0,
    pending_accounts: user.role === 'admin' ? users.list().filter((u) => u.status === STATUS.PENDING).length : 0,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handle(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const method = req.method;

  if (p === '/healthz') return json(res, 200, { ok: true, version: VERSION });

  if (method === 'GET' && p.startsWith('/static/')) {
    const f = files.get(p.slice(8));
    if (!f || p.slice(8).includes('/')) return send(res, 404, 'Not found');
    return send(res, 200, f.body, { 'Content-Type': f.type, 'Cache-Control': 'no-cache' });
  }
  if (method === 'GET' && p === '/favicon.ico') return send(res, 204, '');

  const { token, user } = currentUser(req);

  // ---- pages ----
  if (method === 'GET' && !p.startsWith('/api/')) {
    if (p === '/login') {
      if (user && !user.must_change_password) return redirect(res, '/');
      return page(res, 'login.html');
    }
    if (!user || user.must_change_password) return redirect(res, '/login');
    if (p === '/' || p === '/index.html') return page(res, 'index.html');
    if (p === '/approvals') {
      return sessionInfo(user).approver ? page(res, 'approvals.html') : redirect(res, '/');
    }
    if (p === '/admin') return user.role === 'admin' ? page(res, 'admin.html') : redirect(res, '/');
    return send(res, 404, 'Not found');
  }

  if (!p.startsWith('/api/')) return send(res, 404, 'Not found');

  // Every state-changing API call must be JSON from this site.
  let body = {};
  if (method !== 'GET') {
    if (method !== 'POST') return json(res, 405, { message: 'Method not allowed.' });
    if (!originAllowed(req)) {
      return json(res, 403, { message: 'This request did not come from the assistant site. Reload the page and try again.' });
    }
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      return json(res, 415, { message: 'Send JSON.' });
    }
    try { body = await readBody(req); } catch (err) { return json(res, err.status || 400, { message: err.message }); }
  }

  const ip = clientIp(req);

  // ---- public API ----
  if (method === 'GET' && p === '/api/session') return json(res, 200, sessionInfo(user));
  if (method === 'GET' && p === '/api/categories') return json(res, 200, { categories: publicCategories() });

  if (method === 'POST' && p === '/api/login') {
    const name = String(body.username || '').trim().toLowerCase();
    if (ipThrottle.blocked(`ip:${ip}`) || userThrottle.blocked(`u:${name}`)) {
      audit.write('login_throttled', { user: name, ip });
      return json(res, 429, { message: 'Too many failed attempts. Wait 15 minutes and try again.' });
    }
    const r = await users.authenticate(name, String(body.password || ''));
    if (!r.user) {
      ipThrottle.record(`ip:${ip}`);
      userThrottle.record(`u:${name}`);
      audit.write('login_failed', { user: name, ip });
      return json(res, 401, { message: r.message });
    }
    userThrottle.clear(`u:${name}`);
    if (token) sessions.end(token);
    const t = sessions.create(r.user.username);
    audit.write('login', { user: r.user.username, ip });
    return json(res, 200, { ok: true, must_change_password: Boolean(r.user.must_change_password) },
      { 'Set-Cookie': sessionCookie(t, int(env.SESSION_MAX_HOURS, 12) * 3600) });
  }

  if (method === 'POST' && p === '/api/register') {
    if (registerThrottle.blocked(`ip:${ip}`)) {
      return json(res, 429, { message: 'Too many requests from this computer. Try again later.' });
    }
    registerThrottle.record(`ip:${ip}`);
    const r = await users.register(body.username, body.password);
    if (r.ok) audit.write('account_requested', { user: String(body.username).trim(), ip });
    return json(res, r.ok ? 200 : 400, r);
  }

  if (method === 'POST' && p === '/api/logout') {
    if (token) sessions.end(token);
    if (user) audit.write('logout', { user: user.username });
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  // ---- signed in ----
  if (!user) return json(res, 401, { message: 'Sign in to continue.', code: 'signed_out' });

  if (method === 'POST' && p === '/api/change-password') {
    const current = String(body.current_password || '');
    const next = String(body.new_password || '');
    const check = await users.authenticate(user.username, current);
    if (!check.user) return json(res, 400, { message: 'The current password is not correct.' });
    const r = await users.setPassword(user.username, next);
    if (r.ok) {
      sessions.endAllFor(user.username, token);   // other sessions opened with the old password stop working
      audit.write('password_changed', { user: user.username });
    }
    return json(res, r.ok ? 200 : 400, r);
  }

  if (user.must_change_password) {
    return json(res, 403, { message: 'Change the default password first.', code: 'password_change_required' });
  }

  if (method === 'GET' && p === '/api/backends') {
    return json(res, 200, {
      backends: backends.list.map((b) => backends.view(b)),
      problem: backends.problem,
      default: backends.default ? backends.default.id : null,
    });
  }
  if (method === 'GET' && p === '/api/tools') {
    const r = await assistant.toolsOf(url.searchParams.get('backend'));
    return json(res, r.ok ? 200 : r.status, r);
  }
  if (method === 'POST' && p === '/api/run-tool') {
    const r = await assistant.runTool(user, body.backend, body.tool, body.args || {});
    return json(res, r.ok ? 200 : r.status, r.ok ? { ok: true, turn: r.turn } : r);
  }
  if (method === 'GET' && p === '/api/conversation') {
    return json(res, 200, { turns: assistant.turnsFor(user.username, { showDetail: user.role === 'admin' }) });
  }
  if (method === 'POST' && p === '/api/ask') {
    const r = assistant.ask(user, body.question, body.backend);
    return json(res, r.ok ? 200 : r.status, r.ok ? { ok: true, turn: r.turn } : { message: r.message });
  }
  if (method === 'POST' && p === '/api/conversation/clear') {
    assistant.clearHistory(user.username);
    return json(res, 200, { ok: true });
  }
  if (method === 'POST' && p === '/api/approvals/cancel') {
    const r = await assistant.cancel(user, String(body.id || ''));
    return json(res, r.ok ? 200 : r.status, r);
  }

  const approver = sessionInfo(user).approver;
  if (method === 'GET' && p === '/api/approvals') {
    if (!approver) return json(res, 403, { message: 'Only approvers can see this.' });
    return json(res, 200, assistant.approvalsFor(user));
  }
  if (method === 'POST' && p === '/api/approvals/decide') {
    if (!approver) return json(res, 403, { message: 'Only approvers can decide.' });
    const r = await assistant.decide(user, String(body.id || ''), body.approve === true, body.note);
    return json(res, r.ok ? 200 : r.status, r);
  }

  // ---- administrator ----
  if (p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') return json(res, 403, { message: 'Administrator only.' });

    if (method === 'GET' && p === '/api/admin/users') {
      const coverage = {};
      for (const c of CATEGORY_IDS) coverage[c] = users.approversFor(c);
      return json(res, 200, { users: users.list(), categories: publicCategories(), coverage, admin_can_approve: config.adminCanApprove });
    }

    if (method === 'POST' && p === '/api/admin/user') {
      const target = String(body.username || '');
      const op = String(body.op || '');
      let r;
      if (op === 'approve') r = users.approve(target, user.username);
      else if (op === 'reject' || op === 'remove') {
        r = users.remove(target);
        if (r.ok) { sessions.endAllFor(target); assistant.forgetUser(target); }
      } else if (op === 'disable' || op === 'enable') {
        r = users.setDisabled(target, op === 'disable');
        if (r.ok && op === 'disable') sessions.endAllFor(target);
      } else if (op === 'approver_for') {
        r = users.setApproverFor(target, body.categories);
      } else if (op === 'approved_by_only') {
        r = users.setApprovedByOnly(target, body.approvers);
      } else if (op === 'reset_password') {
        const t = users.get(target);
        if (!t) r = { ok: false, message: 'No such account.' };
        else if (t.role === 'admin') r = { ok: false, message: 'Use Change password for your own account.' };
        else {
          r = await users.setPassword(target, String(body.password || ''), { mustChange: true });
          if (r.ok) { sessions.endAllFor(target); r.message = `Temporary password set. ${t.username} must change it at next sign-in.`; }
        }
      } else {
        r = { ok: false, message: 'Unknown operation.' };
      }
      if (r.ok) {
        audit.write(`admin_${op}`, {
          by: user.username, user: target,
          categories: op === 'approver_for' ? body.categories : undefined,
          approvers: op === 'approved_by_only' ? body.approvers : undefined,
        });
      }
      return json(res, r.ok ? 200 : 400, r);
    }

    if (method === 'GET' && p === '/api/admin/audit') return json(res, 200, { entries: audit.tail(200) });

    if (method === 'POST' && p === '/api/admin/test-connection') {
      audit.write('connection_test', { by: user.username, backend: body.backend || 'all' });
      if (body.backend) return json(res, 200, await assistant.testConnection(body.backend));
      const results = [];
      for (const b of backends.list) results.push(await assistant.testConnection(b.id));
      return json(res, 200, { results, problem: backends.problem });
    }

    if (method === 'POST' && p === '/api/admin/reload-backends') {
      backends.load();
      audit.write('backends_reloaded', { by: user.username, count: backends.list.length });
      return json(res, 200, { ok: true, message: `${backends.list.length} MCP server(s) loaded.`, problem: backends.problem });
    }
  }

  return json(res, 404, { message: 'Not found.' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('[http]', err);
    if (!res.headersSent) json(res, 500, { message: 'The server hit an error. Check the container log.' });
    else res.end();
  });
});
server.requestTimeout = 120_000;
server.headersTimeout = 30_000;

server.listen(config.port, config.host, () => {
  console.log(`[startup] ${config.siteTitle} portal ${VERSION} listening on ${config.host}:${config.port}`);
  console.log(`[startup] Data directory: ${config.dataDir}. Secure cookies: ${config.cookieSecure}.`);
});

function stop() {
  console.log('[shutdown] Stopping.');
  assistant.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

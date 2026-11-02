// vbr-extra 2.0: an MCP server (STDIO) for the Veeam Assistant portal that
// offers the whole VBR REST API.
//
// Every operation in Veeam's own OpenAPI definition (swagger.json) becomes an
// operation in the portal: its address, parameters and request body are read
// from the file, so a new Veeam revision only needs a new file. Alongside them
// are four hand-written operations that do more than one call:
//   find_jobs, find_backups   readable tables of IDs
//   delete_backup             deletes and waits for VBR to finish
//   delete_job                optionally deletes the job's backups first
//
// Settings (environment):
//   VBR_URL                      https://vbr01.corp.local:9419
//   VBR_USERNAME, VBR_PASSWORD   the VBR account (Veeam Backup Administrator to delete)
//   VBR_ACCEPT_SELF_SIGNED_CERT  true to skip certificate checks
//   VBR_OPENAPI_FILE             path to swagger.json (default: next to this file)
//   VBR_API_VERSION              x-api-version to send (default: taken from the file)
//   VBR_WAIT_SEC                 how long to follow a VBR session (default 900)
//
// No dependencies: Node.js standard library only.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const VERSION = '2.0.1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPEC_FILE = process.env.VBR_OPENAPI_FILE || path.join(HERE, 'swagger.json');
const BASE = String(process.env.VBR_URL || '').replace(/\/+$/, '');
const USER = process.env.VBR_USERNAME || '';
const PASS = process.env.VBR_PASSWORD || '';
const INSECURE = /^(1|true|yes|on)$/i.test(process.env.VBR_ACCEPT_SELF_SIGNED_CERT || '');
let API_VERSION = process.env.VBR_API_VERSION || '';   // filled in from the OpenAPI file if not set
const WAIT_SEC = Number(process.env.VBR_WAIT_SEC) > 0 ? Number(process.env.VBR_WAIT_SEC) : 900;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const log = (...a) => process.stderr.write(`[vbr-extra] ${a.join(' ')}\n`);

// ---------------------------------------------------------------------------
// HTTP to VBR
// ---------------------------------------------------------------------------

function request(method, path, { query, form, json, token } = {}) {
  return new Promise((resolve, reject) => {
    if (!BASE) return reject(new Error('VBR_URL is not set in vbr-extra.env.'));
    let url;
    try { url = new URL(BASE + path); } catch { return reject(new Error(`VBR_URL is not a valid address: ${BASE}`)); }
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }
    const headers = { 'x-api-version': API_VERSION, Accept: 'application/json' };
    let body = null;
    if (form) {
      body = new URLSearchParams(form).toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    } else if (json !== undefined) {
      body = JSON.stringify(json);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    const lib = url.protocol === 'http:' ? http : https;
    const req = lib.request(url, { method, headers, rejectUnauthorized: !INSECURE, timeout: 120_000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`VBR did not answer within 120 seconds (${method} ${path}).`)));
    req.on('error', (err) => reject(new Error(`Could not reach VBR at ${BASE}: ${err.code || err.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

function describe(b) {
  if (b === null || b === undefined) return 'no details';
  if (typeof b === 'string') return b.slice(0, 600);
  const parts = [b.errorCode, b.message, b.error_description, b.error].filter(Boolean);
  return parts.length ? parts.join(': ') : JSON.stringify(b).slice(0, 600);
}

let token = null;
let tokenUntil = 0;

async function signIn() {
  if (token && Date.now() < tokenUntil - 60_000) return token;
  if (!USER || !PASS) throw new Error('VBR_USERNAME and VBR_PASSWORD must be set in vbr-extra.env.');
  const r = await request('POST', '/api/oauth2/token', {
    form: { grant_type: 'password', username: USER, password: PASS },
  });
  if (r.status !== 200 || !r.body || !r.body.access_token) {
    const hint = r.status === 400 && /version/i.test(describe(r.body))
      ? ` This VBR server does not accept API revision ${API_VERSION}. Download the OpenAPI file for your VBR build from Veeam's REST API reference (choose the matching revision), or set VBR_API_VERSION in vbr-extra.env.`
      : '';
    throw new Error(`Signing in to VBR failed (HTTP ${r.status}): ${describe(r.body)}.${hint}`);
  }
  token = r.body.access_token;
  tokenUntil = Date.now() + (Number(r.body.expires_in) || 900) * 1000;
  return token;
}

async function api(method, path, opts = {}) {
  let r = await request(method, path, { ...opts, token: await signIn() });
  if (r.status === 401) {                          // token expired early: sign in once more
    token = null;
    r = await request(method, path, { ...opts, token: await signIn() });
  }
  return r;
}

function ok(r, what) {
  if (r.status >= 200 && r.status < 300) return r.body;
  if (r.status === 403) throw new Error(`${what}: VBR refused (HTTP 403). The account needs the Veeam Backup Administrator role. ${describe(r.body)}`);
  if (r.status === 404) throw new Error(`${what}: not found (HTTP 404). Check the ID.`);
  if (r.status === 400 && /version/i.test(describe(r.body))) {
    throw new Error(`${what} failed (HTTP 400): ${describe(r.body)}. The VBR server may not support API revision ${API_VERSION}: download the OpenAPI file for your VBR build, or set VBR_API_VERSION in vbr-extra.env.`);
  }
  throw new Error(`${what} failed (HTTP ${r.status}): ${describe(r.body)}`);
}

function needId(value, label) {
  const v = String(value || '').trim();
  if (!UUID.test(v)) throw new Error(`${label} must be a VBR ID such as 3f1c2a9e-1b2c-4d5e-8f90-1a2b3c4d5e6f.`);
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Follow a session VBR created for a deletion until it stops.
async function waitFor(session, what) {
  if (!session || !session.id) return { state: 'Unknown', result: null };
  const until = Date.now() + WAIT_SEC * 1000;
  let s = session;
  while (s.state !== 'Stopped' && Date.now() < until) {
    await sleep(5000);
    const r = await api('GET', `/api/v1/sessions/${s.id}`);
    if (r.status === 200 && r.body) s = r.body;
  }
  if (s.state !== 'Stopped') {
    return { state: s.state, result: null, note: `${what} is still running after ${WAIT_SEC} seconds. Check session ${s.id} in the VBR console.` };
  }
  return { state: s.state, result: s.result || null };
}

const cell = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\n/g, ' ');
const when = (v) => (v ? String(v).replace('T', ' ').slice(0, 16) : '');


// ---------------------------------------------------------------------------
// Built-in operations (more than one call each)
// ---------------------------------------------------------------------------

const BUILTIN = [
  {
    name: 'find_jobs',
    title: 'Find jobs',
    description: 'List jobs with their IDs, to pick one to delete. Optionally filter by name.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', title: 'Name contains', description: 'Part of the job name. Leave empty to list all jobs.' } },
    },
    async run(a) {
      const f = String(a.name || '').trim();
      const r = await api('GET', '/api/v1/jobs', { query: { limit: 500, nameFilter: f ? `*${f}*` : '' } });
      const jobs = (ok(r, 'Listing jobs').data || []).map((j) => ({ id: j.id, name: j.name, type: j.type, disabled: Boolean(j.isDisabled) }));
      const rows = jobs.map((j) => `| ${cell(j.name)} | ${cell(j.type)} | ${j.disabled ? 'Disabled' : 'Enabled'} | \`${j.id}\` |`);
      return {
        message: jobs.length
          ? `Found ${jobs.length} job(s). Copy the ID of the one you want.\n\n| Name | Type | State | ID |\n|---|---|---|---|\n${rows.join('\n')}`
          : 'No jobs match.',
        jobs,
      };
    },
  },
  {
    name: 'find_backups',
    title: 'Find backups',
    description: 'List backups with their IDs, to pick one to delete. Filter by name, or by the ID of the job that made them.',
    annotations: { readOnlyHint: true, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', title: 'Name contains', description: 'Part of the backup name, usually the job name. Leave empty to list all.' },
        job_id: { type: 'string', title: 'Job ID', description: 'Only backups made by this job.' },
      },
    },
    async run(a) {
      const f = String(a.name || '').trim();
      const job = a.job_id ? needId(a.job_id, 'Job ID') : '';
      const r = await api('GET', '/api/v1/backups', { query: { limit: 500, nameFilter: f ? `*${f}*` : '', jobIdFilter: job } });
      const backups = (ok(r, 'Listing backups').data || []).map((b) => ({
        id: b.id, name: b.name, job_id: b.jobId, created: b.creationTime, platform: b.platformName, repository_id: b.repositoryId,
      }));
      const rows = backups.map((b) => `| ${cell(b.name)} | ${cell(b.platform)} | ${when(b.created)} | \`${b.id}\` |`);
      return {
        message: backups.length
          ? `Found ${backups.length} backup(s). Copy the ID of the one you want.\n\n| Name | Platform | Created | ID |\n|---|---|---|---|\n${rows.join('\n')}`
          : 'No backups match.',
        backups,
      };
    },
  },
  {
    name: 'delete_backup',
    title: 'Delete backup from disk',
    description: 'Permanently delete a backup: its files are removed from the repository and its record from VBR. Weekly, monthly and yearly (GFS) fulls are kept unless you tick Include GFS.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      required: ['backup_id'],
      properties: {
        backup_id: { type: 'string', title: 'Backup ID', description: 'From Find backups.' },
        include_gfs: { type: 'boolean', title: 'Include GFS backups', description: 'Also delete weekly, monthly and yearly full backups.' },
        keep_files: { type: 'boolean', title: 'Remove from VBR only, keep the files', description: 'Removes only the record from VBR and leaves the backup files in the repository.' },
      },
    },
    async run(a) {
      const id = needId(a.backup_id, 'Backup ID');
      const b = ok(await api('GET', `/api/v1/backups/${id}`), 'Looking up the backup');
      const how = a.keep_files ? 'removed from VBR (files kept)' : 'deleted from disk';
      const r = await api('DELETE', `/api/v1/backups/${id}`, {
        query: { includeGFS: a.include_gfs ? 'true' : 'false', fromDB: a.keep_files ? 'true' : 'false' },
      });
      const session = ok(r, `Deleting backup ${b.name}`);
      const done = await waitFor(session, `Deleting backup ${b.name}`);
      const res = done.result ? done.result.result : '';
      if (done.note) return { message: done.note, backup: b.name, session_id: session && session.id };
      if (res === 'Failed') throw new Error(`VBR could not delete backup ${b.name}: ${done.result.message || 'no reason given'}`);
      return {
        message: `Backup **${b.name}** was ${how}${a.include_gfs ? ', including GFS backups' : ''}.${res === 'Warning' ? ` VBR reported a warning: ${done.result.message}` : ''}`,
        backup: b.name, backup_id: id, result: res || 'Success', session_id: session && session.id,
      };
    },
  },
  {
    name: 'delete_job',
    title: 'Delete job',
    description: 'Permanently delete a job. Its backups are kept (shown in VBR as orphaned) unless you tick Also delete its backups, which deletes them from disk first and only removes the job if that succeeds.',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      required: ['job_id'],
      properties: {
        job_id: { type: 'string', title: 'Job ID', description: 'From Find jobs.' },
        delete_backups: { type: 'boolean', title: 'Also delete its backups from disk' },
        include_gfs: { type: 'boolean', title: 'Include GFS backups', description: 'Only used with Also delete its backups.' },
      },
    },
    async run(a) {
      const id = needId(a.job_id, 'Job ID');
      const job = ok(await api('GET', `/api/v1/jobs/${id}`), 'Looking up the job');
      const lines = [];

      if (a.delete_backups) {
        const list = ok(await api('GET', '/api/v1/backups', { query: { jobIdFilter: id, limit: 500 } }), 'Listing the job\u2019s backups');
        const backups = list.data || [];
        if (!backups.length) lines.push('The job had no backups to delete.');
        for (const b of backups) {
          const s = ok(await api('DELETE', `/api/v1/backups/${b.id}`, {
            query: { includeGFS: a.include_gfs ? 'true' : 'false', fromDB: 'false' },
          }), `Deleting backup ${b.name}`);
          const done = await waitFor(s, `Deleting backup ${b.name}`);
          const already = lines.length ? ` Already deleted before this: ${lines.map((l) => l.replace(/\*\*/g, '').replace(' deleted from disk.', '')).join(', ')}.` : '';
          if (done.note) throw new Error(`${done.note} The job was not deleted.${already}`);
          if (done.result && done.result.result === 'Failed') {
            throw new Error(`VBR could not delete backup ${b.name} (${done.result.message || 'no reason given'}). The job was not deleted.${already}`);
          }
          lines.push(`Backup **${b.name}** deleted from disk.`);
        }
      }

      ok(await api('DELETE', `/api/v1/jobs/${id}`), `Deleting job ${job.name}`);
      lines.push(`Job **${job.name}** deleted.`);
      if (!a.delete_backups) lines.push('Its backups were kept and now show in VBR as orphaned.');
      return { message: lines.join('\n\n'), job: job.name, job_id: id, backups_deleted: Boolean(a.delete_backups) };
    },
  },
];

// ---------------------------------------------------------------------------
// The whole REST API, generated from Veeam's OpenAPI definition
// ---------------------------------------------------------------------------

const SKIP_IDS = new Set(['CreateToken', 'Logout']);           // the server signs in by itself
const DESTRUCTIVE_WORDS = /\b(delete|remove|erase|revoke|uninstall|reset|failover|failback|switch ?over|switchover|detach|reboot|undo|stop|disable|unmount|dismount|unpublish|commit)\b/i;
const READ_POST = /^(get|browse|view|validate|check|compare|search|verify)\b/i;
const MAX_DESC = 900;

let SPEC = null;
const OPS = new Map();       // tool name -> operation
const SKIPPED = [];          // { id, method, path, why }

function snake(id) {
  return String(id).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
}

function refName(ref) { return String(ref || '').split('/').pop(); }

function resolve(schema, depth = 0) {
  if (!schema || depth > 8) return schema || {};
  if (schema.$ref) {
    const name = refName(schema.$ref);
    const target = SPEC.components && SPEC.components.schemas && SPEC.components.schemas[name];
    return target ? { ...resolve(target, depth + 1), __name: name } : { __name: name };
  }
  if (Array.isArray(schema.allOf)) {
    const merged = { type: 'object', properties: {}, required: [] };
    for (const part of schema.allOf) {
      const r = resolve(part, depth + 1);
      Object.assign(merged.properties, r.properties || {});
      merged.required.push(...(r.required || []));
      if (r.description && !merged.description) merged.description = r.description;
      if (r.discriminator) merged.discriminator = r.discriminator;
    }
    return merged;
  }
  return schema;
}

function plain(text) {
  return String(text || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+\n/g, '\n').trim();
}

function typeLabel(s) {
  const r = resolve(s);
  if (r.__name && (r.properties || r.oneOf || r.anyOf)) return r.__name;
  if (r.type === 'array') return `list of ${typeLabel(r.items || {})}`;
  if (Array.isArray(r.enum)) return `one of ${r.enum.slice(0, 8).join(' | ')}${r.enum.length > 8 ? ' | …' : ''}`;
  return r.format ? `${r.type || 'value'} (${r.format})` : (r.type || r.__name || 'value');
}

// The fields of an object, and, one level down, the fields of any nested object
// or list item, so a request such as a restore (with its "target") can be filled
// in without guessing what is inside.
function fieldList(schema, depth) {
  const r = resolve(schema);
  const props = Object.entries(r.properties || {});
  const req = new Set(r.required || []);
  const limit = depth === 0 ? 18 : 10;
  const parts = props.slice(0, limit).map(([k, v]) => {
    let text = `${k}${req.has(k) ? ' (required)' : ''}: ${typeLabel(v)}`;
    if (depth < 1) {
      let inner = resolve(v);
      if (inner.type === 'array') inner = resolve(inner.items || {});
      if (inner.properties && Object.keys(inner.properties).length) text += ` {${fieldList(inner, depth + 1)}}`;
    }
    return text;
  });
  if (props.length > limit) parts.push(`and ${props.length - limit} more`);
  return parts.join('; ');
}

// A short, readable outline of what a request body must contain.
function bodyOutline(schema) {
  const r = resolve(schema);
  const lines = [];
  const variants = r.oneOf || r.anyOf;
  if (Array.isArray(variants)) {
    const names = variants.map((v) => refName(v.$ref) || typeLabel(v));
    lines.push(`One of these shapes: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}.`);
    if (r.discriminator && r.discriminator.propertyName) lines.push(`The "${r.discriminator.propertyName}" field says which one.`);
    return lines.join(' ');
  }
  if (r.type === 'array') return `A JSON list of ${typeLabel(r.items || {})}.`;
  if (!Object.keys(r.properties || {}).length) return '';
  const fields = fieldList(r, 0);
  const kind = r.discriminator && r.discriminator.propertyName ? `"${r.discriminator.propertyName}" decides the kind; ` : '';
  return `JSON object (${r.__name || 'body'}) with ${kind}${fields}.`;
}

function paramSchema(p) {
  const s = resolve(p.schema || {});
  const out = {};
  const desc = plain(p.description || '');
  let extra = '';
  if (s.type === 'array') {
    const it = resolve(s.items || {});
    out.type = 'array';
    out.items = { type: it.type || 'string' };
    if (Array.isArray(it.enum)) extra = ` A JSON list, for example ["${it.enum[0]}"]. Values: ${it.enum.slice(0, 15).join(', ')}${it.enum.length > 15 ? ', …' : ''}.`;
    else extra = ' A JSON list, for example ["value"].';
  } else if (['integer', 'number', 'boolean'].includes(s.type)) {
    out.type = s.type;
  } else {
    out.type = 'string';
  }
  if (Array.isArray(s.enum)) out.enum = s.enum.map(String);
  if (s.default !== undefined && s.default !== null && out.type !== 'array') out.default = s.default;
  const fmt = s.format === 'date-time' ? ' Date and time, for example 2026-10-01T00:00:00Z.' : '';
  out.description = (desc + fmt + extra).trim().slice(0, 400) || undefined;
  return out;
}

function isJson(ct) { return /json/i.test(ct); }

function looksLikeSession(op) {
  for (const [code, resp] of Object.entries(op.responses || {})) {
    if (!/^2/.test(code)) continue;
    const c = resp.content || {};
    for (const [ct, media] of Object.entries(c)) {
      if (!isJson(ct)) continue;
      const r = resolve(media.schema || {});
      if (/Session(Model)?$/.test(r.__name || '') || (r.properties && r.properties.sessionType)) return true;
    }
  }
  return false;
}

function loadSpec() {
  let raw;
  try {
    raw = fs.readFileSync(SPEC_FILE, 'utf8');
  } catch (err) {
    log(`no OpenAPI file at ${SPEC_FILE} (${err.code || err.message}); only the four built-in operations are offered.`);
    return;
  }
  try {
    SPEC = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (err) {
    log(`${SPEC_FILE} is not valid JSON (${err.message}); only the four built-in operations are offered.`);
    return;
  }
  if (!API_VERSION) {
    const v = String((SPEC.info && SPEC.info.version) || '');
    API_VERSION = /^\d+\.\d+-rev\d+$/.test(v) ? v : '1.3-rev1';
  }

  const builtIn = new Set(['find_jobs', 'find_backups', 'delete_backup', 'delete_job']);
  for (const [p, item] of Object.entries(SPEC.paths || {})) {
    const shared = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item[method];
      if (!op) continue;
      const id = op.operationId || `${method}_${p}`;
      const M = method.toUpperCase();
      if (SKIP_IDS.has(id) || p.startsWith('/api/oauth2')) { SKIPPED.push({ id, method: M, path: p, why: 'sign-in is handled automatically' }); continue; }

      // Request body: JSON only.
      let bodySchema = null;
      let bodyRequired = false;
      if (op.requestBody) {
        const rb = op.requestBody.$ref ? resolve(op.requestBody) : op.requestBody;
        const content = rb.content || {};
        const jsonType = Object.keys(content).find(isJson);
        if (!jsonType && Object.keys(content).length) {
          SKIPPED.push({ id, method: M, path: p, why: `needs a file upload (${Object.keys(content).join(', ')})` });
          continue;
        }
        if (jsonType) { bodySchema = content[jsonType].schema || {}; bodyRequired = Boolean(rb.required); }
      }
      // Response: skip pure file downloads.
      const okResponses = Object.entries(op.responses || {}).filter(([c]) => /^2/.test(c));
      const types = okResponses.flatMap(([, r]) => Object.keys((r && r.content) || {}));
      if (types.length && !types.some(isJson)) {
        SKIPPED.push({ id, method: M, path: p, why: `returns a file (${[...new Set(types)].join(', ')})` });
        continue;
      }

      const params = [...shared, ...(op.parameters || [])].map((x) => (x.$ref ? resolve(x) : x))
        .filter((x) => x && (x.in === 'path' || x.in === 'query'));
      const properties = {};
      const required = [];
      for (const prm of params) {
        properties[prm.name] = paramSchema(prm);
        if (prm.in === 'path' || prm.required) required.push(prm.name);
      }
      let bodyField = null;
      if (bodySchema) {
        bodyField = properties.body ? 'request_body' : 'body';
        const r = resolve(bodySchema);
        properties[bodyField] = {
          type: r.type === 'array' ? 'array' : 'object',
          title: 'Request body (JSON)',
          description: bodyOutline(bodySchema).slice(0, 2400) || 'JSON request body.',
        };
        if (bodyRequired) required.push(bodyField);
      }
      const session = M !== 'GET' && looksLikeSession(op);
      if (session) {
        properties.return_immediately = {
          type: 'boolean', title: 'Return immediately',
          description: 'Leave unticked to wait for VBR to finish and report the result.',
        };
      }

      const summary = plain(op.summary || id);
      const area = (op.tags && op.tags[0]) || 'Other';
      const readOnly = M === 'GET' || (M === 'POST' && READ_POST.test(summary) && !/\b(start|create|add|set|change)\b/i.test(summary));
      const destructive = !readOnly && (M === 'DELETE' || DESTRUCTIVE_WORDS.test(summary));
      let name = `rest_${snake(id)}`.slice(0, 64);
      if (builtIn.has(name) || OPS.has(name)) name = `${name.slice(0, 58)}_${OPS.size}`;
      const description = [
        plain(op.description || '').slice(0, MAX_DESC),
        `${M} ${p}`,
        bodyField ? `Body: ${properties[bodyField].description}` : '',
      ].filter(Boolean).join('\n\n');

      OPS.set(name, {
        name, method: M, path: p, area, summary, readOnly, destructive, session, bodyField,
        params: params.map((x) => ({ name: x.name, in: x.in })),
        tool: {
          name,
          title: `${area}: ${summary}`,
          description,
          annotations: { title: `${area}: ${summary}`, readOnlyHint: readOnly, destructiveHint: destructive },
          inputSchema: { type: 'object', properties, required },
        },
      });
    }
  }
  log(`loaded ${OPS.size} REST operations from ${path.basename(SPEC_FILE)} (${(SPEC.info && SPEC.info.version) || 'unknown version'}); ${SKIPPED.length} skipped; sending x-api-version ${API_VERSION}`);
}

// Turn a VBR answer into something readable in the chat.
const PREFERRED = ['name', 'id', 'type', 'platformName', 'state', 'status', 'result', 'lastResult', 'isDisabled', 'creationTime', 'description'];
function scalar(v) { return v === null || ['string', 'number', 'boolean'].includes(typeof v); }
function summarise(body, op) {
  if (body === null || body === undefined || body === '') return `Done (${op.method} ${op.path}).`;
  if (typeof body !== 'object') return String(body).slice(0, 4000);
  const list = Array.isArray(body) ? body : (Array.isArray(body.data) ? body.data : null);
  if (list) {
    const total = body.pagination && Number.isFinite(body.pagination.total) ? body.pagination.total : list.length;
    if (!list.length) return 'No items.';
    const keys = PREFERRED.filter((k) => list.some((x) => x && scalar(x[k]))).slice(0, 6);
    const cols = keys.length ? keys : Object.keys(list[0] || {}).filter((k) => scalar(list[0][k])).slice(0, 6);
    if (!cols.length) return '```json\n' + JSON.stringify(list.slice(0, 20), null, 2).slice(0, 15000) + '\n```';
    const rows = list.slice(0, 50).map((x) => `| ${cols.map((k) => cell(k === 'id' ? `\`${x[k] ?? ''}\`` : x[k])).join(' | ')} |`);
    const more = total > 50 || list.length > 50 ? `\n\nShowing the first 50 of ${total}. Use skip and limit to page through the rest.` : '';
    return `${total} item(s).\n\n| ${cols.join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n${rows.join('\n')}${more}`;
  }
  const simple = Object.entries(body).filter(([, v]) => scalar(v)).slice(0, 30);
  const nested = Object.fromEntries(Object.entries(body).filter(([, v]) => !scalar(v)));
  let out = simple.length ? `| Field | Value |\n|---|---|\n${simple.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`).join('\n')}` : '';
  if (Object.keys(nested).length) out += `${out ? '\n\n' : ''}\`\`\`json\n${JSON.stringify(nested, null, 2).slice(0, 12000)}\n\`\`\``;
  return out || 'Done.';
}

async function runOperation(op, a) {
  const args = a || {};
  const p = op.path.replace(/\{([^}]+)\}/g, (_, n) => {
    const v = args[n];
    if (v === undefined || v === null || String(v).trim() === '') throw new Error(`${n} is needed.`);
    return encodeURIComponent(String(v).trim());
  });
  const query = {};
  for (const prm of op.params) {
    if (prm.in !== 'query') continue;
    const v = args[prm.name];
    if (v === undefined || v === null || v === '') continue;
    query[prm.name] = v;
  }
  let json;
  if (op.bodyField) {
    let b = args[op.bodyField];
    if (typeof b === 'string' && b.trim()) {
      try { b = JSON.parse(b); } catch { throw new Error('The request body must be valid JSON.'); }
    }
    json = b === '' ? undefined : b;
  }
  const r = await api(op.method, p, { query, json });
  const body = ok(r, op.summary);

  if (op.session && !args.return_immediately && body && body.id && (body.state || body.sessionType)) {
    const done = await waitFor(body, op.summary);
    if (done.note) return { message: done.note, http_status: r.status, response: body };
    const res = done.result || {};
    if (res.result === 'Failed') throw new Error(`VBR reported the ${op.summary} session as failed: ${res.message || 'no reason given'}`);
    return {
      message: `**${op.summary}** finished: ${res.result || done.state}.${res.message ? ` ${res.message}` : ''}\n\nSession \`${body.id}\`.`,
      http_status: r.status, response: body, session_result: res,
    };
  }
  return { message: summarise(body, op), http_status: r.status, response: body };
}

const ABOUT = {
  name: 'about_rest_operations',
  title: 'About these REST operations',
  description: 'Shows which OpenAPI file is loaded, the API revision used, and which Veeam operations were left out and why.',
  annotations: { readOnlyHint: true, destructiveHint: false },
  inputSchema: { type: 'object', properties: {} },
  async run() {
    const lines = [
      `OpenAPI file: \`${SPEC_FILE}\`${SPEC ? '' : ' (not loaded)'}`,
      `API revision sent: \`${API_VERSION}\``,
      `REST operations offered: ${OPS.size}`,
      `Left out: ${SKIPPED.length}`,
    ];
    if (SKIPPED.length) {
      lines.push('', '| Operation | Request | Why |', '|---|---|---|',
        ...SKIPPED.map((s) => `| ${cell(s.id)} | ${s.method} ${cell(s.path)} | ${cell(s.why)} |`));
    }
    return { message: lines.join('\n'), offered: OPS.size, skipped: SKIPPED };
  },
};

// ---------------------------------------------------------------------------
// MCP over STDIO
// ---------------------------------------------------------------------------

loadSpec();
if (!API_VERSION) API_VERSION = '1.3-rev1';
const ALL_BUILTIN = [...BUILTIN, ABOUT];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');

function listTools() {
  const builtins = ALL_BUILTIN.map(({ name, title, description, annotations, inputSchema }) => ({ name, title, description, annotations, inputSchema }));
  return [...builtins, ...[...OPS.values()].map((o) => o.tool)];
}

async function onMessage(m) {
  if (!m || typeof m !== 'object') return;
  if (m.id === undefined) return;
  if (m.method === undefined) return;

  if (m.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: m.id, result: {
      protocolVersion: (m.params && m.params.protocolVersion) || '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'vbr-extra', version: VERSION },
      instructions: 'Operations whose names start with rest_ map one-to-one to the Veeam Backup & Replication REST API. '
        + 'List operations accept skip and limit for paging. Request bodies are JSON objects shaped as described in each operation.',
    } });
  }
  if (m.method === 'ping') return send({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: listTools() } });
  if (m.method === 'tools/call') {
    const name = m.params && m.params.name;
    const args = (m.params && m.params.arguments) || {};
    const builtin = ALL_BUILTIN.find((t) => t.name === name);
    const op = OPS.get(name);
    if (!builtin && !op) return send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Unknown tool' } });
    try {
      const out = builtin ? await builtin.run(args) : await runOperation(op, args);
      log(`${name} ok`);
      return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(out).slice(0, 400000) }], structuredContent: out } });
    } catch (err) {
      log(`${name} failed: ${err.message}`);
      return send({ jsonrpc: '2.0', id: m.id, result: { isError: true, content: [{ type: 'text', text: err.message }] } });
    }
  }
  return send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  onMessage(m).catch((err) => log('unexpected:', err.message));
});
log(`started, VBR ${BASE || '(VBR_URL not set)'}, API ${API_VERSION}${INSECURE ? ', certificate checks off' : ''}`);

// The MCP servers this portal can talk to.
//
// Defined in a JSON file (default /etc/veeam-assistant/backends.json) so new
// servers can be added without changing any code. Each entry:
//
// {
//   "id": "vi",                       short name, used in the UI and the log
//   "label": "Veeam Intelligence",    what the selector shows
//   "description": "Ask questions…",  one line under the selector
//   "command": "node",                the program to start
//   "args": ["/servers/vi-mcp/build/index.js"],
//   "cwd": "/servers/vi-mcp",         optional working directory
//   "env_file": "/etc/veeam-assistant/vi.env",   optional, read at start-up
//   "env": { "PRODUCT_NAME": "vbr" },            optional, wins over env_file
//   "mode": "auto",                   auto | question | tools
//   "enabled": true
// }
//
// A tools server can also answer written questions by adding "agent". Claude
// then reads the question, runs the server's tools and writes the answer.
// Reads run straight away; anything that changes something waits for an
// approver, exactly like a hand-picked operation.
//
//   "agent": { "model": "claude-sonnet-5-5", "max_steps": 15, "max_tokens": 4096, "parts": [1],
//              "access": "read-write", "allow_tools": ["find_jobs", "delete_backup"] }
//
// "access" is "read-write" (the default) or "read-only". In read-write, Claude
// can ask for changes and deletions, and every one waits for a human approver.
// In read-only, Claude is given only operations that read.
// "allow_tools" adds named operations from any part to what Claude may use.
//
// "parts" limits Claude to the tools of those parts (numbered from 1). Use it
// when a part offers hundreds of operations: they stay available through the
// Operations list, but are not sent to Claude with every question.
//
// Several servers can be shown as one entry by giving it "parts" instead of
// a command. Each part has its own command, args, cwd, env_file, env, and an
// optional "hide_tools" list of tool names not to show. Their tools appear as
// one list; running a tool starts the part that owns it.
//
// {
//   "id": "vbr", "label": "Veeam Backup & Replication", "mode": "tools",
//   "parts": [
//     { "command": "...", "args": [...], "env_file": "..." },
//     { "command": "node", "args": ["/servers/vbr-extra/server.mjs"], "hide_tools": ["find_jobs"] }
//   ]
// }
//
// mode decides how the chat page uses the server:
//   question  the server has one tool that answers a written question
//             (Veeam Intelligence). The portal sends the sentence and shows
//             the answer.
//   tools     the server offers separate tools (list jobs, start job, delete
//             job…). The portal lists them, builds a form from each tool's
//             own schema, and runs the one the person picks. No AI chooses
//             anything, so nothing can be talked into a destructive call.
//   auto      decided when the server first connects: question mode if a
//             question-answering tool is present, otherwise tools mode.

import fs from 'node:fs';
import path from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

// A server is in question mode if it offers one of these.
const QUESTION_TOOLS = ['veeam-question-answering', 'question-answering', 'ask', 'chat'];
const CONFIRM_TOOLS = ['veeam-confirm-action', 'confirm-action'];

export function readEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return out;
    throw err;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);      // kept literally, as Docker does
  }
  return out;
}

// "read-write" unless the file says otherwise. An unrecognised value falls back
// to the safer "read-only" and says so.
function accessOf(value, id, log) {
  if (value === undefined || value === null || value === '') return 'read-write';
  const v = String(value).trim().toLowerCase();
  if (v === 'read-write' || v === 'readwrite' || v === 'rw') return 'read-write';
  if (v === 'read-only' || v === 'readonly' || v === 'ro') return 'read-only';
  log.error(`[backends] "${id}" has access "${value}", which is not "read-write" or "read-only"; using read-only.`);
  return 'read-only';
}

export class Backends {
  constructor({ file, baseEnv, log = console }) {
    this.file = file;
    this.baseEnv = baseEnv;
    this.items = [];
    this.problem = '';
    this.load(log);
  }

  load(log = console) {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      this.problem = err.code === 'ENOENT'
        ? `No MCP servers are configured: ${this.file} does not exist.`
        : `${this.file} could not be read: ${err.message}`;
      log.error(`[backends] ${this.problem}`);
      this.items = [];
      return;
    }
    const list = Array.isArray(raw) ? raw : raw.servers;
    if (!Array.isArray(list)) {
      this.problem = `${this.file} must hold a list of servers, or an object with a "servers" list.`;
      log.error(`[backends] ${this.problem}`);
      this.items = [];
      return;
    }

    const seen = new Set();
    const items = [];
    for (const [i, entry] of list.entries()) {
      const where = `entry ${i + 1}`;
      if (!entry || typeof entry !== 'object') { log.error(`[backends] ${where} is not an object; skipped.`); continue; }
      if (entry.enabled === false) continue;
      const id = String(entry.id || '').trim().toLowerCase();
      if (!ID_RE.test(id)) { log.error(`[backends] ${where} has no usable id; skipped.`); continue; }
      if (seen.has(id)) { log.error(`[backends] ${where} repeats the id "${id}"; skipped.`); continue; }
      const mode = ['auto', 'question', 'tools'].includes(entry.mode) ? entry.mode : 'auto';
      const rawParts = Array.isArray(entry.parts) && entry.parts.length ? entry.parts : [entry];
      const parts = [];
      for (const [pi, raw] of rawParts.entries()) {
        const where2 = rawParts.length > 1 ? `"${id}" part ${pi + 1}` : `"${id}"`;
        if (!raw || typeof raw !== 'object' || !raw.command) { log.error(`[backends] ${where2} has no command; skipped.`); continue; }
        let env = { ...this.baseEnv };
        if (raw.env_file) {
          try {
            env = { ...env, ...readEnvFile(raw.env_file) };
          } catch (err) {
            log.error(`[backends] ${where2} could not read ${raw.env_file}: ${err.message}`);
          }
          try {
            if ((fs.statSync(raw.env_file).mode & 0o077) !== 0) log.warn(`[backends] ${raw.env_file} is readable by other users. Use chmod 600.`);
          } catch { /* already reported */ }
        }
        if (raw.env && typeof raw.env === 'object') env = { ...env, ...raw.env };
        parts.push({
          index: parts.length,
          name: String(raw.name || '').slice(0, 40),
          command: String(raw.command),
          args: (Array.isArray(raw.args) ? raw.args : []).map(String),
          cwd: raw.cwd ? String(raw.cwd) : undefined,
          envFile: raw.env_file || null,
          env,
          hide: (Array.isArray(raw.hide_tools) ? raw.hide_tools : []).map(String),
        });
      }
      if (!parts.length) { log.error(`[backends] "${id}" has no usable command; skipped.`); continue; }

      let agent = null;
      if (entry.agent && typeof entry.agent === 'object') {
        const a = entry.agent;
        const model = String(a.model || '').trim();
        if (!model) {
          log.error(`[backends] "${id}" has "agent" but no "model"; written questions are off for it.`);
        } else {
          agent = {
            model,
            maxSteps: Math.min(40, Math.max(1, Number(a.max_steps) || 15)),
            maxTokens: Math.min(32000, Math.max(256, Number(a.max_tokens) || 4096)),
            maxToolChars: Math.min(200000, Math.max(2000, Number(a.max_tool_chars) || 30000)),
            historyTurns: Math.min(20, Math.max(0, Number.isFinite(Number(a.history_turns)) ? Number(a.history_turns) : 4)),
            // Which parts' tools Claude may see and call, numbered from 1. Empty: all.
            parts: (Array.isArray(a.parts) ? a.parts : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1).map((n) => n - 1),
            maxTools: Math.min(1000, Math.max(5, Number(a.max_tools) || 200)),
            // read-write (default): Claude may ask for changes, each held for a human
            // approver. read-only: Claude is given only operations that read.
            access: accessOf(a.access, id, log),
            // Operations from any part to give Claude in addition to its parts.
            // Names, with * as a wildcard: "delete_backup", "rest_*_job".
            allowTools: (Array.isArray(a.allow_tools) ? a.allow_tools : []).map((x) => String(x).trim()).filter(Boolean),
            extraInstructions: String(a.instructions || ''),
          };
        }
      }

      items.push({
        id,
        agent,
        label: String(entry.label || id),
        description: String(entry.description || ''),
        parts,
        // kept for older callers: the first part
        command: parts[0].command,
        args: parts[0].args,
        cwd: parts[0].cwd,
        envFile: parts[0].envFile,
        env: parts[0].env,
        mode,
        effectiveMode: mode === 'auto' ? null : mode,      // filled in on first connect
        tools: null,
        serverInfo: null,
        lastError: '',
        checkedAt: null,
      });
      seen.add(id);
    }

    this.items = items;
    this.problem = items.length ? '' : `${this.file} lists no usable servers.`;
    log.log(`[backends] ${items.length} MCP server(s) configured: ${items.map((b) => {
      const bits = [];
      if (b.parts.length > 1) bits.push(`${b.parts.length} parts`);
      if (b.agent) bits.push(`answers questions with ${b.agent.model}`);
      return bits.length ? `${b.id} (${bits.join(', ')})` : b.id;
    }).join(', ') || 'none'}`);
  }

  get list() { return this.items; }
  get default() { return this.items[0] || null; }

  get(id) {
    if (!id) return this.default;
    return this.items.find((b) => b.id === String(id).toLowerCase()) || null;
  }

  // Secrets to mask in logs and error details.
  secretsOf(b) {
    const keys = ['ADMIN_PASSWORD', 'VEEAM_PASSWORD', 'VBR_PASSWORD', 'PASSWORD', 'API_KEY', 'TOKEN'];
    const out = new Set();
    for (const part of b.parts || [b]) {
      for (const k of keys) if (part.env && part.env[k]) out.add(part.env[k]);
    }
    return [...out];
  }

  // Record what a server reported when it last connected.
  remember(b, { serverInfo, tools, instructions }) {
    b.serverInfo = serverInfo || null;
    b.instructions = instructions || '';
    b.tools = (tools || []).map(describeTool);
    b.checkedAt = new Date().toISOString();
    b.lastError = '';
    if (b.mode === 'auto') {
      b.effectiveMode = b.tools.some((t) => QUESTION_TOOLS.includes(t.name)) ? 'question' : 'tools';
    }
    b.questionTool = b.tools.find((t) => QUESTION_TOOLS.includes(t.name))?.name || null;
    b.confirmTool = b.tools.find((t) => CONFIRM_TOOLS.includes(t.name))?.name || null;
  }

  view(b) {
    return {
      id: b.id,
      label: b.label,
      description: b.description,
      mode: b.agent ? 'agent' : (b.effectiveMode || b.mode),
      model: b.agent ? b.agent.model : null,
      access: b.agent ? b.agent.access : null,
      ready: Array.isArray(b.tools),
      tool_count: b.tools ? b.tools.length : null,
      parts: b.parts ? b.parts.length : 1,
      server: b.serverInfo,
      last_error: b.lastError,
      checked_at: b.checkedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Tool classification
// ---------------------------------------------------------------------------
//
// Whether a tool only reads, changes something, or destroys something decides
// whether running it needs an approval, and which approver group it belongs
// to. An MCP server may say so itself through annotations; where it does not,
// the name is used. Anything unrecognised counts as a change, never as a read,
// so a new tool is never run unapproved by accident.

const DESTRUCTIVE = /(^|[_\-.])(delete|remove|destroy|purge|erase|wipe|revoke|uninstall|drop)([_\-.]|$)|^del[A-Z_]/i;
const WRITE = /(^|[_\-.])(start|stop|run|create|add|new|edit|update|modify|set|put|patch|enable|disable|retry|restore|failover|migrate|unmount|mount|install|apply|import|upload|assign|rescan|scan|sync|move|rename|promote|cancel|kill|reset)([_\-.]|$)/i;
const READ = /(^|[_\-.])(get|list|view|show|read|find|search|describe|inspect|info|status|summary|report|count|check|export|download)([_\-.]|$)|^(all|browse)/i;

export function riskOf(tool) {
  const a = tool.annotations || {};
  if (a.destructiveHint === true) return 'destructive';
  if (a.readOnlyHint === true) return 'read';
  const n = String(tool.name || '');
  if (DESTRUCTIVE.test(n)) return 'destructive';
  if (WRITE.test(n)) return 'write';
  if (READ.test(n) && a.readOnlyHint !== false) return 'read';
  return 'write';                                   // unknown: treat as a change
}

export function describeTool(t) {
  const schema = t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object' };
  return {
    name: t.name,
    part: Number.isInteger(t._part) ? t._part : 0,
    title: t.title || (t.annotations && t.annotations.title) || '',
    description: String(t.description || '').slice(0, 2000),
    risk: riskOf(t),
    schema: {
      type: 'object',
      properties: schema.properties && typeof schema.properties === 'object' ? schema.properties : {},
      required: Array.isArray(schema.required) ? schema.required : [],
    },
  };
}

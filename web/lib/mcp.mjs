// Minimal Model Context Protocol client over STDIO.
//
// Each question starts its own Veeam MCP server process (that is how the
// server is designed: every question opens a new Veeam Intelligence chat).
// The process stays alive while a proposed action waits for an approver,
// because the confirmation has to reach the same process that parked it.
//
// The protocol is newline-delimited JSON-RPC 2.0 on stdin/stdout. Only the
// pieces this portal needs are implemented: initialize, tools/list,
// tools/call, and answering the server's ping. This client deliberately does
// not declare the "elicitation" capability, so the Veeam server returns a
// pending_action for us to route to an approver instead of expecting an
// interactive Yes/No prompt.

import { spawn } from 'node:child_process';
import readline from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

export class McpError extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail || '';
  }
}

export class McpSession {
  constructor({ command, args = [], cwd, env, clientVersion = '1.0.0', logStderr = false, secrets = [] }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.clientVersion = clientVersion;
    this.logStderr = logStderr;
    this.secrets = secrets.filter((s) => s && s.length >= 4);
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.stderrTail = '';
    this.serverInfo = null;
  }

  redact(text) {
    let out = String(text || '');
    for (const s of this.secrets) out = out.split(s).join('***');
    return out;
  }

  async start(timeoutMs = 60_000) {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.on('error', (err) => this._fail(new McpError('Could not start the MCP server.', err.message)));
    this.proc.on('exit', (code, signal) => {
      this.closed = true;
      this._fail(new McpError(
        'The MCP server stopped unexpectedly.',
        `exit code ${code}${signal ? `, signal ${signal}` : ''}\n${this.stderrTail.slice(-1500)}`,
      ));
    });
    this.proc.stdin.on('error', () => { /* reported through exit */ });

    readline.createInterface({ input: this.proc.stdout }).on('line', (line) => this._onLine(line));
    this.proc.stderr.on('data', (chunk) => {
      const text = this.redact(chunk.toString('utf8'));
      this.stderrTail = (this.stderrTail + text).slice(-8000);
      if (this.logStderr) process.stderr.write(text.replace(/^/gm, '[mcp] '));
    });

    const init = await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'veeam-assistant-portal', version: this.clientVersion },
    }, timeoutMs);
    this.serverInfo = init && init.serverInfo ? init.serverInfo : null;
    this.notify('notifications/initialized');
    return init;
  }

  _write(msg) {
    if (this.closed || !this.proc || !this.proc.stdin.writable) {
      throw new McpError('The MCP server is not running.');
    }
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  describe() {
    return `${this.command} ${this.args.join(' ')}`.trim();
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }      // ignore anything that is not JSON-RPC
    if (!msg || typeof msg !== 'object') return;

    // Response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new McpError(msg.error.message || 'The MCP server returned an error.', JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }

    // Request from the server to us.
    if (msg.id !== undefined && msg.method) {
      try {
        if (msg.method === 'ping') this._write({ jsonrpc: '2.0', id: msg.id, result: {} });
        else this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Client does not support ${msg.method}` } });
      } catch { /* closed */ }
    }
    // Notifications (logging, progress) are ignored.
  }

  _fail(err) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  request(method, params, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpError('The MCP server took too long to answer.', `${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._write({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try { this._write({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); } catch { /* closed */ }
  }

  async listTools(timeoutMs = 60_000) {
    const r = await this.request('tools/list', {}, timeoutMs);
    return (r && r.tools) || [];
  }

  async callTool(name, args, timeoutMs) {
    const r = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    return parseToolResult(r);
  }

  close() {
    if (this.closed || !this.proc) return;
    this.closed = true;
    try { this.proc.stdin.end(); } catch { /* ignore */ }
    const p = this.proc;
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGTERM'); }, 1500).unref();
    setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 5000).unref();
  }
}

export function parseToolResult(r) {
  const text = ((r && r.content) || [])
    .filter((c) => c && c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (r && r.isError) throw new McpError('The MCP server reported an error.', text);
  let data = r && r.structuredContent;
  if (!data && text) {
    try { data = JSON.parse(text); } catch { data = { message: text }; }
  }
  return data || { message: '' };
}

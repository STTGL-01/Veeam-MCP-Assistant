// Minimal client for the Claude Messages API (Node.js standard library only).
//
// Used by "agent" backends: Claude reads a question, picks MCP tools to run,
// and writes the answer. The API key comes from ANTHROPIC_API_KEY in app.env
// and is never passed on to the MCP servers.

const DEFAULT_BASE = 'https://api.anthropic.com';
const API_VERSION = '2023-06-01';

export class ClaudeError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.status = status;
    this.detail = detail || '';
  }
}

export class Claude {
  constructor({ apiKey, baseUrl, timeoutMs = 180_000 }) {
    this.apiKey = apiKey;
    this.base = String(baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  get configured() { return Boolean(this.apiKey); }

  async _call(method, path, body, model) {
    if (!this.apiKey) {
      throw new ClaudeError('No Claude API key is set. Add ANTHROPIC_API_KEY to app.env and recreate the container.', 0);
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(this.base + path, {
        method,
        signal: ctl.signal,
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': API_VERSION,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const why = err.name === 'AbortError' ? `no answer within ${Math.round(this.timeoutMs / 1000)} seconds`
        : (err.cause && (err.cause.code || err.cause.message)) || err.message;
      throw new ClaudeError(`Could not reach the Claude API at ${this.base} (${why}). Check that this server can make outbound HTTPS connections.`, 0);
    } finally {
      clearTimeout(timer);
    }

    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (res.ok) return data;

    const msg = (data && data.error && data.error.message) || text.slice(0, 300) || res.statusText;
    const known = {
      400: `The Claude API rejected the request: ${msg}`,
      401: 'The Claude API key was refused. Check ANTHROPIC_API_KEY in app.env.',
      403: `The Claude API key is not allowed to do this: ${msg}`,
      404: model ? `The model "${model}" was not found. Check the model name in backends.json.` : `Not found: ${msg}`,
      413: 'The request was too large for the Claude API. Ask about fewer things at once.',
      429: 'The Claude API rate limit was reached. Wait a minute and try again.',
      500: 'The Claude API had an internal error. Try again shortly.',
      529: 'The Claude API is overloaded at the moment. Try again shortly.',
    };
    throw new ClaudeError(known[res.status] || `The Claude API returned HTTP ${res.status}: ${msg}`, res.status, msg);
  }

  messages(req) {
    return this._call('POST', '/v1/messages', req, req.model);
  }

  // Checks the key and the model name without generating anything.
  async checkModel(model) {
    const m = await this._call('GET', `/v1/models/${encodeURIComponent(model)}`, null, model);
    return { id: m && m.id, name: m && (m.display_name || m.id) };
  }
}

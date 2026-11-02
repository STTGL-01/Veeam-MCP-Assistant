// Append-only activity log (JSON lines). Rotated at about 5 MB.
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 5 * 1024 * 1024;

export class Audit {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'audit.log');
  }

  write(event, fields = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n';
    try {
      try {
        if (fs.statSync(this.file).size > MAX_BYTES) fs.renameSync(this.file, this.file + '.1');
      } catch { /* no file yet */ }
      fs.appendFileSync(this.file, line, { mode: 0o600 });
    } catch (err) {
      console.error('[audit] write failed:', err.message);
    }
  }

  tail(n = 200) {
    try {
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n');
      return lines.slice(-n).reverse().map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
}

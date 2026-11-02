// Small JSON file store. Writes go to a temp file and are renamed into place,
// so a crash or power cut cannot leave a half-written file behind.
import fs from 'node:fs';
import path from 'node:path';

export class JsonFile {
  constructor(file, fallback) {
    this.file = file;
    this.data = fallback;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return;              // first start: no file yet
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        // A permissions problem is not corruption. Stop rather than start
        // with empty data and overwrite the real file later.
        console.error(`[store] Permission denied reading ${file}. The data volume is owned by another user.`);
        console.error('[store] Fix: give the volume to this container\'s user, then start again. See the README.');
        process.exit(78);
      }
      if (err instanceof SyntaxError) {
        // Genuinely unreadable JSON: keep it for inspection, start empty.
        const keep = `${file}.corrupt-${Date.now()}`;
        try {
          fs.renameSync(file, keep);
          console.error(`[store] ${file} was not valid JSON; moved to ${keep}`);
        } catch (e) {
          console.error(`[store] ${file} was not valid JSON and could not be moved aside (${e.message}). Stopping.`);
          process.exit(78);
        }
        return;
      }
      throw err;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

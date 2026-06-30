/**
 * Test-process bootstrap. Loaded via `node --require` before any test file.
 *
 * Goal: every `node --test` child process must open its own SQLite database,
 * so concurrent test files cannot collide on `data/miso-chat.db` and trigger
 * `SQLITE_BUSY` during the WAL pragma in `lib/db.js`.
 *
 * Strategy: when no DB_PATH is set, point `DB_PATH` (and `DB_DIR`) at a
 * per-process temp file. This file is *only* used for the lifetime of the
 * current Node process; nothing else reads it. Production code paths in
 * `lib/db.js` are unchanged — they still honor `DB_PATH` / `DB_DIR` from the
 * environment.
 *
 * This must run before `require('../server')` (which transitively requires
 * `lib/db.js`), which is why `npm test` and `npm run test:ci` invoke it via
 * `node --require ./tests/setup/load-first.js ...`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.env.DB_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miso-chat-test-'));
  const dbPath = path.join(dir, 'miso-chat.db');
  process.env.DB_DIR = dir;
  process.env.DB_PATH = dbPath;
}

// Belt-and-suspenders: every test file imports a server that needs a session
// secret. Set a default if the test file hasn't already provided one.
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';
}
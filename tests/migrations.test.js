const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Regression coverage for the schema migration framework introduced for
 * issue #688. Verifies:
 *   1. `initSchema()` creates a `_migrations` table.
 *   2. The legacy reaction-uniqueness migration is recorded after it runs.
 *   3. Re-opening the same database does not re-run already-applied
 *      migrations (the framework is idempotent).
 *   4. A pre-existing legacy `reactions` table (3-column UNIQUE) is rebuilt
 *      to the new 4-column scoped UNIQUE shape on first open, and that
 *      rebuild is recorded in `_migrations`.
 */

const repoRoot = path.resolve(__dirname, '..');

function makeTempDbDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miso-chat-migrations-'));
}

function runScript(script, dbDir) {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DB_DIR: dbDir,
    // Ensure no test-local DB_PATH override bleeds in.
    DB_PATH: path.join(dbDir, 'miso-chat.db'),
  };
  return spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

function snapshot(dbDir, body) {
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(path.join(dbDir, 'miso-chat.db'))});
    ${body}
  `;
  return runScript(script, dbDir);
}

test('initSchema creates the _migrations table', () => {
  const dbDir = makeTempDbDir();
  try {
    const script = `require(${JSON.stringify(path.join(repoRoot, 'lib/db.js'))});`;
    const res = runScript(script, dbDir);
    assert.equal(res.status, 0, `child failed: ${res.stderr}`);

    const snap = snapshot(
      dbDir,
      `process.stdout.write(JSON.stringify({
        tables: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'").all(),
        applied: db.prepare('SELECT id FROM _migrations ORDER BY id').all(),
      }));`
    );
    assert.equal(snap.status, 0, snap.stderr);
    const out = JSON.parse(snap.stdout);
    assert.equal(out.tables.length, 1, '_migrations table should exist');
    assert.deepEqual(
      out.applied.map((r) => r.id),
      ['001_legacy_reaction_uniqueness'],
      'the legacy reaction-uniqueness migration should be recorded'
    );
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test('opening the same database twice does not re-run migrations', () => {
  const dbDir = makeTempDbDir();
  try {
    const requireScript = `require(${JSON.stringify(path.join(repoRoot, 'lib/db.js'))});`;
    assert.equal(runScript(requireScript, dbDir).status, 0);
    assert.equal(runScript(requireScript, dbDir).status, 0);

    const snap = snapshot(
      dbDir,
      `process.stdout.write(JSON.stringify({
        rows: db.prepare('SELECT id, description FROM _migrations').all(),
      }));`
    );
    assert.equal(snap.status, 0, snap.stderr);
    const out = JSON.parse(snap.stdout);
    assert.equal(
      out.rows.length,
      1,
      'migration should appear exactly once after two opens'
    );
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test('legacy 3-column unique reactions table is rebuilt to scoped unique', () => {
  const dbDir = makeTempDbDir();
  const dbPath = path.join(dbDir, 'miso-chat.db');
  try {
    // Seed a pre-migration-framework database: a `reactions` table with the
    // old 3-column UNIQUE constraint (no session_key in the unique). A row
    // is present so we can confirm it survives the table rebuild.
    const seedScript = `
      const Database = require('better-sqlite3');
      const db = new Database(${JSON.stringify(dbPath)});
      db.exec(\`
        CREATE TABLE reactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          emoji TEXT NOT NULL,
          username TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(message_id, emoji, username)
        );
      \`);
      db.prepare('INSERT INTO reactions (message_id, session_key, emoji, username) VALUES (?, ?, ?, ?)').run('m1', 'sessA', '👍', 'alice');
    `;
    assert.equal(runScript(seedScript, dbDir).status, 0);

    // Opening the DB via lib/db.js should rebuild reactions and record the
    // migration in _migrations.
    const openScript = `require(${JSON.stringify(path.join(repoRoot, 'lib/db.js'))});`;
    const res = runScript(openScript, dbDir);
    assert.equal(res.status, 0, `lib/db.js failed to open legacy DB: ${res.stderr}`);

    const snap = snapshot(
      dbDir,
      `process.stdout.write(JSON.stringify({
        schema: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reactions'").get(),
        rows: db.prepare('SELECT id, message_id, session_key, emoji, username FROM reactions ORDER BY id').all(),
        applied: db.prepare('SELECT id FROM _migrations').all(),
      }));`
    );
    assert.equal(snap.status, 0, snap.stderr);
    const out = JSON.parse(snap.stdout);

    assert.ok(out.schema, 'reactions table should still exist');
    const sql = out.schema.sql.replace(/\s+/g, ' ').toLowerCase();
    assert.ok(
      sql.includes('unique(message_id, session_key, emoji, username)'),
      'reactions should have the scoped 4-column UNIQUE constraint'
    );
    assert.ok(
      !sql.includes('unique(message_id, emoji, username)'),
      'reactions should no longer have the legacy 3-column UNIQUE constraint'
    );
    assert.equal(out.rows.length, 1, 'seeded row should survive the rebuild');
    assert.deepEqual(
      out.applied.map((r) => r.id),
      ['001_legacy_reaction_uniqueness'],
      'migration should be recorded exactly once'
    );
  } finally {
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
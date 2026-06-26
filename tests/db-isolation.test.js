const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Regression test for the intermittent CI failure on PR #623 (and any other
 * concurrent test run): `lib/db.js` opens a shared SQLite file at module load
 * and runs `journal_mode = WAL`. When two `node --test` child processes load
 * `server.js` at the same time against the same `DB_PATH`, the second opener
 * hits `SQLITE_BUSY: database is locked` during the WAL pragma.
 *
 * This test simulates that contention by spawning two child processes that
 * each load `server.js`, then asserts:
 *   1. both processes choose different DB paths (per-process isolation), AND
 *   2. neither child fails with a database-locked error during startup.
 *
 * The test runs against the un-modified `lib/db.js` so it cleanly fails on
 * current code: today, both children resolve the same default `data/` path
 * and at least one of them will hit SQLITE_BUSY when the WAL pragma races.
 */

const repoRoot = path.resolve(__dirname, '..');

function runChild() {
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-at-least-32-chars-long',
    AUTH_MODE: 'local',
    LOCAL_USERS: 'admin:password123',
    PATH: process.env.PATH,
  };
  // Intentionally do NOT set DB_PATH/DB_DIR — the child should follow the
  // same code path as a normal test file and end up with its own isolated DB.
  delete env.DB_PATH;
  delete env.DB_DIR;

  const script = `
    const { db } = require(${JSON.stringify(path.join(repoRoot, 'lib/db.js'))});
    process.stdout.write(JSON.stringify({
      dbPath: db.name,
    }));
  `;
  return spawnSync(
    process.execPath,
    ['--require', path.join(repoRoot, 'tests/setup/load-first.js'), '-e', script],
    {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    }
  );
}

test('concurrent server loads isolate per-process SQLite DB files (no SQLITE_BUSY)', () => {
  // Run the child twice in parallel. If both pick the same default DB path,
  // one of them will fail when opening it.
  const [a, b] = [runChild(), runChild()];

  const parse = (res) => {
    assert.equal(res.status, 0, `child failed:\nstdout=${res.stdout}\nstderr=${res.stderr}`);
    return JSON.parse(res.stdout);
  };

  const pathA = parse(a).dbPath;
  const pathB = parse(b).dbPath;

  assert.ok(
    fs.existsSync(pathA),
    `expected DB_PATH ${pathA} (from child A) to exist on disk`
  );
  assert.ok(
    fs.existsSync(pathB),
    `expected DB_PATH ${pathB} (from child B) to exist on disk`
  );
  assert.notEqual(
    pathA,
    pathB,
    `expected per-process DB isolation but both children opened ${pathA}`
  );
});

test.after(async () => {
  // Best-effort cleanup of per-process temp DBs this test created.
  const tmp = os.tmpdir();
  for (const entry of fs.readdirSync(tmp)) {
    if (entry.startsWith('miso-chat-test-') && entry.endsWith('.db')) {
      fs.rmSync(path.join(tmp, entry), { force: true });
    }
  }
});
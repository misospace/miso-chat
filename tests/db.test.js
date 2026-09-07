const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { db, reactions } = require('../lib/db.js');
const { runMigrations } = require('../lib/migrate');

describe('lib/db.js — schema and reactions', () => {
  describe('schema init', () => {
    it('creates the reactions table on first load', () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='reactions'",
      ).all();
      assert.equal(tables.length, 1);
      assert.equal(tables[0].name, 'reactions');
    });

    it('has the expected columns', () => {
      const info = db.prepare('PRAGMA table_info(reactions)').all();
      const names = info.map((c) => c.name);
      assert.ok(names.includes('id'));
      assert.ok(names.includes('message_id'));
      assert.ok(names.includes('session_key'));
      assert.ok(names.includes('emoji'));
      assert.ok(names.includes('username'));
    });

    it('sets busy_timeout to 5000 ms so concurrent writers wait instead of failing with SQLITE_BUSY (issue #853)', () => {
      const rows = db.pragma('busy_timeout');
      assert.equal(rows[0].timeout, 5000);
    });

    it('enforces unique constraint on (message_id, session_key, emoji, username)', () => {
      const msgId = 'msg-unique-test';
      const sessKey = 'sess-unique-test';
      reactions.removeForMessage(msgId);

      const stmt = db.prepare(
        'INSERT INTO reactions (message_id, session_key, emoji, username) VALUES (?, ?, ?, ?)',
      );
      stmt.run(msgId, sessKey, '👍', 'user1');

      assert.throws(() => {
        stmt.run(msgId, sessKey, '👍', 'user1');
      }, /UNIQUE constraint failed/);

      // Different emoji from same session is allowed
      stmt.run(msgId, sessKey, '❤️', 'user1');
    });
  });

  describe('toggleReaction', () => {
    it('adds a reaction when none exists', () => {
      const msgId = 'msg-toggle-1';
      reactions.removeForMessage(msgId);

      const result = reactions.toggle(msgId, 'sess-toggle-1', '🎉', 'alice');
      assert.equal(result.action, 'added');
      assert.equal(result.emoji, '🎉');
      assert.ok(typeof result.id === 'number' || typeof result.id === 'bigint');
    });

    it('removes a reaction when it already exists', () => {
      const msgId = 'msg-toggle-2';
      reactions.removeForMessage(msgId);

      // First add
      reactions.toggle(msgId, 'sess-toggle-2', '🎉', 'alice');
      // Then remove
      const result = reactions.toggle(msgId, 'sess-toggle-2', '🎉', 'alice');
      assert.equal(result.action, 'removed');
      assert.equal(result.emoji, '🎉');
    });

    it('toggles back to added on third call', () => {
      const msgId = 'msg-toggle-3';
      reactions.removeForMessage(msgId);

      // First add
      reactions.toggle(msgId, 'sess-toggle-3', '🎉', 'alice');
      // Then remove
      reactions.toggle(msgId, 'sess-toggle-3', '🎉', 'alice');
      // Then add again
      const result = reactions.toggle(msgId, 'sess-toggle-3', '🎉', 'alice');
      assert.equal(result.action, 'added');
    });
  });

  describe('getForMessage', () => {
    it('returns reactions for a given message_id', () => {
      // Clean up any prior test data for this message
      reactions.removeForMessage('msg-b');

      reactions.toggle('msg-b', 'sess-1', '👍', 'alice');
      reactions.toggle('msg-b', 'sess-2', '👍', 'bob');
      reactions.toggle('msg-b', 'sess-3', '❤️', 'carol');

      const result = reactions.getForMessage('msg-b');

      assert.ok(Array.isArray(result));
      assert.equal(result.length, 2);

      const thumbsUp = result.find((r) => r.emoji === '👍');
      assert.ok(thumbsUp);
      assert.equal(thumbsUp.count, 2);
      assert.ok(thumbsUp.users.includes('alice'));
      assert.ok(thumbsUp.users.includes('bob'));

      const heart = result.find((r) => r.emoji === '❤️');
      assert.ok(heart);
      assert.equal(heart.count, 1);
    });

    it('returns empty array when no reactions exist', () => {
      const result = reactions.getForMessage('nonexistent-msg');
      assert.deepEqual(result, []);
    });

    it('filters by session_key when provided', () => {
      reactions.removeForMessage('msg-filter');

      reactions.toggle('msg-filter', 'sess-x', '👍', 'alice');
      reactions.toggle('msg-filter', 'sess-y', '❤️', 'bob');

      const result = reactions.getForMessage('msg-filter', 'sess-x');
      assert.equal(result.length, 1);
      assert.equal(result[0].emoji, '👍');
    });
  });

  describe('removeForMessage', () => {
    it('removes all reactions for a message', () => {
      reactions.removeForMessage('msg-c');

      reactions.toggle('msg-c', 'sess-x', '🔥', 'alice');
      reactions.toggle('msg-c', 'sess-y', '🔥', 'bob');

      let result = reactions.getForMessage('msg-c');
      assert.equal(result.length, 1);
      assert.equal(result[0].count, 2);

      reactions.removeForMessage('msg-c');

      result = reactions.getForMessage('msg-c');
      assert.deepEqual(result, []);
    });

    it('is safe to call when no reactions exist', () => {
      // Should not throw
      reactions.removeForMessage('msg-nonexistent');
    });
  });

  describe('aggregation across sessions', () => {
    it('counts reactions from multiple sessions correctly', () => {
      const msgId = 'msg-multi';
      reactions.removeForMessage(msgId);

      for (let i = 0; i < 5; i++) {
        reactions.toggle(msgId, `sess-${i}`, '⭐', `user-${i}`);
      }

      const result = reactions.getForMessage(msgId);
      assert.equal(result.length, 1);
      assert.equal(result[0].emoji, '⭐');
      assert.equal(result[0].count, 5);
    });
  });

  describe('getForSession', () => {
    it('returns all reactions for a session', () => {
      const sessionKey = 'sess-session-test';
      // Clean up
      db.prepare('DELETE FROM reactions WHERE session_key = ?').run(sessionKey);

      reactions.toggle('msg-s1', sessionKey, '👍', 'alice');
      reactions.toggle('msg-s2', sessionKey, '❤️', 'alice');

      const result = reactions.getForSession(sessionKey);

      assert.ok(result['msg-s1']);
      assert.ok(result['msg-s1']['👍']);
      assert.ok(result['msg-s2']);
      assert.ok(result['msg-s2']['❤️']);
    });

    it('returns empty object when session has no reactions', () => {
      const result = reactions.getForSession('nonexistent-session');
      assert.deepEqual(result, {});
    });
  });

  describe('concurrent toggles (issue #853)', () => {
    const repoRoot = path.resolve(__dirname, '..');
    const N = 8;
    const TOGGLES_PER_CHILD = 5;

    // Each child opens its own connection to the shared DB file and issues
    // TOGGLES_PER_CHILD toggles against the same (messageId, sessionKey,
    // emoji, username) row. Without busy_timeout, the second writer fails
    // immediately with SQLITE_BUSY; with it, writers wait up to 5s for the
    // lock and every toggle succeeds.
    const childScript = `
      const { reactions } = require(${JSON.stringify(path.join(repoRoot, 'lib/db.js'))});
      for (let i = 0; i < ${TOGGLES_PER_CHILD}; i++) {
        reactions.toggle('msg-busy', 'sess-busy', '👍', 'user-busy');
      }
      process.stdout.write('ok');
    `;

    function spawnToggleChild(dbPath) {
      return new Promise((resolve) => {
        // Strip the test-runner markers so load-first.js does not re-point
        // DB_PATH at a fresh per-process file: every child must open the
        // shared dbPath for the contention to be real.
        const env = { ...process.env, DB_PATH: dbPath, DB_DIR: path.dirname(dbPath) };
        delete env.MISO_CHAT_TEST_DB_ISOLATED;
        delete env.NODE_TEST_CONTEXT;
        const child = spawn(
          process.execPath,
          ['-e', childScript],
          {
            cwd: repoRoot,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.on('close', (code) => resolve({ code, stdout, stderr }));
      });
    }

    it(`N concurrent toggles on the same row all succeed (no SQLITE_BUSY)`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miso-chat-busy-'));
      const dbPath = path.join(dir, 'miso-chat.db');
      try {
        // Create and migrate the shared DB file before spawning children.
        const shared = new Database(dbPath);
        shared.pragma('journal_mode = WAL');
        runMigrations(shared);
        shared.close();

        const results = await Promise.all(
          Array.from({ length: N }, () => spawnToggleChild(dbPath)),
        );

        results.forEach((r, i) => {
          assert.equal(r.code, 0, `child ${i} failed (exit ${r.code}):\nstdout=${r.stdout}\nstderr=${r.stderr}`);
          assert.equal(r.stdout, 'ok', `child ${i} did not complete all toggles:\nstderr=${r.stderr}`);
          assert.ok(!/SQLITE_BUSY|database is locked/i.test(r.stderr), `child ${i} hit SQLITE_BUSY:\nstderr=${r.stderr}`);
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a writer blocked by an open transaction waits for busy_timeout instead of failing', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miso-chat-busy-'));
      const dbPath = path.join(dir, 'miso-chat.db');
      try {
        const shared = new Database(dbPath);
        shared.pragma('journal_mode = WAL');
        runMigrations(shared);

        // Hold a write lock in this process for ~1.5s. A child that tries to
        // write during that window must wait (busy_timeout) and then succeed,
        // rather than throwing SQLITE_BUSY immediately. The lock is released
        // on a timer (not after awaiting the child) so the child can finish.
        shared.exec('BEGIN IMMEDIATE');
        const release = setTimeout(() => {
          try {
            shared.exec('COMMIT');
          } catch {
            // already committed
          }
        }, 1500);
        const started = Date.now();
        const { code, stdout, stderr } = await spawnToggleChild(dbPath);
        const elapsed = Date.now() - started;
        clearTimeout(release);
        shared.close();

        assert.equal(code, 0, `child failed (exit ${code}):\nstdout=${stdout}\nstderr=${stderr}`);
        assert.equal(stdout, 'ok');
        assert.ok(!/SQLITE_BUSY|database is locked/i.test(stderr), `child hit SQLITE_BUSY:\nstderr=${stderr}`);
        assert.ok(elapsed >= 1000, `expected the child to wait for the held lock, but it finished in ${elapsed}ms`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

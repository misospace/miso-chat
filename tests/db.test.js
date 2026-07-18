const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { db, reactions } = require('../lib/db.js');

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
});

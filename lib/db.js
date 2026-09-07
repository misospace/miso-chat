const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { runMigrations } = require('./migrate');

const DB_DIR = process.env.DB_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'miso-chat.db');

// Ensure data directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Wait up to 5s for a write lock instead of failing immediately with
// SQLITE_BUSY when another connection is mid-transaction (issue #853).
db.pragma('busy_timeout = 5000');

// Initialize schema by running all pending migrations
runMigrations(db);

// Run `fn` inside a `BEGIN IMMEDIATE` transaction so a read-then-write is
// atomic under the write lock. Without this, two concurrent toggles can both
// read "no row" and both INSERT, tripping the UNIQUE constraint (issue #853).
// The `busy_timeout` pragma makes `BEGIN IMMEDIATE` wait for the lock instead
// of failing immediately; the retry loop is a bounded safety net for the rare
// case the wait window is exhausted under a burst of writers.
function withImmediateTransaction(fn) {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The failing statement may have already aborted the transaction.
      }
      const isBusy =
        error && (error.code === 'SQLITE_BUSY' || /SQLITE_BUSY|database is locked/i.test(error.message));
      if (isBusy && attempt < MAX_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }
}

// Reaction operations
const reactions = {
  // Add or remove a reaction (toggle behavior)
  toggle(messageId, sessionKey, emoji, username) {
    return withImmediateTransaction(() => {
      const existing = db.prepare(
        'SELECT id FROM reactions WHERE message_id = ? AND session_key = ? AND emoji = ? AND username = ?'
      ).get(messageId, sessionKey, emoji, username);

      if (existing) {
        // Remove reaction
        db.prepare('DELETE FROM reactions WHERE id = ?').run(existing.id);
        return { action: 'removed', emoji };
      }

      // Add reaction
      const result = db.prepare(
        'INSERT INTO reactions (message_id, session_key, emoji, username) VALUES (?, ?, ?, ?)'
      ).run(messageId, sessionKey, emoji, username);
      return { action: 'added', emoji, id: result.lastInsertRowid };
    });
  },

  // Get all reactions for a message
  getForMessage(messageId, sessionKey = null) {
    const rows = sessionKey
      ? db
          .prepare(
            'SELECT emoji, username, created_at FROM reactions WHERE message_id = ? AND session_key = ? ORDER BY created_at ASC'
          )
          .all(messageId, sessionKey)
      : db
          .prepare('SELECT emoji, username, created_at FROM reactions WHERE message_id = ? ORDER BY created_at ASC')
          .all(messageId);

    // Group by emoji
    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.emoji]) {
        grouped[row.emoji] = [];
      }
      grouped[row.emoji].push({
        username: row.username,
        createdAt: row.created_at,
      });
    }

    return Object.entries(grouped).map(([emoji, users]) => ({
      emoji,
      count: users.length,
      users: users.map((u) => u.username),
    }));
  },

  // Get all reactions for a session (for batch loading)
  getForSession(sessionKey) {
    const rows = db.prepare('SELECT message_id, emoji, username FROM reactions WHERE session_key = ?').all(sessionKey);

    const grouped = {};
    for (const row of rows) {
      if (!grouped[row.message_id]) {
        grouped[row.message_id] = {};
      }
      if (!grouped[row.message_id][row.emoji]) {
        grouped[row.message_id][row.emoji] = [];
      }
      grouped[row.message_id][row.emoji].push(row.username);
    }

    return grouped;
  },

  // Remove all reactions for a message (when message is deleted)
  removeForMessage(messageId) {
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(messageId);
  },
};

module.exports = { db, reactions };

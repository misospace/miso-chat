const express = require('express');

/**
 * Reaction API route handlers.
 *
 * @param {object} deps
 * @param {Function} deps.isAuthenticated - Auth middleware
 * @param {Function} deps.requireSessionAccess - Session access middleware factory
 * @param {string} deps.authMode - Current auth mode ('local'|'oidc'|'none')
 * @param {object} deps.reactions - In-memory reactions store (from lib/db)
 * @returns {import('express').Router}
 */
function createReactionsRoutes({ isAuthenticated, requireSessionAccess, authMode, reactions }) {
  const router = express.Router();

  // GET /api/reactions/:sessionKey - Get all reactions for a session (batch load)
  router.get('/reactions/:sessionKey', isAuthenticated, requireSessionAccess(authMode), (req, res) => {
    try {
      const { sessionKey } = req.params;
      const allReactions = reactions.getForSession(sessionKey);
      res.json({ sessionKey, reactions: allReactions });
    } catch (error) {
      console.error('Error getting reactions:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/messages/:messageId/reactions - Get reactions for a specific message
  router.get('/messages/:messageId/reactions', isAuthenticated, requireSessionAccess(authMode), (req, res) => {
    try {
      const { messageId } = req.params;
      const sessionKey = typeof req.query?.sessionKey === 'string' ? req.query.sessionKey : null;
      const messageReactions = reactions.getForMessage(messageId, sessionKey);
      res.json({ messageId, ...(sessionKey ? { sessionKey } : {}), reactions: messageReactions });
    } catch (error) {
      console.error('Error getting message reactions:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/messages/:messageId/reactions - Add or remove a reaction (toggle)
  router.post('/messages/:messageId/reactions', isAuthenticated, requireSessionAccess(authMode), (req, res) => {
    try {
      const { messageId } = req.params;
      const { emoji, sessionKey } = req.body;
      const username = req.user?.username || req.user?.email || 'anonymous';

      if (!emoji) {
        return res.status(400).json({ error: 'Emoji is required' });
      }
      if (!sessionKey) {
        return res.status(400).json({ error: 'Session key is required' });
      }

      const result = reactions.toggle(messageId, sessionKey, emoji, username);
      res.json({ success: true, messageId, ...result });
    } catch (error) {
      console.error('Error toggling reaction:', error.message);
      res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = { createReactionsRoutes };

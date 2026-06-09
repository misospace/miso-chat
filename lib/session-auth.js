/**
 * Session/Operation Authorization Middleware
 *
 * Ensures authenticated users can only access sessions they own.
 * Applied to routes that accept a sessionKey parameter.
 *
 * Ownership rules:
 * - When auth is disabled (authMode === 'none'): all access allowed (no-op).
 * - For local auth: the username from `req.user` must match the user portion
 *   of the session key (e.g., `agent:<username>:<thread>` matches user `<username>`).
 * - For OIDC: the user's email or preferred_username must appear in the session key.
 * - If no ownership match is found, returns 403 Forbidden.
 */

/**
 * Extract the expected owner from a session key.
 * Handles formats like:
 *   agent:<username>:<thread>
 *   g-agent-<name>-<uuid>
 *   <any-other-key> (returns null — no known owner pattern)
 *
 * @param {string} sessionKey
 * @returns {string|null} - The inferred owner username, or null if unknown format.
 */
function extractSessionOwner(sessionKey) {
  if (!sessionKey || typeof sessionKey !== 'string') return null;

  // Format: agent:<username>:<rest>
  const agentMatch = sessionKey.match(/^agent:([^:]+):/);
  if (agentMatch && agentMatch[1]) {
    return agentMatch[1];
  }

  // Format: g-agent-<name>-<uuid> or similar g-agent patterns
  const gAgentMatch = sessionKey.match(/^(?:g-agent-|g_agent-)([^-_.]+)/i);
  if (gAgentMatch && gAgentMatch[1]) {
    return gAgentMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Check if the authenticated user owns (or has access to) a session.
 *
 * @param {object} req - Express request object with `user` populated by passport.
 * @param {string} sessionKey - The session key being accessed.
 * @param {string} authMode - One of 'none', 'local', 'oidc'.
 * @returns {boolean} - true if the user is authorized to access this session.
 */
function checkSessionOwnership(req, sessionKey, authMode) {
  // No auth mode: everything is accessible
  if (authMode === 'none') return true;

  // Must be authenticated
  if (!req.user || !req.isAuthenticated?.()) return false;

  const owner = extractSessionOwner(sessionKey);
  if (!owner) {
    // Unknown session key format — deny by default for safety.
    // This catches any session key that doesn't follow the known patterns.
    // In future, this could be relaxed if the Gateway provides explicit
    // ownership metadata per session.
    return false;
  }

  // Local auth: match username
  if (authMode === 'local') {
    const userIdentifier = String(req.user.username || '').toLowerCase().trim();
    return userIdentifier === owner.toLowerCase();
  }

  // OIDC: match email or preferred_username against session key owner
  if (authMode === 'oidc') {
    const email = String(req.user.email || '').toLowerCase().trim();
    const username = String(req.user.username || '').toLowerCase().trim();
    return (
      email.includes(owner.toLowerCase()) ||
      username === owner.toLowerCase()
    );
  }

  // Unknown auth mode: deny by default
  return false;
}

/**
 * Express middleware factory for session authorization.
 *
 * Usage:
 *   app.get('/api/sessions/:key/history',
 *     isAuthenticated,
 *     requireSessionOwnership(authMode),
 *     handler
 *   );
 *
 * @param {string} authMode - The current auth mode from server.js.
 * @returns {function} Express middleware function.
 */
function requireSessionOwnership(authMode) {
  return function sessionOwnershipMiddleware(req, res, next) {
    // Extract session key from URL params or query/body
    let sessionKey = null;

    if (req.params && req.params.key) {
      sessionKey = String(req.params.key).trim();
    } else if (req.query && typeof req.query.sessionKey === 'string') {
      sessionKey = req.query.sessionKey.trim();
    } else if (req.body && typeof req.body.sessionKey === 'string') {
      sessionKey = req.body.sessionKey.trim();
    }

    // If no session key is provided, skip authorization (route doesn't target a specific session)
    if (!sessionKey) return next();

    if (!checkSessionOwnership(req, sessionKey, authMode)) {
      return res.status(403).json({
        error: 'Forbidden: you do not have access to this session',
      });
    }

    return next();
  };
}

module.exports = { checkSessionOwnership, requireSessionOwnership, extractSessionOwner };

/**
 * Session access boundary.
 *
 * OpenClaw session keys use `agent:<agent-id>:<session-id>`. The agent ID is
 * not a web username, and OpenClaw does not expose per-user ownership metadata.
 * Miso Chat therefore authorizes session operations at the deployment boundary:
 * every authenticated web user can access the same sessions returned by the
 * authenticated `/api/sessions` endpoint.
 *
 * This is intentional, not a bug: there is no per-user session isolation. See
 * SECURITY.md#authentication-model for the full authorization model and the
 * consequences for OIDC deployments that mint more than one human user.
 */

function checkSessionAccess(req, authMode) {
  if (authMode === 'none') return true;
  if (authMode !== 'local' && authMode !== 'oidc') return false;
  return Boolean(req.user && req.isAuthenticated?.());
}

function requireSessionAccess(authMode) {
  return function sessionAccessMiddleware(req, res, next) {
    if (!checkSessionAccess(req, authMode)) {
      return res.status(403).json({
        error: 'Forbidden: authenticated session access required',
      });
    }

    return next();
  };
}

module.exports = { checkSessionAccess, requireSessionAccess };

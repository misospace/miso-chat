// Lightweight security middleware for miso-chat.
// Provides baseline security headers + per-session CSRF tokens + origin checks
// for state-changing browser requests.

const crypto = require('crypto');

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw === 'null') return 'null';

  try {
    const parsed = new URL(raw);
    if (parsed.origin && parsed.origin !== 'null') {
      return parsed.origin.toLowerCase();
    }

    // URL.origin is "null" for custom schemes (capacitor://, ionic://, app://).
    if (parsed.protocol && parsed.host) {
      return `${parsed.protocol}//${parsed.host}`.toLowerCase();
    }

    return '';
  } catch {
    return '';
  }
}

function loadAllowedOrigins() {
  const defaults = [
    'http://localhost',
    'https://localhost',
    'http://127.0.0.1',
    'https://127.0.0.1',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'capacitor://localhost',
    'ionic://localhost',
    'app://localhost',
    'null',
  ];

  const configured = [
    process.env.CORS_ORIGIN,
    process.env.ALLOWED_ORIGINS,
    process.env.CSRF_TRUSTED_ORIGINS,
  ]
    .filter(Boolean)
    .flatMap((value) => String(value).split(','));

  const allowed = new Set();
  for (const origin of [...defaults, ...configured]) {
    const normalized = normalizeOrigin(origin);
    if (normalized) allowed.add(normalized);
  }

  return allowed;
}

const allowedOrigins = loadAllowedOrigins();

function getRequestOrigin(req) {
  const origin = normalizeOrigin(req.get('origin'));
  if (origin) return origin;

  const referer = req.get('referer');
  if (!referer) return '';

  try {
    return new URL(referer).origin.toLowerCase();
  } catch {
    return '';
  }
}

function getServerOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.get('host') || '';

  return normalizeOrigin(`${protocol}://${host}`);
}

/**
 * NOTE: CSP is set dynamically in securityHeaders().
 * Since index.html is served as a static file (no template rendering),
 * nonce-based inline script restriction is not feasible.
 * 'unsafe-inline' is used for script-src to allow inline scripts.
 */

// ---------------------------------------------------------------------------
// CSRF Token system — route-level per-session tokens for browser clients.
// ---------------------------------------------------------------------------

const CSRF_TOKEN_LENGTH = 32; // bytes → 64 hex chars

/**
 * Generate a cryptographically random CSRF token and store it in the session.
 * Returns the token string.
 */
function generateCsrfToken(req) {
  if (!req.session) return null;
  const token = crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');
  req.session.csrfToken = token;
  return token;
}

/**
 * Check whether a request appears to be from a browser (has Origin or Referer).
 * Non-browser callers (mobile apps, API clients) typically omit these headers.
 */
function isBrowserRequest(req) {
  const origin = req.get('origin');
  const referer = req.get('referer');
  return Boolean(origin || referer);
}

/**
 * Frontend integration notes:
 * - The frontend MUST fetch a fresh CSRF token on page load via GET /api/csrf-token.
 * - The frontend MUST include the token in the X-CSRF-Token header for all
 *   state-changing browser requests (POST/PUT/PATCH/DELETE).
 * - After each successful state-changing request, the server rotates the token.
 *   The frontend should either:
 *   (a) Fetch a new token before each state-changing request, or
 *   (b) Handle 403 responses by fetching a fresh token and retrying.
 * - Non-browser callers (mobile apps, API clients) are exempt — they use other auth.
 * - If no csrfToken exists in the session yet (e.g., before first /api/csrf-token call),
 *   the check is skipped to avoid blocking unauthenticated requests.
 */
/**
 * CSRF token validation middleware for state-changing requests from browsers.
 *
 * - Skipped entirely for non-browser callers (no Origin/Referer) — they use
 *   other auth mechanisms (session cookies, mobile auth tokens, etc.).
 * - For browser requests on POST/PUT/PATCH/DELETE, requires the `X-CSRF-Token`
 *   header to match the current per-session token.
 * - On success, rotates the token (old token is invalidated).
 */
function csrfTokenCheck(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  // Skip CSRF check for non-browser callers (mobile apps, API clients, etc.).
  // These use session cookies or mobile auth tokens as their primary auth.
  if (!isBrowserRequest(req)) {
    return next();
  }

  // Must have a session to validate CSRF tokens.
  if (!req.session || !req.session.csrfToken) {
    return next();
  }

  const providedToken = String(req.get('x-csrf-token') || '').trim();

  if (!providedToken) {
    return res.status(403).json({
      error: 'Forbidden: CSRF token required',
      detail: 'State-changing browser requests require an X-CSRF-Token header.',
    });
  }

  // Constant-time comparison to prevent timing attacks.
  const expected = req.session.csrfToken;
  if (providedToken.length !== expected.length) {
    return res.status(403).json({
      error: 'Forbidden: invalid CSRF token',
    });
  }

  let match = true;
  for (let i = 0; i < providedToken.length; i++) {
    // eslint-disable-next-line no-bitwise
    match &= providedToken.charCodeAt(i) === expected.charCodeAt(i);
  }

  if (!match) {
    return res.status(403).json({
      error: 'Forbidden: invalid CSRF token',
    });
  }

  // Rotate the token after successful validation.
  req.session.csrfToken = crypto.randomBytes(CSRF_TOKEN_LENGTH).toString('hex');

  next();
}

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    `style-src 'self' 'unsafe-inline'`,
    "script-src 'self' 'unsafe-inline'",
    "connect-src 'self' ws: wss:",
    "form-action 'self'",
  ].join('; '));
  next();
}

function csrfOriginCheck(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return next();
  }

  const requestOrigin = getRequestOrigin(req);

  // Allow non-browser callers (no origin/referer).
  if (!requestOrigin) {
    return next();
  }

  const serverOrigin = getServerOrigin(req);
  if (requestOrigin === serverOrigin || allowedOrigins.has(requestOrigin)) {
    return next();
  }

  return res.status(403).json({
    error: 'Forbidden: untrusted request origin',
  });
}

module.exports = [securityHeaders, csrfTokenCheck, csrfOriginCheck];
module.exports.generateCsrfToken = generateCsrfToken;

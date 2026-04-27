// Lightweight security middleware for miso-chat.
// Provides baseline security headers + CSRF origin checks for state-changing requests.

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

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline'",
  "connect-src 'self' ws: wss:",
  "form-action 'self'",
].join('; ');

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

function generateNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function securityHeaders(req, res, next) {
  const nonce = generateNonce();
  if (res.locals) res.locals.cspNonce = nonce;
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
    `script-src 'self' 'nonce-${nonce}'`,
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

module.exports = [securityHeaders, csrfOriginCheck];

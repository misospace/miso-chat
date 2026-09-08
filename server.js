const express = require('express');
const session = require('express-session');
const http = require('http');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { buildRateLimitKey } = require('./lib/trusted-proxies');
const cors = require('cors');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require("dns");
const net = require('net');
require('dotenv').config();

const { GatewayWsManager } = require('./lib/gateway-ws');
const securityMiddleware = require('./security');
const { reactions } = require('./lib/db');
const { requireSessionAccess } = require('./lib/session-auth');
const { createReactionsRoutes } = require('./lib/routes/reactions');

const { isForbiddenLinkPreviewHost, isForbiddenLinkPreviewAddress } = require('./lib/ssrf-validation');
const { validateManifest } = require('./lib/mobile-manifest-validator');
const { buildSessionConfig, setupPassport, registerAuthRoutes, buildIsAuthenticated, getOidcLabel, getReturnTo } = require('./lib/auth-session');

const app = express();
const server = http.createServer(app);

const oidcEnabledByEnv = process.env.OIDC_ENABLED === 'true';
const localAuthEnabledByEnv = process.env.LOCAL_AUTH_ENABLED !== 'false';
const explicitAuthMode = String(process.env.AUTH_MODE || '').trim().toLowerCase();
const authMode = (() => {
  if (explicitAuthMode === 'none' || explicitAuthMode === 'local' || explicitAuthMode === 'oidc') {
    return explicitAuthMode;
  }
  if (oidcEnabledByEnv) return 'oidc';
  if (localAuthEnabledByEnv) return 'local';
  return 'none';
})();
const oidcEnabled = authMode === 'oidc';
const localAuthEnabled = authMode === 'local';
const MAX_CHAT_MESSAGE_LENGTH = (() => {
  const parsed = Number(process.env.MAX_CHAT_MESSAGE_LENGTH || 4000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4000;
})();
const APP_VERSION = (() => {
  if (typeof process.env.APP_VERSION === 'string' && process.env.APP_VERSION.trim()) {
    return process.env.APP_VERSION.trim();
  }

  try {
    const pkg = require('./package.json');
    if (typeof pkg?.version === 'string' && pkg.version.trim()) {
      return pkg.version.trim();
    }
  } catch (error) {
    console.warn('Unable to resolve app version from package.json:', error.message);
  }

  return 'unknown';
})();
const CHAT_DISPLAY_NAME = process.env.CHAT_DISPLAY_NAME || process.env.ASSISTANT_NAME || 'Miso';
const APP_TITLE = process.env.APP_TITLE || `${CHAT_DISPLAY_NAME} Chat`;
const DEFAULT_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || process.env.MISO_CHAT_SESSION_KEY || process.env.DEFAULT_SESSION_KEY || 'agent:main:main';
const PUSH_NOTIFICATIONS_ENABLED = process.env.PUSH_NOTIFICATIONS_ENABLED === 'true';
const PUSH_VAPID_PUBLIC_KEY = String(process.env.PUSH_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '').trim();

const LINK_PREVIEW_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_TIMEOUT_MS || 5000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();
const LINK_PREVIEW_MAX_HTML_CHARS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_MAX_HTML_CHARS || 250000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 250000;
})();
const LINK_PREVIEW_USER_AGENT =
  process.env.LINK_PREVIEW_USER_AGENT ||
  `miso-chat-link-preview/${APP_VERSION} (+https://github.com/misospace/miso-chat)`;

// Per-phase timeout controls for link preview fetches (stricter than overall timeout)
const LINK_PREVIEW_DNS_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_DNS_TIMEOUT_MS || 3000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3000;
})();
const LINK_PREVIEW_CONNECT_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_CONNECT_TIMEOUT_MS || 5000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5000;
})();
const LINK_PREVIEW_HEADERS_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_HEADERS_TIMEOUT_MS || 10000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10000;
})();
const LINK_PREVIEW_BODY_READ_TIMEOUT_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_BODY_READ_TIMEOUT_MS || 30000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
})();

// Bounded in-memory cache for link preview results (process-level, not shared across instances).
const LINK_PREVIEW_CACHE_MAX_SIZE = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_CACHE_MAX_SIZE || 256);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 256;
})();
const LINK_PREVIEW_CACHE_TTL_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_CACHE_TTL_MS || 300000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
})();

// Per-host concurrency limit for link preview fetches (prevents DNS/network saturation)
const LINK_PREVIEW_MAX_CONCURRENT_PER_HOST = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_MAX_CONCURRENT_PER_HOST || 2);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 2;
})();

// Jittered retry on 5xx for link preview fetches
const LINK_PREVIEW_RETRY_MAX_ATTEMPTS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_RETRY_MAX_ATTEMPTS || 2);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 2;
})();
const LINK_PREVIEW_RETRY_BASE_DELAY_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_RETRY_BASE_DELAY_MS || 200);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 200;
})();
const LINK_PREVIEW_RETRY_MAX_DELAY_MS = (() => {
  const parsed = Number(process.env.LINK_PREVIEW_RETRY_MAX_DELAY_MS || 1000);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
})();

const { PreviewCache, PreviewCoalescer, HostConcurrencyLimiter } = require('./lib/link-preview-cache');
const linkPreviewCache = new PreviewCache({ maxSize: LINK_PREVIEW_CACHE_MAX_SIZE, ttlMs: LINK_PREVIEW_CACHE_TTL_MS });
const linkPreviewCoalescer = new PreviewCoalescer();
const linkPreviewHostLimiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: LINK_PREVIEW_MAX_CONCURRENT_PER_HOST });

// Periodic cache cleanup (every 60 seconds) — prevents unbounded memory growth from expired entries.
setInterval(() => {
  const removed = linkPreviewCache.cleanup();
  if (removed > 0) console.debug(`Link preview cache cleaned up ${removed} expired entries`);
  const stats = linkPreviewCache.stats();
  console.debug(`Link preview cache: ${stats.activeCount}/${stats.maxSize} active, ${stats.expiredCount} expired`);
}, 60_000).unref?.();

// Mobile OTA update configuration
const MOBILE_UPDATE_REPO_OWNER = process.env.MOBILE_UPDATE_REPO_OWNER || "misospace";
const MOBILE_UPDATE_REPO_NAME = process.env.MOBILE_UPDATE_REPO_NAME || "miso-chat";
const MOBILE_UPDATE_GITHUB_API_URL = "https://api.github.com";
const MOBILE_UPDATE_CACHE_TTL_MS = Number(process.env.MOBILE_UPDATE_CACHE_TTL_MS || 300000); // 5 min default
// In-memory cache: process-level only (not shared across multiple server instances behind LB).
// Each instance maintains its own mobileUpdateCache and TTL independently, so multi-instance
// deployments can serve stale manifests for up to MOBILE_UPDATE_CACHE_TTL_MS (default 5 min).
// For multi-instance deployments, consider using a Redis-backed cache for this path.
let mobileUpdateCache = null;
let mobileUpdateCacheTime = 0;

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function normalizePreviewText(value) {
  return decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
}

function parseTagAttributes(tag) {
  const attributes = {};
  const attrRegex = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match;
  while ((match = attrRegex.exec(tag)) !== null) {
    const key = String(match[1] || '').toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    if (key && !(key in attributes)) {
      attributes[key] = value;
    }
  }
  return attributes;
}

function resolveRelativeUrl(candidate, baseUrl) {
  if (!candidate) return '';
  try {
    return new URL(candidate, baseUrl).toString();
  } catch {
    return '';
  }
}

function extractLinkPreviewData(html, pageUrl) {
  const metaMap = new Map();
  const metaRegex = /<meta\s+[^>]*>/gi;
  let metaMatch;

  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const attrs = parseTagAttributes(metaMatch[0]);
    const key = String(attrs.property || attrs.name || '').toLowerCase().trim();
    const rawContent = attrs.content;
    if (!key || !rawContent || metaMap.has(key)) continue;
    const normalized = normalizePreviewText(rawContent);
    if (normalized) metaMap.set(key, normalized);
  }

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleFromTag = titleMatch ? normalizePreviewText(titleMatch[1]) : '';

  const canonicalUrl =
    resolveRelativeUrl(metaMap.get('og:url') || '', pageUrl)
    || pageUrl;

  const imageUrl =
    resolveRelativeUrl(metaMap.get('og:image') || '', canonicalUrl)
    || resolveRelativeUrl(metaMap.get('twitter:image') || '', canonicalUrl)
    || '';

  const title =
    metaMap.get('og:title')
    || metaMap.get('twitter:title')
    || titleFromTag;

  const description =
    metaMap.get('og:description')
    || metaMap.get('twitter:description')
    || metaMap.get('description')
    || '';

  let domain = '';
  try {
    domain = new URL(canonicalUrl).hostname;
  } catch {
    domain = '';
  }

  return {
    url: canonicalUrl,
    title,
    description,
    image: imageUrl,
    domain,
    twitterCard: metaMap.get('twitter:card') || '',
  };
}

// SSE clients for real-time gateway event forwarding
const sseClients = new Set();

// NOTE: `app.set('trust proxy', ...)` is intentionally NOT set. Trusting one
// hop of forwarded headers from any peer would let a direct client on port
// 3000 spoof req.protocol / req.ip / req.get('host'). Forwarded headers are
// instead honored per-request, only when the TCP peer is on the
// TRUSTED_PROXY_IPS allowlist, via lib/trusted-proxies.js (buildRateLimitKey,
// safeProtocol, safeHost).

const configuredCorsOrigins = String(process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

const defaultCorsOrigins = [
  'capacitor://localhost',
  'ionic://localhost',
  'app://localhost',
  'http://localhost',
  'https://localhost',
  'http://127.0.0.1',
  'https://127.0.0.1',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'null',
];

const allowedCorsOrigins = new Set([
  ...defaultCorsOrigins,
  ...configuredCorsOrigins,
]);

// Enable CORS for frontend connection
const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin/server-to-server requests with no Origin header.
    if (!origin) return callback(null, true);

    if (allowedCorsOrigins.has(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
};
app.use(cors(corsOptions));

// Apply security middleware
securityMiddleware.forEach(middleware => app.use(middleware));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Forwarded headers are only honored when the TCP peer is on the
    // TRUSTED_PROXY_IPS allowlist (see lib/trusted-proxies). With the
    // default empty allowlist we fall back to req.socket.remoteAddress so
    // a client cannot mint new rate-limit buckets by rotating
    // cf-connecting-ip / x-forwarded-for per request.
    return ipKeyGenerator(buildRateLimitKey(req));
  },
  skip: (req) => {
    // Never rate-limit realtime/bootstrap reads; this can deadlock the UI.
    if (req.path === '/events' || req.path === '/health' || req.path === '/config' || req.path === '/auth') {
      return true;
    }

    // Session list/history bootstrap calls are read-paths and must stay available.
    if (req.method === 'GET' && (req.path === '/sessions' || req.path.startsWith('/sessions/'))) {
      return true;
    }

    return false;
  },
  message: { error: 'Too many requests, please try again later.' },
});

const sseLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Forwarded headers are only honored when the TCP peer is on the
    // TRUSTED_PROXY_IPS allowlist (see lib/trusted-proxies). With the
    // default empty allowlist we fall back to req.socket.remoteAddress so
    // a client cannot mint new rate-limit buckets by rotating
    // cf-connecting-ip / x-forwarded-for per request.
    return ipKeyGenerator(buildRateLimitKey(req));
  },
  message: { error: 'Too many SSE connections, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Forwarded headers are only honored when the TCP peer is on the
    // TRUSTED_PROXY_IPS allowlist (see lib/trusted-proxies). With the
    // default empty allowlist we fall back to req.socket.remoteAddress so
    // a client cannot mint new rate-limit buckets by rotating
    // cf-connecting-ip / x-forwarded-for per request.
    return ipKeyGenerator(buildRateLimitKey(req));
  },
  skip: () => {
    // Skip for auth modes that don't use local auth
    return !localAuthEnabled;
  },
  message: { error: 'Too many authentication attempts, please try again later.' },
});
app.use('/api/', limiter);

// Middleware
app.use(express.json({ limit: '10kb', type: 'application/json' }));
app.use(express.urlencoded({ extended: false, limit: '1kb', type: 'application/x-www-form-urlencoded' }));

// Validate Content-Type for POST/PUT/PATCH requests
const validateContentType = require('./lib/middleware/validate-content-type');
app.use(validateContentType);

// Protect direct access to index file
app.use((req, res, next) => {
  if (req.path === '/index.html' && !req.isAuthenticated?.()) {
    return res.redirect('/login');
  }
  next();
});

// Serve static assets, but do NOT auto-serve /index.html at root (keeps auth gate on /)
app.use(express.static('public', { index: false }));

// /lib is intentionally NOT mounted onto the server-side lib/ directory. The
// browser-served modules (api-client, capacitor-detect, reaction-events-browser,
// render-utils, secure-storage, session-key-hydration) live under public/lib/
// and are served by the `express.static('public')` handler above. The server-only
// modules in lib/ (auth-session, db, ssrf-validation, etc.) must never be
// reachable unauthenticated. See #782.
// Session configuration (delegated to lib/auth-session.js)
const sessionConfig = buildSessionConfig({ authMode });

const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);

// Passport initialization and strategy setup (delegated to lib/auth-session.js)
const passportInstance = setupPassport({ localAuthEnabled });
app.use(passportInstance.initialize());
app.use(passportInstance.session());

// Auth helpers and routes (delegated to lib/auth-session.js)
const isAuthenticated = buildIsAuthenticated(authMode);
registerAuthRoutes(app, { authMode, localAuthEnabled, oidcEnabled, authLimiter });

// GET /api/mobile/update-manifest - Serve update manifest from latest GitHub release (hardened)
app.get("/api/mobile/update-manifest", async (req, res) => {
  const now = Date.now();
  if (
    mobileUpdateCache
    && mobileUpdateCacheTime
    && (now - mobileUpdateCacheTime) < MOBILE_UPDATE_CACHE_TTL_MS
  ) {
    return res.json(mobileUpdateCache);
  }

  try {
    const resp = await fetch(
      `${MOBILE_UPDATE_GITHUB_API_URL}/repos/${MOBILE_UPDATE_REPO_OWNER}/${MOBILE_UPDATE_REPO_NAME}/releases/latest`,
      { headers: { "Accept": "application/vnd.github.v3+json", "User-Agent": `miso-chat-update/${APP_VERSION}` } },
    );
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "Failed to fetch latest release" });
    }
    const release = await resp.json();
    const manifestAsset = (release.assets || []).find((a) => a.name === "update-manifest.json");
    if (!manifestAsset) {
      return res.status(404).json({ error: "update-manifest.json not found in latest release" });
    }
    const manifestResp = await fetch(manifestAsset.browser_download_url, { headers: { Accept: "application/json" } });
    if (!manifestResp.ok) {
      return res.status(manifestResp.status).json({ error: "Failed to fetch update manifest" });
    }
    const manifest = await manifestResp.json();

    // Validate manifest before serving — schema, tag consistency, asset host trust
    const validation = validateManifest(manifest, {
      releaseTagName: release.tag_name,
      repoOwner: MOBILE_UPDATE_REPO_OWNER,
      repoName: MOBILE_UPDATE_REPO_NAME,
    });
    if (!validation.valid) {
      console.error("Mobile update manifest validation failed:", validation.errors);
      return res.status(400).json({ error: "Invalid update manifest", details: validation.errors });
    }

    mobileUpdateCache = manifest;
    mobileUpdateCacheTime = now;
    return res.json(manifest);
  } catch (error) {
    console.error("Mobile update manifest fetch failed:", error.message || error);
    return res.status(502).json({ error: "Unable to retrieve update manifest" });
  }
});


// Protected routes
app.get('/', isAuthenticated, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/api/auth', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    authenticated: authMode === 'none' ? true : req.isAuthenticated(),
    user: req.user,
    oidc: oidcEnabled,
    authMode,
    requiresAuth: authMode !== 'none',
  });
});


// GET /api/csrf-token — Return current per-session CSRF token (generate if missing).
app.get('/api/csrf-token', isAuthenticated, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const { generateCsrfToken } = require('./security');
  const token = generateCsrfToken(req);
  return res.json({ csrfToken: token });
});

let gatewayWsLastError = '';
let gatewayWsLastClose = null;
const GATEWAY_WS_CLIENT_ID = process.env.GATEWAY_WS_CLIENT_ID || 'webchat-ui';
const GATEWAY_WS_CLIENT_MODE = process.env.GATEWAY_WS_CLIENT_MODE || 'webchat';
const GATEWAY_DEVICE_IDENTITY_PATH = process.env.GATEWAY_DEVICE_IDENTITY_PATH || path.join(process.env.HOME || '/home/node', '.openclaw', 'identity', 'device.json');
const GATEWAY_WS_WAIT_CHALLENGE_MS = Number(process.env.GATEWAY_WS_WAIT_CHALLENGE_MS || 1200);
// Minimal default scopes for normal chat/session UI behavior.
// Admin and pairing scopes require explicit opt-in via GATEWAY_ADMIN_SCOPES.
const REQUESTED_GATEWAY_SCOPES = [
  'operator.read',
  'operator.write',
  ...(process.env.GATEWAY_ADMIN_SCOPES === 'true'
    ? ['operator.admin', 'operator.pairing']
    : []),
];
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
let cachedGatewayDeviceIdentity = null;

function base64UrlEncode(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function derivePublicKeyRawFromPem(publicKeyPem) {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  if (spki.length === ED25519_SPKI_PREFIX.length + 32 && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function buildDeviceAuthPayload({ deviceId, clientId, clientMode, role, scopes, signedAtMs, token, nonce }) {
  const scopesList = Array.isArray(scopes) ? scopes : [];
  return ['v2', deviceId, clientId, clientMode, role, scopesList.join(','), String(signedAtMs), token || '', nonce].join('|');
}

function fingerprintPublicKeyPem(publicKeyPem) {
  const raw = derivePublicKeyRawFromPem(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function persistGatewayDeviceIdentity(identity) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_DEVICE_IDENTITY_PATH), { recursive: true });
    fs.writeFileSync(GATEWAY_DEVICE_IDENTITY_PATH, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    try { fs.chmodSync(GATEWAY_DEVICE_IDENTITY_PATH, 0o600); } catch {}
  } catch {}
}

function ensureGatewayDeviceIdentity() {
  if (cachedGatewayDeviceIdentity !== null) return cachedGatewayDeviceIdentity;

  try {
    if (fs.existsSync(GATEWAY_DEVICE_IDENTITY_PATH)) {
      const raw = fs.readFileSync(GATEWAY_DEVICE_IDENTITY_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.deviceId && parsed?.publicKeyPem && parsed?.privateKeyPem) {
        const derivedDeviceId = fingerprintPublicKeyPem(parsed.publicKeyPem);
        const publicKey = base64UrlEncode(derivePublicKeyRawFromPem(parsed.publicKeyPem));
        const deviceId = typeof derivedDeviceId === 'string' && derivedDeviceId ? derivedDeviceId : parsed.deviceId;
        if (deviceId !== parsed.deviceId) {
          persistGatewayDeviceIdentity({
            ...parsed,
            version: parsed?.version === 1 ? parsed.version : 1,
            deviceId,
            createdAtMs: typeof parsed?.createdAtMs === 'number' ? parsed.createdAtMs : Date.now(),
          });
        }
        cachedGatewayDeviceIdentity = { deviceId, publicKey, privateKeyPem: parsed.privateKeyPem };
        return cachedGatewayDeviceIdentity;
      }
    }
  } catch {}

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKeyPem(publicKeyPem);
  const identity = { version: 1, deviceId, publicKeyPem, privateKeyPem, createdAtMs: Date.now() };
  persistGatewayDeviceIdentity(identity);
  cachedGatewayDeviceIdentity = { deviceId, publicKey: base64UrlEncode(derivePublicKeyRawFromPem(publicKeyPem)), privateKeyPem };
  return cachedGatewayDeviceIdentity;
}

function buildGatewayDeviceAuth({ nonce, scopes }) {
  const identity = ensureGatewayDeviceIdentity();
  if (!identity || !nonce) return null;
  const signedAt = Date.now();
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId: GATEWAY_WS_CLIENT_ID,
    clientMode: GATEWAY_WS_CLIENT_MODE,
    role: 'operator',
    scopes,
    signedAtMs: signedAt,
    token: GATEWAY_TOKEN,
    nonce,
  });
  const signature = base64UrlEncode(crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem)));
  return { id: identity.deviceId, publicKey: identity.publicKey, signature, signedAt, nonce };
}
// Infer GATEWAY_WS_ORIGIN from CORS_ORIGIN if not explicitly set
const configuredGatewayWsOrigin = process.env.GATEWAY_WS_ORIGIN;
const corsOrigin = process.env.CORS_ORIGIN || process.env.ALLOWED_ORIGINS || '';
const firstCorsOrigin = corsOrigin.split(',')[0].trim();
const gatewayWsOrigin = configuredGatewayWsOrigin || firstCorsOrigin || 'http://localhost:3000';
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.OPENCLAW_API_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '';
// Timeout for the gatewayInvoke() HTTP fallback. Must be short enough that a stalled
// gateway doesn't hold client requests open indefinitely. Default 12s sits between the
// WS path's 10s (sessions.list) and 30s (chat.send) timeouts.
const GATEWAY_INVOKE_TIMEOUT_MS = (() => {
  const raw = process.env.GATEWAY_INVOKE_TIMEOUT_MS;
  if (raw == null || raw === '') return 12000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 12000;
  return Math.floor(parsed);
})();
const gatewayWsManager = new GatewayWsManager({
  wsUrl: process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789',
  clientId: GATEWAY_WS_CLIENT_ID,
  clientVersion: `miso-chat/${APP_VERSION}`,
  clientMode: GATEWAY_WS_CLIENT_MODE,
  token: GATEWAY_TOKEN,
  role: 'operator',
  scopes: REQUESTED_GATEWAY_SCOPES,
  waitChallengeMs: GATEWAY_WS_WAIT_CHALLENGE_MS,
  buildDeviceAuth: ({ nonce, scopes }) => buildGatewayDeviceAuth({ nonce, scopes }),
  headers: {
    ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    ...(gatewayWsOrigin ? { Origin: gatewayWsOrigin } : {}),
  },
});
gatewayWsManager.on('error', (err) => {
  gatewayWsLastError = String(err?.message || err || 'unknown error');
  console.error('⚠️ Gateway WS error:', err?.message || err);
});

const {
  gatewaySessionSubscriptions,
  noteGatewaySessionSubscription,
  pruneIdleGatewaySessionSubscriptions: _pruneIdleGatewaySessionSubscriptions,
  GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS,
} = require('./lib/gateway-session-subscriptions');
const activeGatewaySessionSubscriptions = new Set();
let gatewaySessionsSubscriptionActive = false;
let gatewaySessionsSubscriptionPromise = null;

// Prune idle gateway session subscriptions (see #811). The Set and its
// last-seen timestamps are owned by lib/gateway-session-subscriptions.js; this
// wrapper additionally drops any pruned key from activeGatewaySessionSubscriptions
// so the reconnect handler doesn't re-subscribe stale sessions.
function pruneIdleGatewaySessionSubscriptions(now = Date.now()) {
  const pruned = _pruneIdleGatewaySessionSubscriptions(now);
  if (pruned > 0) {
    for (const key of activeGatewaySessionSubscriptions) {
      if (!gatewaySessionSubscriptions.has(key)) activeGatewaySessionSubscriptions.delete(key);
    }
  }
  return pruned;
}

const GATEWAY_SESSION_SUBSCRIPTION_PRUNE_INTERVAL_MS = 60 * 1000;
setInterval(() => {
  pruneIdleGatewaySessionSubscriptions();
}, GATEWAY_SESSION_SUBSCRIPTION_PRUNE_INTERVAL_MS).unref();

async function subscribeToGatewaySessions() {
  if (!gatewayWsManager?.isConnected?.() || gatewaySessionsSubscriptionActive) return;
  if (gatewaySessionsSubscriptionPromise) return gatewaySessionsSubscriptionPromise;

  gatewaySessionsSubscriptionPromise = (async () => {
    try {
      await gatewayWsManager.send('sessions.subscribe', {}, 10);
      gatewaySessionsSubscriptionActive = true;
    } catch (error) {
      console.warn('Gateway session subscription failed:', error.message || error);
    } finally {
      gatewaySessionsSubscriptionPromise = null;
    }
  })();

  return gatewaySessionsSubscriptionPromise;
}

async function subscribeToGatewaySession(sessionKey) {
  const key = String(sessionKey || '').trim();
  if (!key || !gatewayWsManager?.isConnected?.()) return;
  noteGatewaySessionSubscription(key);
  await subscribeToGatewaySessions();
  if (activeGatewaySessionSubscriptions.has(key)) return;

  try {
    await gatewayWsManager.send('sessions.messages.subscribe', { key }, 10);
    activeGatewaySessionSubscriptions.add(key);
  } catch (error) {
    console.warn(`Gateway message subscription failed for ${key}:`, error.message || error);
  }
}

async function waitForGatewayWsReady(timeoutMs = 1500) {
  if (gatewayWsManager?.isConnected?.()) return true;

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gatewayWsManager?.off?.('connected', onConnected);
      gatewayWsManager?.off?.('error', onError);
      resolve();
    };
    const onConnected = () => done();
    const onError = () => done();
    const timer = setTimeout(done, Math.max(50, timeoutMs));
    gatewayWsManager?.once?.('connected', onConnected);
    gatewayWsManager?.once?.('error', onError);
  });

  return gatewayWsManager?.isConnected?.() || false;
}

app.get('/api/health', (req, res) => {
  const isWsConnected = gatewayWsManager?.isConnected?.() || false;
  const reconnectAttempts = gatewayWsManager?.reconnectAttempts || 0;
  const pendingRequests = gatewayWsManager?.getPendingRequestCount?.() || 0;
  const pendingForRecovery = gatewayWsManager?.getPendingForRecoveryCount?.() || 0;

  // Determine realtime health state
  let realtimeState = 'disconnected';
  if (isWsConnected) {
    realtimeState = 'healthy';
  } else if (reconnectAttempts > 0) {
    realtimeState = 'reconnecting';
  } else if (gatewayWsLastError) {
    realtimeState = 'degraded';
  }

  const healthPayload = {
    status: 'healthy',
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    gatewayWs: {
      connected: isWsConnected,
      connecting: gatewayWsManager?.connecting || false,
      reconnectAttempts,
      pendingRequests,
      pendingForRecovery,
      lastError: gatewayWsLastError || null,
      lastClose: gatewayWsLastClose || null,
    },
    realtime: {
      state: realtimeState,
      message: isWsConnected
        ? 'Gateway WebSocket connected'
        : reconnectAttempts > 0
          ? `Reconnecting (attempt ${reconnectAttempts})`
          : gatewayWsLastError
            ? `Error: ${gatewayWsLastError}`
            : 'Gateway WebSocket not connected',
    },
  };

  res.json(healthPayload);
});


function extractTextParts(parts) {
  return (Array.isArray(parts) ? parts : [])
    .map((part) => {
      if (typeof part === 'string') return stripInternalAssistantText(part);
      if (!part || typeof part !== 'object') return '';
      // Gateways use several spellings for these internal messages. Never
      // surface their arguments or results as though they were chat text.
      const type = String(part.type || '').replace(/[\s_-]/g, '').toLowerCase();
      if (type === 'toolcall' || type === 'toolresult' || type === 'tooluse' || type === 'functioncall' || type === 'functionresult') return '';
      if (type === 'thinking' || type === 'reasoning' || type === 'analysis' || type === 'assistantthinking') return '';
      if (part?.type === 'text' && typeof part?.text === 'string') return stripInternalAssistantText(part.text);
      if (typeof part?.text === 'string') return stripInternalAssistantText(part.text);
      if (typeof part?.content === 'string') return stripInternalAssistantText(part.content);
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function stripInternalAssistantText(value) {
  return String(value || '')
    .replace(/<(?:thinking|reasoning|analysis|assistant[_-]?thinking)>[\s\S]*?<\/(?:thinking|reasoning|analysis|assistant[_-]?thinking)>/gi, '')
    .replace(/(?:^|\n)\s*(?:OpenClaw|Codex)\s+needs\s+input\s*:[^\n]*(?:\n\s*(?!\d+[.)]\s+)[^\n]+)?(?:\n\s*\d+[.)]\s+[^\n]*)*\s*/gi, '\n')
    .trim();
}

function extractNeedsInputPrompt(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const match = value.match(/(?:^|\n)\s*(?:OpenClaw|Codex)\s+needs\s+input\s*:[\s\S]*/i);
    return match ? match[0].trim() : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const prompt = extractNeedsInputPrompt(item, depth + 1);
      if (prompt) return prompt;
    }
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['content', 'parts', 'message', 'response', 'responseText', 'text']) {
    const prompt = extractNeedsInputPrompt(value[key], depth + 1);
    if (prompt) return prompt;
  }
  return '';
}

function normalizeToolCallList(value) {
  const calls = Array.isArray(value) ? value : [];
  return calls.map((call) => {
    if (!call || typeof call !== 'object') return null;
    const name = String(call.name || call.toolName || call.tool || '').trim();
    if (!name) return null;

    const hasResult = Object.prototype.hasOwnProperty.call(call, 'result')
      || Object.prototype.hasOwnProperty.call(call, 'output');
    const result = call.result ?? call.output;
    const error = call.error ?? call.failure;
    const status = String(
      call.status
      || (error ? 'error' : (hasResult ? 'success' : 'calling'))
    ).trim();

    return {
      id: call.id || call.toolCallId || call.callId || null,
      name,
      arguments: call.arguments ?? call.input ?? call.args ?? '',
      ...(error !== undefined && error !== null ? { error } : {}),
      ...(hasResult ? { result } : {}),
      status,
    };
  }).filter(Boolean);
}

function extractStructuredToolCalls(value) {
  if (!value || typeof value !== 'object') return [];

  const direct = normalizeToolCallList(
    value.toolCalls
    || value.tool_calls
    || value.response?.toolCalls
    || value.response?.tool_calls,
  );
  if (direct.length > 0) return direct;

  const parts = Array.isArray(value.content)
    ? value.content
    : Array.isArray(value.parts)
      ? value.parts
      : [];
  if (parts.length === 0) return [];

  const calls = new Map();
  parts.forEach((part, index) => {
    if (!part || typeof part !== 'object') return;
    const type = String(part.type || '').replace(/[\s_-]/g, '').toLowerCase();
    const isCall = type === 'toolcall' || type === 'tooluse' || type === 'functioncall';
    const isResult = type === 'toolresult' || type === 'functionresult';
    if (!isCall && !isResult) return;

    const id = String(part.id || part.toolCallId || part.callId || `tool-${index}`);
    const existing = calls.get(id) || { id, name: '', arguments: '', status: 'calling' };
    const name = String(part.name || part.toolName || part.tool || existing.name || '').trim();
    if (name) existing.name = name;
    if (isCall) {
      existing.arguments = part.arguments ?? part.input ?? part.args ?? existing.arguments;
    }
    if (isResult) {
      if (part.error !== undefined && part.error !== null) {
        existing.error = part.error;
        existing.status = 'error';
      } else {
        existing.result = part.result ?? part.output ?? part.content ?? '';
        existing.status = 'success';
      }
    }
    calls.set(id, existing);
  });

  return [...calls.values()].filter((call) => call.name);
}

function extractThinkingText(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => {
      if (typeof item === 'string') return item.trim();
      if (!item || typeof item !== 'object') return '';
      const type = String(item.type || item.kind || '').replace(/[\s_-]/g, '').toLowerCase();
      const isThinkingBlock = ['thinking', 'reasoning', 'analysis', 'assistantthinking'].includes(type);
      const direct = item.thinking ?? item.reasoning ?? item.analysis ?? item.reasoningContent ?? item.reasoning_content;
      if (!isThinkingBlock && direct === undefined) return '';
      return extractThinkingText(direct ?? item.text ?? item.content, depth + 1);
    }).filter(Boolean))].join('\n').trim();
  }
  if (typeof value !== 'object') return '';

  for (const key of ['thinking', 'reasoning', 'analysis', 'reasoningContent', 'reasoning_content']) {
    if (value[key] !== undefined) {
      const text = extractThinkingText(value[key], depth + 1);
      if (text) return text;
    }
  }

  for (const key of ['content', 'parts', 'response', 'message']) {
    if (value[key] && typeof value[key] === 'object') {
      const text = extractThinkingText(value[key], depth + 1);
      if (text) return text;
    }
  }

  return '';
}

function mergeHistoryToolResults(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const isToolResultMessage = (message) => ['tool', 'toolresult'].includes(
    String(message?.role || '').replace(/[\s_-]/g, '').toLowerCase(),
  );
  const callsById = new Map();
  list.forEach((message) => {
    if (message?.role !== 'assistant') return;
    (Array.isArray(message.toolCalls) ? message.toolCalls : []).forEach((call) => {
      if (call?.id) callsById.set(String(call.id), call);
    });
  });

  list.forEach((message) => {
    if (!isToolResultMessage(message)) return;
    const toolCallId = String(message?.toolCallId || message?.callId || '').trim();
    const call = toolCallId ? callsById.get(toolCallId) : null;
    if (!call) return;
    call.name = call.name || String(message?.toolName || '').trim();
    call.result = extractUserFacingAssistantText(message);
    call.status = message?.isError ? 'error' : 'success';
    if (message?.isError) call.error = call.result;
  });

  return list.filter((message) => !isToolResultMessage(message));
}

function isRenderableMediaUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const url = value.trim();
  if (/^data:image\//i.test(url)) return true;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function extractMediaUrls(value, depth = 0, output = []) {
  if (!value || depth > 5) return [...new Set(output)];
  if (Array.isArray(value)) {
    value.forEach((item) => extractMediaUrls(item, depth + 1, output));
    return [...new Set(output)];
  }
  if (typeof value !== 'object') return [...new Set(output)];

  const add = (candidate) => {
    if (isRenderableMediaUrl(candidate)) output.push(candidate.trim());
  };
  const mediaFields = [value.mediaUrl, value.mediaUrls, value.imageUrl, value.image_url];
  mediaFields.forEach((candidate) => {
    if (Array.isArray(candidate)) candidate.forEach(add);
    else add(candidate);
  });

  const type = String(value.type || value.kind || '').toLowerCase();
  if (/(image|audio|video|media)/.test(type)) {
    add(value.url);
    add(value.src);
    add(value.href);
  }

  ['content', 'message', 'response', 'attachments', 'media', 'images'].forEach((key) => {
    if (value[key] !== undefined) extractMediaUrls(value[key], depth + 1, output);
  });
  return [...new Set(output)];
}

function extractUserFacingAssistantText(value) {
  if (typeof value === 'string') return stripInternalAssistantText(value);
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) return extractTextParts(value);
  if (Array.isArray(value.content)) return extractTextParts(value.content);
  if (Array.isArray(value.parts)) return extractTextParts(value.parts);
  if (typeof value.content === 'string') return stripInternalAssistantText(value.content);
  if (typeof value.text === 'string') return stripInternalAssistantText(value.text);
  if (typeof value.message === 'string') return stripInternalAssistantText(value.message);
  if (value.response && typeof value.response === 'object') {
    const nested = extractUserFacingAssistantText(value.response);
    if (nested) return nested;
  }
  if (typeof value.responseText === 'string') return stripInternalAssistantText(value.responseText);
  return '';
}

function normalizeSessionItems(...sources) {
  const candidates = [];
  for (const source of sources) {
    if (Array.isArray(source)) candidates.push(...source);
  }

  return candidates
    .map((item) => {
      if (typeof item === 'string') {
        return {
          sessionKey: item,
          displayName: inferAgentNameFromKey(item) || item,
          provider: 'openclaw',
        };
      }

      const sessionKey = String(
        item?.sessionKey
        || item?.key
        || item?.id
        || item?.session
        || ''
      ).trim();

      if (!sessionKey) return null;

      const inferredAgentName = inferAgentNameFromKey(sessionKey);
      const title = String(item?.title || item?.name || '').trim();
      const agentName = String(item?.agentName || item?.agent?.name || inferredAgentName || '').trim();
      const displayName = String(
        item?.displayName
        || title
        || agentName
        || inferredAgentName
        || sessionKey
      ).trim();

      return {
        ...item,
        sessionKey,
        title,
        agentName,
        displayName,
        provider: item?.provider || 'openclaw',
      };
    })
    .filter(Boolean)
    .filter((item, index, arr) => arr.findIndex((other) => other.sessionKey === item.sessionKey) === index);
}


app.get('/api/assistant-identity', isAuthenticated, async (req, res) => {
  try {
    const sessionKey = String(req.query.sessionKey || '').trim();
    if (!sessionKey) return res.status(400).json({ error: 'sessionKey required' });
    const result = await gatewayInvoke('agent_identity_get', { sessionKey });
    const payload = unwrapToolResult(result);
    return res.json({
      assistantName: payload?.name || payload?.assistantName || payload?.identity?.name || null,
      assistantAvatar: payload?.avatarUrl || payload?.assistantAvatar || payload?.identity?.avatarUrl || null,
      assistantAgentId: payload?.agentId || payload?.assistantAgentId || payload?.id || null,
    });
  } catch (error) {
    console.error('Error fetching assistant identity:', error.message);
    return res.status(502).json({ error: error.message || 'Failed to fetch assistant identity' });
  }
});

app.get('/api/agents', isAuthenticated, async (_req, res) => {
  try {
    const result = await gatewayInvoke('agents_list', {});
    const payload = unwrapToolResult(result);
    const agents = Array.isArray(payload?.agents) ? payload.agents : Array.isArray(payload) ? payload : [];
    return res.json({ agents });
  } catch (error) {
    console.error('Error fetching agents list:', error.message);
    return res.status(502).json({ error: error.message || 'Failed to fetch agents list' });
  }
});

app.get('/api/sessions', isAuthenticated, async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  try {
    if (await waitForGatewayWsReady()) {
      await subscribeToGatewaySessions();
      try {
        const frame = await gatewayWsManager.send('sessions.list', { includeLastMessage: true, includeDerivedTitles: true }, 10);
        const payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
        const sessions = normalizeSessionItems(
          payload,
          payload?.sessions,
          payload?.items,
          frame?.sessions,
          frame?.items,
        );
        if (sessions.length > 0) {
          return res.json({ sessions });
        }
      } catch (wsErr) {
        console.warn('sessions.list via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    const listSessionsResult = await gatewayInvoke('sessions_list', { includeLastMessage: true, includeDerivedTitles: true });
    const payload = unwrapToolResult(listSessionsResult);
    const sessions = normalizeSessionItems(
      payload,
      payload?.sessions,
      payload?.items,
      listSessionsResult?.sessions,
      listSessionsResult?.items,
    );

    return res.json({ sessions });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      return res.json({
        sessions: [{
          sessionKey: DEFAULT_SESSION_KEY,
          displayName: inferAgentNameFromKey(DEFAULT_SESSION_KEY) || DEFAULT_SESSION_KEY,
          provider: 'openclaw',
          fallback: true,
        }],
      });
    }

    console.error('Error listing sessions:', error.message || error);
    return res.status(500).json({ error: 'Failed to list sessions' });
  }
});

app.get('/api/sessions/:key/history', isAuthenticated, requireSessionAccess(authMode), async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  try {
    const sessionKey = String(req.params.key || '').trim();
    if (!sessionKey) {
      return res.status(400).json({ error: 'session key is required' });
    }

    let payload = null;
    let historyResult = null;

    if (await waitForGatewayWsReady()) {
      await subscribeToGatewaySession(sessionKey);
      try {
        const frame = await gatewayWsManager.send('chat.history', { sessionKey, limit: 100 }, 10);
        payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
      } catch (wsErr) {
        console.warn('sessions.history via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    if (!payload) {
      historyResult = await gatewayInvoke('sessions_history', { sessionKey, limit: 100 });
      payload = unwrapToolResult(historyResult);
    }
    const messages = mergeHistoryToolResults((Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload)
        ? payload
        : Array.isArray(historyResult?.messages)
          ? historyResult.messages
          : []).map((msg) => {
            const role = String(msg?.role || msg?.sender || 'assistant').toLowerCase();
            const content = extractUserFacingAssistantText(msg);
            return {
              ...msg,
              role,
              content,
              timestamp: msg?.timestamp || msg?.createdAt || msg?.time || null,
              model: msg?.model || msg?.response?.model || null,
              thinking: extractThinkingText(msg),
              toolCalls: extractStructuredToolCalls(msg),
              mediaUrls: extractMediaUrls(msg),
            };
          }).filter((msg) => {
            if (msg.role !== 'assistant') return true;
            return Boolean(
              String(msg.content || '').trim()
              || String(msg.thinking || '').trim()
              || msg.toolCalls.length > 0
              || msg.mediaUrls.length > 0
            );
          }));

    return res.json({ sessionKey, messages });
  } catch (error) {
    console.error('Error fetching session history:', error.message || error);
    return res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

app.post('/api/sessions/:key/send', isAuthenticated, requireSessionAccess(authMode), async (req, res) => {
  try {
    const sessionKey = String(req.params.key || '').trim();
    const text = String(req.body?.text || req.body?.message || '').trim();

    if (!sessionKey) {
      return res.status(400).json({ error: 'session key is required' });
    }
    if (!text) {
      return res.status(400).json({ error: 'text is required' });
    }
    if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `message exceeds max length (${MAX_CHAT_MESSAGE_LENGTH})` });
    }

    let payload = null;
    let result = null;

    if (await waitForGatewayWsReady()) {
      await subscribeToGatewaySession(sessionKey);
      try {
        const frame = await gatewayWsManager.send('chat.send', { sessionKey, message: text, deliver: false, idempotencyKey: gatewayWsManager.createRequestId('msg') }, 30);
        payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
      } catch (wsErr) {
        console.warn('chat.send via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    if (!payload) {
      result = await gatewayInvoke('sessions_send', { sessionKey, message: text });
      payload = unwrapToolResult(result);
    }

    const body = payload && typeof payload === 'object' ? payload : { result: payload ?? result };
    const responseText = extractUserFacingAssistantText(body?.response) || extractUserFacingAssistantText(body);
    const toolCalls = extractStructuredToolCalls(body?.response || body);
    const mediaUrls = extractMediaUrls(body);
    const thinking = extractThinkingText(body?.response || body);
    const needsInput = extractNeedsInputPrompt(body?.response || body);
    return res.json({ ok: true, success: true, ...body, responseText, thinking, toolCalls, mediaUrls, needsInput });
  } catch (error) {
    console.error('Error sending chat message:', error.message || error);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/sessions/:key/send-stream', isAuthenticated, requireSessionAccess(authMode), async (req, res) => {
  try {
    const sessionKey = String(req.params.key || '').trim();
    const text = String(req.body?.text || req.body?.message || '').trim();

    if (!sessionKey) return res.status(400).json({ error: 'session key is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });
    if (text.length > MAX_CHAT_MESSAGE_LENGTH) {
      return res.status(400).json({ error: `message exceeds max length (${MAX_CHAT_MESSAGE_LENGTH})` });
    }

    let payload = null;
    let result = null;

    if (gatewayWsManager?.isConnected?.()) {
      await subscribeToGatewaySession(sessionKey);
      try {
        const frame = await gatewayWsManager.send('chat.send', { sessionKey, message: text, deliver: false, idempotencyKey: gatewayWsManager.createRequestId('msg') }, 30);
        payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
      } catch (wsErr) {
        console.warn('chat.send stream shim via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    if (!payload) {
      result = await gatewayInvoke('sessions_send', { sessionKey, message: text });
      payload = unwrapToolResult(result);
    }

    const responseText = extractUserFacingAssistantText(payload?.response) || extractUserFacingAssistantText(payload);
    const toolCalls = extractStructuredToolCalls(payload);
    const mediaUrls = extractMediaUrls(payload);
    const thinking = extractThinkingText(payload?.response || payload);
    const needsInput = extractNeedsInputPrompt(payload);
    const model = payload?.response?.model || payload?.model || null;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'message', text: responseText, thinking, toolCalls, mediaUrls, needsInput, model })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error streaming chat message:', error.message || error);
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ type: 'error', error: error.message || 'Failed to send message' })}\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  }
});

// GET /api/link-preview?url=https://example.com - Fetch OG metadata for inline link cards
app.get('/api/link-preview', isAuthenticated, async (req, res) => {
  const rawUrl = typeof req.query?.url === 'string' ? req.query.url.trim() : '';
  if (!rawUrl) {
    return res.status(400).json({ error: 'url query parameter is required' });
  }

  let targetUrl;
  try {
    targetUrl = new URL(rawUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (!['http:', 'https:'].includes(targetUrl.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs are supported' });
  }

  if (await isForbiddenLinkPreviewHost(targetUrl.hostname)) {
    return res.status(400).json({ error: 'Local/private hosts are not allowed for previews' });
  }

  // Check cache first (before coalescing, so cached results skip entirely)
  const cached = linkPreviewCache.get(targetUrl.toString());
  if (cached) {
    return res.json(cached.data);
  }
  // Coalesce concurrent requests for the same URL to avoid duplicate fetches
  try {
    const result = await linkPreviewCoalescer.run(
      targetUrl.toString(),
      () => _fetchLinkPreview(rawUrl, targetUrl),
    );

    // Cache the preview data for future requests (not metrics)
    linkPreviewCache.set(targetUrl.toString(), result.data);

    // Return preview data with performance metrics
    return res.json({
      ...result.data,
      _metrics: {
        dnsMs: result.metrics.dns,
        connectHeadersMs: result.metrics.connectHeaders,
        bodyReadMs: result.metrics.bodyRead,
        overallMs: result.metrics.overall,
        retryCount: result.metrics.retryCount,
      },
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const phase = error.phase || 'overall';
      return res.status(504).json({ error: `Preview fetch timed out during ${phase} phase after ${error.ms}ms` });
    }
    console.warn('Link preview fetch failed:', error.message || error);
    if (error?.metrics) {
      console.warn('  metrics:', JSON.stringify(error.metrics));
    }
    return res.status(502).json({ error: 'Unable to fetch link preview' });
  }
});

// Internal helper: fetch and extract a link preview with per-phase timeout controls.
// Returns { url, title, description, image, domain, twitterCard } or throws.
/**
 * Exponential backoff with jitter for link preview retries.
 * @param {number} attempt - 0-based attempt number
 * @returns {number} delay in ms
 */
function _retryDelayMs(attempt) {
  const exponential = Math.min(
    LINK_PREVIEW_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
    LINK_PREVIEW_RETRY_MAX_DELAY_MS,
  );
  // Add uniform jitter: +/-25% of the base delay
  const jitterRange = exponential * 0.25;
  return Math.round(exponential + (Math.random() * jitterRange * 2 - jitterRange));
}

/**
 * Issue a GET over stdlib http/https with the socket pinned to an
 * already-validated IP address (issue #849). Node's http client re-resolves
 * DNS at connect time; pinning the lookup to the validated address closes
 * the DNS-rebinding TOCTOU that global fetch (undici) left open. The real
 * hostname is still used for the Host header, SNI, and cert verification.
 *
 * No URL parsing happens here: `parsedUrl` comes from `new URL()` upstream,
 * which rejects null bytes and normalizes the path before it reaches the
 * request line. Nothing in this path touches the local filesystem, so
 * traversal-style inputs are inert -- this only selects an HTTP request-target.
 */
function _pinnedHttpRequest(parsedUrl, pinned, { headers, signal }) {
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const family = net.isIPv6(pinned.address) ? 6 : 4;
  const lookup = (hostname, opts, cb) => {
    if (opts && opts.all) { cb(null, [{ address: pinned.address, family }]); return; }
    cb(null, pinned.address, family);
  };
  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || undefined,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers,
      signal,
      lookup,
      autoSelectFamily: false,
    }, (res) => {
      res.status = res.statusCode;
      res.ok = res.statusCode >= 200 && res.statusCode < 300;
      res.url = parsedUrl.href;
      resolve(res);
    });
    req.on('error', reject);
    req.end();
  });
}

async function _fetchLinkPreview(rawUrl, targetUrl) {
  const MAX_REDIRECTS = 5;
  let currentUrl = targetUrl.toString();
  let redirectCount = 0;

  // Overall timeout
  const overallStart = Date.now();
  // The overall budget is wired through an AbortController rather than
  // throwing from the timer callback, so a slow upstream can no longer
  // take down the process via an uncaughtException. The per-hop and
  // body-read signals are composed with this one so that when the
  // overall budget elapses any in-flight fetch and body-read is
  // aborted, the loop unwinds, and we throw a phased timeout error.
  const overallController = new AbortController();
  const overallTimeoutHandle = setTimeout(() => {
    overallController.abort();
  }, LINK_PREVIEW_TIMEOUT_MS);

  // Structured timing metrics (accumulate across hops)
  const metrics = {
    dns: 0,
    connectHeaders: 0,
    bodyRead: 0,
    overall: 0,
    retryCount: 0,
    retries: [],
  };

  // Helper to surface an overall-budget timeout as a phased 504 error.
  // Defined after `metrics` so the closure captures it after it is
  // initialised (the timer can only fire after the function body has
  // set it up).
  const throwOverallTimeout = (cause) => {
    const elapsed = Date.now() - overallStart;
    metrics.overall = elapsed;
    const err = new Error(`Preview fetch timed out during overall phase after ${elapsed}ms`);
    err.phase = 'overall';
    err.ms = elapsed;
    err.metrics = { ...metrics };
    err.name = 'AbortError';
    if (cause) err.cause = cause;
    throw err;
  };

  // Try/finally guarantees the overall timer is cleared even on
  // unanticipated error paths; combined with the abort-based timer
  // above, this is what prevents a slow upstream from crashing the
  // process via an uncaughtException in a timer callback.
  try {
    while (redirectCount < MAX_REDIRECTS) {
      const parsedUrl = new URL(currentUrl);
      const host = parsedUrl.hostname;

      // Validate each hop's hostname (with DNS resolution for rebinding protection)
      if (await isForbiddenLinkPreviewHost(host, { resolveDns: true })) {
        clearTimeout(overallTimeoutHandle);
        throw new Error('Redirect target is a local/private host');
      }

      // Per-phase timeouts for this hop
      const hopController = new AbortController();
      // Compose: abort the hop's fetch when either the per-hop timer or
      // the overall budget fires. This is what wires the overall timer
      // through to the in-flight fetch — it can no longer throw from a
      // timer callback.
      const hopSignal = AbortSignal.any([hopController.signal, overallController.signal]);

      // DNS timeout: use AbortSignal.timeout to abort the lookup on slow DNS.
      // The resolved address is reused (not discarded) so the connect phase
      // can pin the socket to the SAME address we validated — a fresh
      // resolution inside the fetch is the DNS-rebinding TOCTOU hole (#849).
      const dnsStart = Date.now();
      let pinned;

      try {
        pinned = await dns.promises.lookup(host, {
          verbatim: true,
          signal: AbortSignal.any([
            AbortSignal.timeout(LINK_PREVIEW_DNS_TIMEOUT_MS),
            overallController.signal,
          ]),
        });
      } catch (error) {
        if (overallController.signal.aborted) {
          throwOverallTimeout(error);
        }
        const dnsElapsed = Date.now() - dnsStart;
        clearTimeout(overallTimeoutHandle);
        metrics.dns += dnsElapsed;
        metrics.overall = Date.now() - overallStart;
        const err = new Error('Preview fetch timed out during dns phase after ' + dnsElapsed + 'ms');
        err.phase = 'dns';
        err.ms = dnsElapsed;
        err.metrics = metrics;
        throw err;
      }
      metrics.dns += Date.now() - dnsStart;

      if (!pinned || !pinned.address) {
        clearTimeout(overallTimeoutHandle);
        throw new Error('Redirect target could not be resolved');
      }
      // The SAME address we validated is the one dialed next, which closes
      // the rebinding window between validation and connect.
      if (isForbiddenLinkPreviewAddress(pinned.address)) {
        clearTimeout(overallTimeoutHandle);
        throw new Error('Redirect target is a local/private host');
      }

      // Connect + headers timeout via AbortController signal.
      // The timer is tracked and cleared after the fetch completes so it
      // does not keep the event loop alive (see #766).
      const connectStart = Date.now();
      const headersTimeoutHandle = setTimeout(() => {
        hopController.abort(new Error('headers'));
      }, LINK_PREVIEW_CONNECT_TIMEOUT_MS + LINK_PREVIEW_HEADERS_TIMEOUT_MS);

      // Fetch with per-host concurrency limiting and 5xx retry.
      // The headersTimeoutHandle is cleared once the loop exits (success or
      // abort) so the timer does not outlive the hop (see #766).
      let hopRes;
      let attempts = 0;

      try {
        while (true) {
          // Run the fetch under per-host concurrency limiting
          hopRes = await linkPreviewHostLimiter.run(host, async () => {
            return _pinnedHttpRequest(parsedUrl, pinned, {
              headers: {
                Accept: 'text/html,application/xhtml+xml',
                'User-Agent': LINK_PREVIEW_USER_AGENT,
              },
              signal: hopSignal,
            });
          });

          const hopStatus = hopRes.status;

          // Retry on 5xx (server errors) with jittered backoff
          if (hopStatus >= 500 && hopStatus < 600 && attempts < LINK_PREVIEW_RETRY_MAX_ATTEMPTS) {
            attempts++;
            metrics.retryCount++;
            const delayMs = _retryDelayMs(attempts - 1);
            metrics.retries.push({ status: hopStatus, attempt: attempts, delayMs });

            // Abort reads on the response body before retrying so the socket
            // is released immediately (matches the old fetch body.cancel()
            // semantics; resume() would keep a slow upstream's socket
            // subscribed through the backoff).
            try { hopRes.destroy(); } catch { /* ignore */ }

            await new Promise(resolve => setTimeout(resolve, delayMs));
            continue;
          }

          break; // Non-5xx or max retries reached
        }
      } finally {
        clearTimeout(headersTimeoutHandle);
      }

      const connectElapsed = Date.now() - connectStart;
      metrics.connectHeaders += connectElapsed;

      let hopStatus = hopRes.status;
      let hopHeaders = hopRes.headers;
      let isRedirect = false;

      if (hopStatus >= 300 && hopStatus < 400 && hopHeaders.location) {
        isRedirect = true;
      }

      if (isRedirect) {
        redirectCount++;
        if (redirectCount > MAX_REDIRECTS) {
          clearTimeout(overallTimeoutHandle);
          throw new Error('Redirect chain too long');
        }
        try {
          currentUrl = new URL(hopHeaders.location, currentUrl).toString();
        } catch {
          clearTimeout(overallTimeoutHandle);
          throw new Error('Invalid redirect URL');
        }
        continue;
      }

      // Non-redirect: validate and read body
      if (!hopRes.ok) {
        clearTimeout(overallTimeoutHandle);
        throw new Error('Upstream request failed (' + hopStatus + ')');
      }

      // Validate the final resolved URL is not a private host (catches last-hop SSRF)
      const finalUrlParsed = hopRes.url ? new URL(hopRes.url) : null;
      if (finalUrlParsed && await isForbiddenLinkPreviewHost(finalUrlParsed.hostname, { resolveDns: true })) {
        clearTimeout(overallTimeoutHandle);
        throw new Error('Final redirect target is a local/private host');
      }

      const contentType = String(hopRes.headers['content-type'] || '').toLowerCase();
      if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        clearTimeout(overallTimeoutHandle);
        throw new Error('URL does not point to an HTML document');
      }

      // Read body with size limit and per-phase timeout
      const htmlStream = hopRes;
      let htmlChunks = [];
      let htmlLength = 0;
      const bodyReadController = new AbortController();
      // Compose: the body-read loop aborts when either the per-phase
      // body-read timer OR the overall budget timer fires. This is
      // what lets the overall budget interrupt an in-flight body read
      // without throwing from a timer callback.
      const bodyReadSignal = AbortSignal.any([bodyReadController.signal, overallController.signal]);
      const bodyReadStart = Date.now();
      const bodyReadTimeoutHandle = setTimeout(() => {
        bodyReadController.abort(new Error('body-read'));
      }, LINK_PREVIEW_BODY_READ_TIMEOUT_MS);

      try {
        for await (const chunk of htmlStream) {
          if (bodyReadController.signal.aborted || bodyReadSignal.aborted) break;
          const chunkStr = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
          htmlLength += chunkStr.length;
          if (htmlLength > LINK_PREVIEW_MAX_HTML_CHARS * 1.5) {
            // Soft limit: stop reading but don't error yet
            break;
          }
          htmlChunks.push(chunkStr);
        }
      } finally {
        clearTimeout(bodyReadTimeoutHandle);
      }

      // If the overall budget fired while the body was still streaming,
      // surface it as a phased timeout rather than returning a partial
      // preview.
      if (overallController.signal.aborted) {
        throwOverallTimeout();
      }

      metrics.bodyRead += Date.now() - bodyReadStart;

      const html = htmlChunks.join('').slice(0, LINK_PREVIEW_MAX_HTML_CHARS);
      const finalUrl = hopRes.url || targetUrl.toString();
      metrics.overall = Date.now() - overallStart;
      clearTimeout(overallTimeoutHandle);
      return { data: extractLinkPreviewData(html, finalUrl), metrics };
    }

    // Should not reach here, but handle gracefully
    clearTimeout(overallTimeoutHandle);
    throw new Error('Redirect chain exhausted without a response');
  } catch (error) {
    clearTimeout(overallTimeoutHandle);
    // If the overall budget fired but the inner catch did not surface a
    // phased 'overall' error, throw one now. This keeps the overall
    // timeout from ever throwing from the timer callback.
    if (overallController.signal.aborted && error?.phase !== 'overall') {
      const elapsed = Date.now() - overallStart;
      metrics.overall = elapsed;
      const err = new Error(`Preview fetch timed out during overall phase after ${elapsed}ms`);
      err.phase = 'overall';
      err.ms = elapsed;
      err.metrics = { ...metrics };
      err.name = 'AbortError';
      err.cause = error;
      throw err;
    }
    if (!error.metrics) {
      metrics.overall = Date.now() - overallStart;
      error.metrics = metrics;
    } else {
      error.metrics.overall = Date.now() - overallStart;
    }
    if (error?.phase && error?.ms) {
      // Re-throw with timeout metadata
      throw error;
    }
    // The per-hop connect+headers timer aborts the hop controller with a
    // 'headers' reason; attribute that abort to the connect+headers phase
    // instead of the generic fetch phase (see #766).
    if (error?.message === 'headers' && !error.phase) {
      const elapsed = Date.now() - overallStart;
      const err = new Error('Preview fetch timed out during connect+headers phase after ' + elapsed + 'ms');
      err.phase = 'connect+headers';
      err.ms = elapsed;
      err.metrics = metrics;
      err.cause = error;
      throw err;
    }
    // Wrap non-timeout errors so the route handler can distinguish them
    if (!(error instanceof Error) || !error.phase) {
      const wrapped = new Error(error.message || 'Preview fetch failed');
      wrapped.phase = 'fetch';
      wrapped.ms = 0;
      wrapped.metrics = metrics;
      throw wrapped;
    }
    throw error;
  } finally {
    clearTimeout(overallTimeoutHandle);
  }
}

// GET /api/openclaw-status - Return native OpenClaw session status card/details
app.get('/api/openclaw-status', isAuthenticated, requireSessionAccess(authMode), async (req, res) => {
  try {
    const sessionKey = typeof req.query.sessionKey === 'string' && req.query.sessionKey.trim()
      ? req.query.sessionKey.trim()
      : undefined;

    const result = await gatewayInvoke('session_status', {
      ...(sessionKey ? { sessionKey } : {}),
    });

    const payload = unwrapToolResult(result);
    const text =
      payload?.statusText
      || payload?.text
      || payload?.summary
      || result?.text
      || '';

    res.json({ ok: true, payload, text });
  } catch (error) {
    console.error('Error getting OpenClaw status:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// POST /api/openclaw-stop - Abort current OpenClaw chat run for a session
app.post('/api/openclaw-stop', isAuthenticated, requireSessionAccess(authMode), async (req, res) => {
  try {
    const sessionKey = typeof req.body?.sessionKey === 'string' && req.body.sessionKey.trim()
      ? req.body.sessionKey.trim()
      : undefined;

    if (!sessionKey) {
      return res.status(400).json({ ok: false, error: 'sessionKey is required' });
    }

    // Preferred path: persistent WS method (matches OpenClaw runtime API)
    if (gatewayWsManager?.isConnected?.()) {
      try {
        const frame = await gatewayWsManager.send('chat.abort', { sessionKey }, 10);
        return res.json({ ok: true, frame });
      } catch (wsErr) {
        console.warn('chat.abort via WS failed, trying tool fallback:', wsErr.message);
      }
    }

    // Fallback for environments where WS abort path is unavailable
    const result = await gatewayInvoke('chat_abort', { sessionKey });
    const payload = unwrapToolResult(result);
    return res.json({ ok: true, payload });
  } catch (error) {
    console.error('Error aborting OpenClaw run:', error.message);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

/**
 * Infer a readable agent name from session key metadata
 * Handles formats like: agent:main:main, agent:chatgpt:thread-123, etc.
 * @param {string} sessionKey - The session key
 * @returns {string|null} - Formatted agent name or null if cannot infer
 */

function gatewayInvoke(tool, args = {}, opts = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    // Allow opts.url override (used by tests; production code relies on the
    // module-level GATEWAY_URL constant).
    const baseUrl = (opts && typeof opts.url === 'string' && opts.url) ? opts.url : GATEWAY_URL;
    const url = new URL('/tools/invoke', baseUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };

    if (GATEWAY_TOKEN) {
      headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;
    }

    // Allow callers to override (e.g. tests); fall back to the configured default.
    const timeoutMs = (opts && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)
      ? Math.floor(opts.timeoutMs)
      : GATEWAY_INVOKE_TIMEOUT_MS;

    // `settled` guards against double-settle (e.g. error firing after a response
    // finishes, or both the JS timer and the socket 'timeout' event firing).
    let settled = false;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      try { req.destroy(); } catch (_e) { /* noop */ }
      fn(value);
    };

    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (settled) return;
        try {
          const json = JSON.parse(data);
          if (json.ok) return finish(resolve, json.result);
          return finish(reject, new Error(json.error?.message || 'Gateway invoke failed'));
        } catch {
          return finish(reject, new Error(`Invalid gateway response: ${String(data).slice(0, 200)}`));
        }
      });
    });

    // JS-level deadline: makes rejection deterministic even if the gateway
    // accepts the TCP connection but never sends a response (no socket-level
    // 'timeout' fires when there's no traffic at all on some platforms).
    timer = setTimeout(() => {
      finish(reject, new Error(`gateway ${tool} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    // Socket-level idle timeout: if the underlying socket stops receiving bytes
    // for `timeoutMs`, Node destroys the request and emits 'timeout'. This
    // catches a stalled mid-response body that the JS timer above would also
    // catch, but it forces the socket to release sooner.
    try { req.setTimeout(timeoutMs); } catch (_e) { /* some transports may not support it */ }
    req.on('timeout', () => {
      finish(reject, new Error(`gateway ${tool} timed out after ${timeoutMs}ms`));
    });

    req.on('error', (err) => finish(reject, err));
    try {
      req.write(postData);
      req.end();
    } catch (err) {
      finish(reject, err);
    }
  });
}

function unwrapToolResult(result) {
  if (!result) return {};
  if (result.details && typeof result.details === 'object') return result.details;
  const text = result?.content?.find?.((x) => x?.type === 'text')?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}

function humanizeAgentToken(value) {
  return String(value || '')
    .trim()
    .replace(/^g-agent-/, '')
    .replace(/^agent[-:]/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function inferAgentNameFromKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return null;

  if (sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    if (parts.length >= 2 && parts[1]) {
      return humanizeAgentToken(parts[1]);
    }
  }

  const webchatMatch = sessionKey.match(/(?:^|:)g-agent-([a-z0-9_]+)(?:[-:]|$)/i);
  if (webchatMatch?.[1]) {
    return humanizeAgentToken(webchatMatch[1]);
  }

  return null;
}

// Reaction routes extracted to lib/routes/reactions.js
app.use('/api', createReactionsRoutes({ isAuthenticated, requireSessionAccess, authMode, reactions }));
app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({
    title: APP_TITLE,
    assistantName: CHAT_DISPLAY_NAME,
    defaultSessionKey: DEFAULT_SESSION_KEY,
    authMode,
    requiresAuth: authMode !== 'none',
    localAuthEnabled,
    oidcEnabled,
    oidcLabel: getOidcLabel(),
    pushNotifications: {
      enabled: PUSH_NOTIFICATIONS_ENABLED,
      vapidPublicKey: PUSH_NOTIFICATIONS_ENABLED ? PUSH_VAPID_PUBLIC_KEY : '',
    },
  });
});

app.get('/api/events', isAuthenticated, sseLimiter, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`data: ${JSON.stringify({ event: 'connected', data: { ok: true }, timestamp: Date.now() })}\n\n`);
  sseClients.add(res);
  req.on('close', () => {
    sseClients.delete(res);
  });
});

// Bound on the socket's writable queue per SSE client. A client that stops
// reading (sleeping laptop, backgrounded tab, flaky network) would otherwise
// grow Node's write buffer without limit for the lifetime of the connection.
// When the queue exceeds this, the client is dropped so it can reconnect.
const SSE_MAX_WRITABLE_BYTES = 1024 * 1024;

function dropSseClient(client) {
  sseClients.delete(client);
  try {
    client.end();
  } catch {}
}

function broadcastToSseClients(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      const ok = client.write(`data: ${payload}\n\n`);
      if (!ok || (client.writableLength || 0) > SSE_MAX_WRITABLE_BYTES) {
        dropSseClient(client);
      }
    } catch {
      dropSseClient(client);
    }
  }
}

const PORT = process.env.PORT || 3000;

// Initialize WebSocket manager at startup
const initGatewayWsManager = async () => {
  try {
    await gatewayWsManager.connect(gatewayWsOrigin);
    gatewayWsLastError = '';
    gatewayWsLastClose = null;
    console.log('✅ Persistent Gateway WS manager connected');
    
    // Set up reconnection event handlers
    gatewayWsManager.on('reconnecting', (attempt, delay) => {
      const pendingCount = gatewayWsManager.getPendingRequestCount();
      const pendingForRecovery = gatewayWsManager.getPendingForRecoveryCount();
      console.log(`🔄 Gateway WS reconnecting (attempt ${attempt}) in ${delay}ms...`);
      console.log(`   Pending requests: ${pendingCount}, Pending for recovery: ${pendingForRecovery}`);
    });
    
    gatewayWsManager.on('reconnect-failed', (err) => {
      console.error('❌ Gateway WS reconnection failed:', err.message);
    });
    
    gatewayWsManager.on('close', (code, reason) => {
      gatewaySessionsSubscriptionActive = false;
      gatewaySessionsSubscriptionPromise = null;
      activeGatewaySessionSubscriptions.clear();
      gatewayWsLastClose = {
        code,
        reason: typeof reason === 'string' ? reason : String(reason || ''),
        at: new Date().toISOString(),
      };
      const pendingCount = gatewayWsManager.getPendingRequestCount();
      console.log(`🔌 Gateway WS closed: ${code} ${reason} (pending: ${pendingCount})`);
    });
    
    gatewayWsManager.on('connected', () => {
      gatewaySessionsSubscriptionActive = false;
      gatewaySessionsSubscriptionPromise = null;
      activeGatewaySessionSubscriptions.clear();
      const pendingRecovered = gatewayWsManager.getPendingForRecoveryCount();
      if (pendingRecovered > 0) {
        console.log(`✅ Gateway WS reconnected with ${pendingRecovered} pending requests recovered`);
      } else {
        console.log('✅ Gateway WS manager connected');
      }
      void subscribeToGatewaySessions();
      for (const sessionKey of gatewaySessionSubscriptions) {
        void subscribeToGatewaySession(sessionKey);
      }
    });
    
    // Forward gateway events to SSE clients
    gatewayWsManager.on('gateway-event', (eventType, eventData) => {
      // Privacy: do not log event payloads (can contain message content).
      // Enable payload logging only when explicitly requested for debugging.
      if (process.env.LOG_GATEWAY_EVENT_PAYLOADS === 'true') {
        console.log(`📡 Gateway event: ${eventType}`, eventData ? JSON.stringify(eventData).slice(0, 200) : '');
      } else {
        console.log(`📡 Gateway event: ${eventType}`);
      }
      broadcastToSseClients(eventType, eventData);
    });
    
  } catch (err) {
    console.error('❌ Failed to initialize persistent Gateway WS manager:', err.message);
    console.log('   Will fall back to per-request WebSocket connections');
  }
};

// Start server and initialize WS manager
async function startServer() {
  return new Promise((resolve, reject) => {
    server.listen(PORT, async () => {
      try {
        const gatewayHttpUrl = process.env.GATEWAY_URL || process.env.OPENCLAW_API_URL || '(not set)';
        const gatewayWsUrl = process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789';
        const gatewayWsOriginLabel = process.env.GATEWAY_WS_ORIGIN || '(none)';
        const gatewayWsClientId = GATEWAY_WS_CLIENT_ID;
        const gatewayWsClientMode = GATEWAY_WS_CLIENT_MODE;
        const gatewayDeviceIdentityPath = GATEWAY_DEVICE_IDENTITY_PATH;
        const defaultSessionKey = DEFAULT_SESSION_KEY;
        const pushNotificationsEnabled = process.env.PUSH_NOTIFICATIONS_ENABLED === 'true';
        const pushConfigReady = (process.env.PUSH_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY) && (process.env.PUSH_VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY) && (process.env.PUSH_VAPID_SUBJECT || process.env.PUSH_SUBJECT);

        console.log(`
🎉 miso-chat v${APP_VERSION} server running on port ${PORT}
   
   Gateway: ${gatewayHttpUrl}
   Gateway WS: ${gatewayWsUrl}
   Gateway WS Origin: ${gatewayWsOriginLabel}
   Gateway WS Client: ${gatewayWsClientId} (${gatewayWsClientMode})
   Gateway Device Identity: ${gatewayDeviceIdentityPath && fs.existsSync(gatewayDeviceIdentityPath) ? gatewayDeviceIdentityPath : 'missing'}
   Default Session: ${defaultSessionKey}
   Push Notifications: ${pushNotificationsEnabled ? `enabled (${pushConfigReady ? 'configured' : 'misconfigured'})` : 'disabled'}
   Auth: ${process.env.OIDC_ENABLED === 'true' ? 'OIDC' : 'Local'}
   Node Env: ${process.env.NODE_ENV || 'development'}
   
   Login: http://localhost:${PORT}/login
   
   API:
   - GET  /api/sessions
   - GET  /api/sessions/:key/history
   - POST /api/sessions/:key/send
  `);
        await initGatewayWsManager();
        resolve(server);
      } catch (err) {
        console.error('❌ Error during server startup:', err.message);
        reject(err);
      }
    });
    server.on('error', reject);
  });
}

/**
 * Graceful shutdown handler.
 * Closes the HTTP server, drains SSE clients, disconnects the gateway WebSocket manager,
 * then exits after a timeout budget.
 */
async function gracefulShutdown(signal) {
  console.log(`\n🛑 Received ${signal}. Starting graceful shutdown...`);

  const SHUTDOWN_TIMEOUT_MS = 10_000;
  const shutdownTimer = setTimeout(() => {
    console.error('⚠️  Graceful shutdown timed out, forcing exit.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    // 1. Close the HTTP server to stop accepting new connections
    if (server) {
      console.log('🔌 Closing HTTP server...');
      await new Promise((resolve) => {
        server.close(() => {
          console.log('✅ HTTP server closed.');
          resolve();
        });
      });
    }

    // 2. Drain SSE clients
    if (sseClients.size > 0) {
      console.log(`📡 Draining ${sseClients.size} SSE client(s)...`);
      for (const client of sseClients) {
        try {
          client.write('event: close\ndata: {}\n\n');
        } catch {
          // ignore write errors during shutdown
        }
        try {
          client.destroy();
        } catch {
          // ignore destroy errors during shutdown
        }
      }
      sseClients.clear();
      console.log('✅ SSE clients drained.');
    }

    // 3. Disconnect gateway WebSocket manager
    if (gatewayWsManager) {
      console.log('🔌 Disconnecting Gateway WS manager...');
      await gatewayWsManager.disconnect();
      console.log('✅ Gateway WS manager disconnected.');
    }

    clearTimeout(shutdownTimer);
    console.log('✅ Graceful shutdown complete.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during graceful shutdown:', err);
    clearTimeout(shutdownTimer);
    process.exit(1);
  }
}

// Register graceful shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

module.exports = {
  app,
  server,
  startServer,
  getReturnTo,
  gracefulShutdown,
  MAX_CHAT_MESSAGE_LENGTH,
  extractUserFacingAssistantText,
  extractNeedsInputPrompt,
  extractThinkingText,
  extractStructuredToolCalls,
  extractMediaUrls,
  mergeHistoryToolResults,
  _fetchLinkPreview,
  humanizeAgentToken,
  inferAgentNameFromKey,
  sseClients,
  broadcastToSseClients,
  dropSseClient,
  SSE_MAX_WRITABLE_BYTES,
  gatewaySessionSubscriptions,
  noteGatewaySessionSubscription,
  pruneIdleGatewaySessionSubscriptions,
  GATEWAY_SESSION_SUBSCRIPTION_IDLE_MS,
};

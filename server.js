const express = require('express');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const http = require('http');
const WebSocket = require('ws');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config();

const { GatewayWsManager } = require('./lib/gateway-ws');
const securityMiddleware = require('./security');
const { reactions } = require('./lib/db');
const { parseGatewayReactionEvent } = require('./lib/reaction-events');

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
  `miso-chat-link-preview/${APP_VERSION} (+https://github.com/joryirving/miso-chat)`;
const MAX_ATTACHMENT_BYTES = (() => {
  const parsed = Number(process.env.MAX_ATTACHMENT_BYTES || 5 * 1024 * 1024);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
})();
const ALLOWED_ATTACHMENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const ATTACHMENTS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

function sanitizeAttachmentName(name) {
  return String(name || 'attachment')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'attachment';
}

function inferAttachmentExtension(originalName, mimeType) {
  const ext = path.extname(String(originalName || '')).toLowerCase();
  if (ext) return ext;

  const fallbackByMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
  };
  return fallbackByMime[mimeType] || '.bin';
}

const attachmentStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, ATTACHMENTS_DIR),
  filename: (_req, file, cb) => {
    const baseName = sanitizeAttachmentName(path.basename(file.originalname, path.extname(file.originalname)));
    const extension = inferAttachmentExtension(file.originalname, file.mimetype);
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
    cb(null, `${unique}-${baseName}${extension}`);
  },
});

const uploadAttachment = multer({
  storage: attachmentStorage,
  limits: {
    fileSize: MAX_ATTACHMENT_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_ATTACHMENT_TYPES.has(file.mimetype)) {
      cb(new Error('Unsupported attachment type'));
      return;
    }
    cb(null, true);
  },
});

function isPrivateIPv4(hostname) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  );
}

function isPrivateIPv6(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return (
    normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
  );
}

function isForbiddenLinkPreviewHost(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  if (isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    return true;
  }
  return false;
}

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

// Trust proxy for rate limiting behind Envoy
app.set('trust proxy', 1);

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
    const cfIp = req.headers['cf-connecting-ip'];
    if (typeof cfIp === 'string' && cfIp.trim()) return cfIp.trim();

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }

    return req.ip;
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
app.use('/api/', limiter);

// Middleware
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));
// Protect direct access to index file
app.use((req, res, next) => {
  if (req.path === '/index.html' && !req.isAuthenticated?.()) {
    return res.redirect('/login');
  }
  next();
});

// Serve static assets, but do NOT auto-serve /index.html at root (keeps auth gate on /)
app.use(express.static('public', { index: false }));

// Session config (Redis-backed when REDIS_URL is set)
const defaultSessionSecret = 'dev-secret-change-in-production';
const sessionSecret = (process.env.SESSION_SECRET || '').trim() || defaultSessionSecret;

if (process.env.NODE_ENV === 'production') {
  const insecureSecrets = new Set([
    defaultSessionSecret,
    'change-this-to-a-random-secret-at-least-32-characters',
    'your-secret',
  ]);

  if (sessionSecret.length < 32 || insecureSecrets.has(sessionSecret)) {
    throw new Error('SESSION_SECRET must be a strong, unique value (at least 32 characters) in production');
  }
}

function parseBooleanEnv(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseSameSiteEnv(value, fallback) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'strict' || normalized === 'lax' || normalized === 'none') {
    return normalized;
  }
  return fallback;
}

const sessionCookieSecure = parseBooleanEnv(process.env.SESSION_COOKIE_SECURE, process.env.NODE_ENV === 'production');
const sessionCookieSameSite = parseSameSiteEnv(
  process.env.SESSION_COOKIE_SAMESITE,
  oidcEnabled ? 'lax' : 'strict'
);

if (sessionCookieSameSite === 'none' && !sessionCookieSecure) {
  console.warn('⚠️ SESSION_COOKIE_SAMESITE=none without secure cookies may be rejected by modern browsers');
}

const sessionConfig = {
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: sessionCookieSecure,
    httpOnly: true,
    // OIDC auth redirects are cross-site; Strict drops session cookie on callback and causes loops.
    // On mobile/WebView deployments that use an app origin, set SESSION_COOKIE_SAMESITE=none.
    sameSite: sessionCookieSameSite,
    maxAge: 24 * 60 * 60 * 1000,
  },
};

if (process.env.REDIS_URL) {
  const redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => {
    console.error('Redis client error:', err?.message || err);
  });
  redisClient.connect().catch((err) => {
    console.error('Redis connect failed; sessions may not persist across restarts:', err?.message || err);
  });

  sessionConfig.store = new RedisStore({
    client: redisClient,
    prefix: process.env.REDIS_SESSION_PREFIX || 'sess:',
    ttl: Math.floor((sessionConfig.cookie.maxAge || 0) / 1000) || 86400,
  });

  console.log('✅ Session store: Redis (enabled)');
} else {
  console.warn('⚠️ Session store: MemoryStore (REDIS_URL not set)');
}

const sessionMiddleware = session(sessionConfig);
app.use(sessionMiddleware);

// Passport initialization
app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Local Auth Strategy
if (localAuthEnabled) {
  const localUsers = (process.env.LOCAL_USERS || 'admin:password123').split(',');
  const validUsers = localUsers.map(u => {
    const [user, pass] = u.split(':');
    return { user: user.trim(), pass: pass.trim() };
  });

  passport.use(new LocalStrategy(
    (username, password, done) => {
      const valid = validUsers.find(u => u.user === username && u.pass === password);
      if (valid) return done(null, { username });
      return done(null, false, { message: 'Invalid credentials' });
    }
  ));
}

if (oidcEnabled) {
  const providerUrl = (process.env.OIDC_PROVIDER_URL || '').trim();
  const providerIssuer = providerUrl
    ? providerUrl.replace(/\/\.well-known\/openid-configuration\/?$/, '/')
    : '';

  const issuer = providerIssuer || process.env.OIDC_ISSUER;

  // Authentik-compatible defaults (works with app-specific provider URL)
  const oidcOrigin = (() => {
    try {
      return new URL(process.env.OIDC_ISSUER || issuer).origin;
    } catch {
      return process.env.OIDC_ISSUER || issuer;
    }
  })();

  const authorizationURL =
    process.env.OIDC_AUTHORIZATION_URL || `${oidcOrigin}/application/o/authorize/`;
  const tokenURL = process.env.OIDC_TOKEN_URL || `${oidcOrigin}/application/o/token/`;
  const userInfoURL =
    process.env.OIDC_USERINFO_URL || `${oidcOrigin}/application/o/userinfo/`;

  passport.use('oidc', new (require('passport-openidconnect').Strategy)({
    issuer,
    authorizationURL,
    tokenURL,
    userInfoURL,
    clientID: process.env.OIDC_CLIENT_ID,
    clientSecret: process.env.OIDC_CLIENT_SECRET,
    callbackURL: process.env.OIDC_CALLBACK_URL || '/auth/oidc/callback',
    scope: ['openid', 'profile', 'email']
  },
  (issuer, profile, done) => {
    return done(null, { username: profile.displayName || profile.username, email: profile.emails?.[0]?.value });
  }
  ));
}

const allowedReturnToSchemes = new Set(['http:', 'https:', 'capacitor:', 'ionic:', 'misochat:']);

function getReturnTo(req, fallback = '/') {
  const raw = typeof req.body?.return_to === 'string' && req.body.return_to.trim()
    ? req.body.return_to.trim()
    : (typeof req.query?.return_to === 'string' && req.query.return_to.trim()
      ? req.query.return_to.trim()
      : '');

  if (!raw) return fallback;
  if (raw.startsWith('/')) return raw;

  try {
    const parsed = new URL(raw);
    if (!allowedReturnToSchemes.has(parsed.protocol)) return fallback;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

function requestWantsJson(req) {
  if (req.path.startsWith('/api/')) return true;
  if (req.xhr) return true;

  const acceptHeader = String(req.headers.accept || '').toLowerCase();
  return acceptHeader.includes('application/json');
}

const mobileAuthHandoffs = new Map();
const MOBILE_AUTH_TTL_MS = Number(process.env.MOBILE_AUTH_TTL_MS || 2 * 60 * 1000);

function issueMobileAuthToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  mobileAuthHandoffs.set(token, {
    user,
    expiresAt: Date.now() + MOBILE_AUTH_TTL_MS,
  });
  return token;
}

function consumeMobileAuthToken(token) {
  const entry = mobileAuthHandoffs.get(token);
  if (!entry) return null;
  mobileAuthHandoffs.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return entry.user;
}

setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of mobileAuthHandoffs.entries()) {
    if (entry.expiresAt < now) mobileAuthHandoffs.delete(token);
  }
}, 60 * 1000).unref?.();

function establishLoginSession(req, user, cb) {
  if (!req.session?.regenerate) {
    return req.logIn(user, cb);
  }

  return req.session.regenerate((regenErr) => {
    if (regenErr) return cb(regenErr);
    return req.logIn(user, cb);
  });
}

function persistLoginSession(req, cb) {
  if (!req.session?.save) return cb();

  return req.session.save((saveErr) => cb(saveErr));
}

const isAuthenticated = (req, res, next) => {
  if (authMode === 'none') return next();
  if (req.isAuthenticated()) return next();

  if (requestWantsJson(req)) {
    return res.status(401).json({
      error: 'Authentication required',
      loginUrl: '/login',
    });
  }

  const returnTo = encodeURIComponent(getReturnTo(req, req.originalUrl || '/'));
  return res.redirect(`/login?return_to=${returnTo}`);
};

function getOidcLabel() {
  return process.env.OIDC_ISSUER_LABEL
    || process.env.OIDC_PROVIDER_NAME
    || (process.env.OIDC_ISSUER ? String(process.env.OIDC_ISSUER).replace(/^https?:\/\//, '').replace(/\/.*/, '') : 'OIDC');
}

// Login
app.get('/login', (req, res) => {
  const returnTo = getReturnTo(req, '/');

  if (authMode === 'none') {
    return res.redirect(returnTo);
  }

  if (authMode === 'oidc') {
    const encodedReturnTo = encodeURIComponent(returnTo);
    const mobile = req.query?.mobile === '1' ? '&mobile=1' : '';
    const prompt = req.query?.prompt === 'login' ? '&prompt=login' : '';
    return res.redirect(`/auth/oidc?return_to=${encodedReturnTo}${mobile}${prompt}`);
  }

  return res.sendFile(__dirname + '/public/login.html');
});

app.get('/api/login-options', (req, res) => {
  res.json({
    authMode,
    requiresAuth: authMode !== 'none',
    localAuthEnabled,
    oidcEnabled,
    oidcLabel: getOidcLabel(),
  });
});

app.post('/login', (req, res, next) => {
  if (!localAuthEnabled) {
    const returnTo = encodeURIComponent(getReturnTo(req, '/'));
    return res.redirect(`/login?error=local_disabled&return_to=${returnTo}`);
  }

  const returnTo = getReturnTo(req, '/');
  const failureReturnTo = encodeURIComponent(returnTo);

  return passport.authenticate('local', (err, user) => {
    if (err) return next(err);
    if (!user) {
      return res.redirect(`/login?error=invalid&return_to=${failureReturnTo}`);
    }

    return establishLoginSession(req, user, (loginErr) => {
      if (loginErr) {
        console.error('Local login session setup failed:', loginErr.message || loginErr);
        return res.redirect(`/login?error=invalid&return_to=${failureReturnTo}`);
      }

      return persistLoginSession(req, (saveErr) => {
        if (saveErr) {
          console.error('Local login session persist failed:', saveErr.message || saveErr);
          return res.redirect(`/login?error=invalid&return_to=${failureReturnTo}`);
        }

        return res.redirect(returnTo);
      });
    });
  })(req, res, next);
});
app.get('/auth/oidc', (req, res, next) => {
  if (!oidcEnabled) return res.redirect('/login?error=oidc_disabled');
  const returnTo = getReturnTo(req, '/');
  const mobileRequested = req.query?.mobile === '1';
  const prompt = req.query?.prompt === 'login' ? 'login' : undefined;
  req.session.oidcReturnTo = returnTo;
  req.session.oidcMobileFlow = mobileRequested;
  
  // Pass prompt parameter to force re-authentication if needed
  const authOptions = {};
  if (prompt) {
    authOptions.authorizationParams = { prompt };
  }
  
  return passport.authenticate('oidc', authOptions)(req, res, next);
});
app.get('/auth/oidc/callback', (req, res, next) => {
  passport.authenticate('oidc', (err, user) => {
    if (err || !user) {
      const returnTo = encodeURIComponent(getReturnTo(req, '/'));
      return res.redirect(`/login?error=oidc_failed&return_to=${returnTo}`);
    }

    const storedReturnTo = req.session?.oidcReturnTo;
    const mobileFlowFromSession = Boolean(req.session?.oidcMobileFlow);

    return establishLoginSession(req, user, (loginErr) => {
      if (loginErr) {
        const returnTo = encodeURIComponent(getReturnTo(req, '/'));
        console.error('OIDC login session setup failed:', loginErr.message || loginErr);
        return res.redirect(`/login?error=oidc_failed&return_to=${returnTo}`);
      }

      return persistLoginSession(req, (saveErr) => {
        if (saveErr) {
          const returnTo = encodeURIComponent(getReturnTo(req, '/'));
          console.error('OIDC login session persist failed:', saveErr.message || saveErr);
          return res.redirect(`/login?error=oidc_failed&return_to=${returnTo}`);
        }

        const ua = String(req.get('user-agent') || '');
        const isMobileUa = /Android|iPhone|iPad|iPod/i.test(ua);
        const mobileFlow = mobileFlowFromSession || (isMobileUa && !storedReturnTo);

        const safeReturnTo = storedReturnTo
          ? getReturnTo({ query: { return_to: storedReturnTo } }, '/')
          : (mobileFlow ? 'misochat://auth/callback' : '/');

        if (mobileFlow) {
          const token = issueMobileAuthToken(user);
          const target = new URL('/auth/mobile-complete', `${req.protocol}://${req.get('host')}`);
          target.searchParams.set('token', token);
          target.searchParams.set('return_to', safeReturnTo);
          return res.redirect(target.toString());
        }

        return res.redirect(safeReturnTo);
      });
    });
  })(req, res, next);
});
app.post('/logout', (req, res) => {
  req.logout((logoutErr) => {
    if (logoutErr) {
      console.error('Logout error:', logoutErr.message || logoutErr);
    }

    req.session?.destroy(() => {
      res.clearCookie('connect.sid');
      if (process.env.OIDC_ENABLED === 'true' && process.env.OIDC_ISSUER) {
        // Redirect to OIDC provider's logout endpoint, then to a page that forces re-auth
        // The prompt=login parameter ensures the user must re-authenticate even if their
        // OIDC session still exists (prevents auto-login after logout)
        const logoutUrl = new URL(process.env.OIDC_ISSUER + '/logout/');
        logoutUrl.searchParams.set('next', encodeURIComponent(req.protocol + '://' + req.get('host') + '/login?prompt=login'));
        return res.redirect(logoutUrl.toString());
      }
      return res.redirect('/login');
    });
  });
});

app.get('/auth/mobile-complete', (req, res) => {
  const token = typeof req.query?.token === 'string' ? req.query.token : '';
  const returnTo = getReturnTo(req, '/');

  if (!token) {
    return res.status(400).send('Missing mobile auth token');
  }

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Returning to app…</title></head>
<body style="font-family: system-ui, sans-serif; background:#0d0d14; color:#fff; display:grid; place-items:center; min-height:100vh; margin:0;">
  <div style="max-width:520px; padding:24px; text-align:center;">
    <h2>Login successful</h2>
    <p>Returning to the app…</p>
    <p><a id="openApp" href="#" style="color:#7ab7ff">Tap here if nothing happens</a></p>
  </div>
  <script>
    const appTarget = new URL(${JSON.stringify(returnTo)});
    appTarget.searchParams.set('mobile_token', ${JSON.stringify(token)});
    const href = appTarget.toString();
    document.getElementById('openApp').href = href;
    window.location.replace(href);
  </script>
</body></html>`;

  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(html);
});

app.post('/api/mobile-auth/consume', (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const user = consumeMobileAuthToken(token);
  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  return establishLoginSession(req, user, (err) => {
    if (err) {
      console.error('Mobile auth session setup failed:', err.message || err);
      return res.status(500).json({ error: 'Failed to establish session' });
    }

    return persistLoginSession(req, (saveErr) => {
      if (saveErr) {
        console.error('Mobile auth session persist failed:', saveErr.message || saveErr);
        return res.status(500).json({ error: 'Failed to establish session' });
      }

      return res.json({ ok: true });
    });
  });
});

// Protected routes
app.get('/', isAuthenticated, (req, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/api/auth', (req, res) => res.json({
  authenticated: authMode === 'none' ? true : req.isAuthenticated(),
  user: req.user,
  oidc: oidcEnabled,
  authMode,
  requiresAuth: authMode !== 'none',
}));

let gatewayWsLastError = '';
let gatewayWsLastClose = null;

app.get('/api/health', (req, res) => {
  res.json({
    status: 'healthy',
    version: APP_VERSION,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    gatewayWsConnected: gatewayWsManager?.isConnected?.() || false,
    gatewayWsReconnectAttempts: gatewayWsManager?.reconnectAttempts || 0,
    gatewayWsLastError,
    gatewayWsLastClose,
  });
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

  if (isForbiddenLinkPreviewHost(targetUrl.hostname)) {
    return res.status(400).json({ error: 'Local/private hosts are not allowed for previews' });
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), LINK_PREVIEW_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': LINK_PREVIEW_USER_AGENT,
      },
    });

    if (!response.ok) {
      return res.status(502).json({ error: `Upstream request failed (${response.status})` });
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      return res.status(422).json({ error: 'URL does not point to an HTML document' });
    }

    const html = (await response.text()).slice(0, LINK_PREVIEW_MAX_HTML_CHARS);
    const finalUrl = response.url || targetUrl.toString();
    const preview = extractLinkPreviewData(html, finalUrl);

    return res.json(preview);
  } catch (error) {
    if (error?.name === 'AbortError') {
      return res.status(504).json({ error: `Preview fetch timed out after ${LINK_PREVIEW_TIMEOUT_MS}ms` });
    }
    console.warn('Link preview fetch failed:', error.message || error);
    return res.status(502).json({ error: 'Unable to fetch link preview' });
  } finally {
    clearTimeout(timeoutHandle);
  }
});

// GET /api/openclaw-status - Return native OpenClaw session status card/details
app.get('/api/openclaw-status', isAuthenticated, async (req, res) => {
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
app.post('/api/openclaw-stop', isAuthenticated, async (req, res) => {
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
function inferAgentNameFromKey(sessionKey) {
  if (!sessionKey || typeof sessionKey !== "string") return null;
  
  // Handle agent:agentName:thread format (most common)
  if (sessionKey.startsWith("agent:")) {
    const parts = sessionKey.split(":");
    if (parts.length >= 2) {
      const agentName = parts[1];
      // Capitalize first letter, replace dashes/underscores with spaces
      return agentName
        .replace(/[-_]/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
    }
  }
  
  return null;
}

const CHAT_DISPLAY_NAME = process.env.CHAT_DISPLAY_NAME || process.env.ASSISTANT_NAME || 'Miso';
const APP_TITLE = process.env.APP_TITLE || `${CHAT_DISPLAY_NAME} Chat`;
const DEFAULT_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || process.env.MISO_CHAT_SESSION_KEY || 'agent:main:main';
const PUSH_NOTIFICATIONS_ENABLED = parseBooleanEnv(process.env.PUSH_NOTIFICATIONS_ENABLED, false);
const PUSH_VAPID_PUBLIC_KEY = String(process.env.PUSH_VAPID_PUBLIC_KEY || '').trim();
const PUSH_VAPID_PRIVATE_KEY = String(process.env.PUSH_VAPID_PRIVATE_KEY || '').trim();
const PUSH_VAPID_SUBJECT = String(process.env.PUSH_VAPID_SUBJECT || '').trim();
const PUSH_CONFIG_READY = Boolean(PUSH_VAPID_PUBLIC_KEY && PUSH_VAPID_PRIVATE_KEY && PUSH_VAPID_SUBJECT);

if (PUSH_NOTIFICATIONS_ENABLED && !PUSH_CONFIG_READY) {
  throw new Error('PUSH_NOTIFICATIONS_ENABLED=true requires PUSH_VAPID_PUBLIC_KEY, PUSH_VAPID_PRIVATE_KEY, and PUSH_VAPID_SUBJECT');
}

app.get('/api/config', (req, res) => {
  res.json({
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
    attachments: {
      maxBytes: MAX_ATTACHMENT_BYTES,
      allowedTypes: Array.from(ALLOWED_ATTACHMENT_TYPES),
      uploadPath: '/api/attachments',
    },
  });
});

// SSE endpoint for real-time gateway events (typing, message delta, errors)
app.get('/api/events', isAuthenticated, (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  // Add client to connected set
  sseClients.add(res);
  console.log(`📡 SSE client connected (${sseClients.size} total)`);

  // Remove client on close
  req.on('close', () => {
    sseClients.delete(res);
    console.log(`📡 SSE client disconnected (${sseClients.size} total)`);
  });
});

// Helper to broadcast events to all SSE clients
function broadcastToSseClients(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`);
  }
}

// ============ GATEWAY HTTP API ============

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || (() => {
  try {
    const parsed = new URL(GATEWAY_URL);
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    return parsed.toString();
  } catch {
    return 'ws://openclaw.llm.svc.cluster.local:18789';
  }
})();

// Helper function to get GATEWAY_WS_URL value (handles both string and function types)
const getGatewayWsUrl = () => typeof GATEWAY_WS_URL === 'function' ? GATEWAY_WS_URL() : GATEWAY_WS_URL;
const GATEWAY_WS_ORIGIN = process.env.GATEWAY_WS_ORIGIN || '';
const GATEWAY_WS_CLIENT_ID = process.env.GATEWAY_WS_CLIENT_ID || 'webchat-ui';
const GATEWAY_WS_CLIENT_MODE = process.env.GATEWAY_WS_CLIENT_MODE || 'webchat';
const GATEWAY_DEVICE_IDENTITY_PATH = process.env.GATEWAY_DEVICE_IDENTITY_PATH
  || path.join(process.env.HOME || '/home/node', '.openclaw', 'identity', 'device.json');
const GATEWAY_WS_WAIT_CHALLENGE_MS = Number(process.env.GATEWAY_WS_WAIT_CHALLENGE_MS || 1200);

// Persistent WebSocket manager for gateway connections
const REQUESTED_GATEWAY_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.pairing',
  'chat.send',
  'sessions.send',
  'sessions.list',
  'sessions.history',
];

const gatewayWsManager = new GatewayWsManager({
  wsUrl: getGatewayWsUrl(),
  clientId: GATEWAY_WS_CLIENT_ID,
  clientMode: GATEWAY_WS_CLIENT_MODE,
  token: GATEWAY_TOKEN,
  role: 'operator',
  scopes: REQUESTED_GATEWAY_SCOPES,
  waitChallengeMs: GATEWAY_WS_WAIT_CHALLENGE_MS,
  buildDeviceAuth: ({ nonce, scopes }) => buildGatewayDeviceAuth({ nonce, scopes }),
  headers: {
    ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
    ...(GATEWAY_WS_ORIGIN ? { Origin: GATEWAY_WS_ORIGIN } : {}),
  },
  maxReconnectAttempts: Number(process.env.GATEWAY_WS_MAX_RECONNECT_ATTEMPTS || 0), // 0 = unlimited
  reconnectDelay: 1000,
  reconnectBackoff: 2,
});

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
let cachedGatewayDeviceIdentity = null;

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
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
  return [
    'v2',
    deviceId,
    clientId,
    clientMode,
    role,
    scopesList.join(','),
    String(signedAtMs),
    token || '',
    nonce,
  ].join('|');
}

function fingerprintPublicKeyPem(publicKeyPem) {
  const raw = derivePublicKeyRawFromPem(publicKeyPem);
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function persistGatewayDeviceIdentity(identity) {
  try {
    fs.mkdirSync(path.dirname(GATEWAY_DEVICE_IDENTITY_PATH), { recursive: true });
    fs.writeFileSync(GATEWAY_DEVICE_IDENTITY_PATH, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(GATEWAY_DEVICE_IDENTITY_PATH, 0o600);
    } catch {}
  } catch {}
}

function ensureGatewayDeviceIdentity() {
  if (cachedGatewayDeviceIdentity !== null) return cachedGatewayDeviceIdentity;

  // Try to load existing and self-heal bad deviceId derivation if needed.
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

        cachedGatewayDeviceIdentity = {
          deviceId,
          publicKey,
          privateKeyPem: parsed.privateKeyPem,
        };
        return cachedGatewayDeviceIdentity;
      }
    }
  } catch {}

  // Generate new identity
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const deviceId = fingerprintPublicKeyPem(publicKeyPem);
  const identity = {
    version: 1,
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };
  persistGatewayDeviceIdentity(identity);

  cachedGatewayDeviceIdentity = {
    deviceId,
    publicKey: base64UrlEncode(derivePublicKeyRawFromPem(publicKeyPem)),
    privateKeyPem,
  };
  return cachedGatewayDeviceIdentity;
}

function loadGatewayDeviceIdentity() {
  if (cachedGatewayDeviceIdentity !== null) return cachedGatewayDeviceIdentity;

  try {
    const raw = fs.readFileSync(GATEWAY_DEVICE_IDENTITY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed?.publicKeyPem || !parsed?.privateKeyPem) {
      cachedGatewayDeviceIdentity = null;
      return null;
    }

    const publicKey = base64UrlEncode(derivePublicKeyRawFromPem(parsed.publicKeyPem));
    const deviceId = fingerprintPublicKeyPem(parsed.publicKeyPem);
    cachedGatewayDeviceIdentity = {
      deviceId,
      publicKey,
      privateKeyPem: parsed.privateKeyPem,
    };
    return cachedGatewayDeviceIdentity;
  } catch {
    cachedGatewayDeviceIdentity = null;
    return null;
  }
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

  const signature = base64UrlEncode(
    crypto.sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem))
  );

  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature,
    signedAt,
    nonce,
  };
}

function extractConnectChallengeNonce(frame) {
  if (!frame || typeof frame !== 'object') return '';

  if (frame.type === 'connect.challenge' && typeof frame.nonce === 'string') {
    return frame.nonce;
  }

  if (frame.type === 'event' && frame.event === 'connect.challenge' && typeof frame.payload?.nonce === 'string') {
    return frame.payload.nonce;
  }

  return '';
}

// Helper to call gateway via HTTP
function gatewayInvoke(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const url = new URL('/tools/invoke', GATEWAY_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${GATEWAY_TOKEN}`
      }
    };

    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.ok) return resolve(json.result);
          return reject(new Error(json.error?.message || 'Gateway invoke failed'));
        } catch {
          return reject(new Error(`Invalid gateway response: ${String(data).slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
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

function extractReplyText(reply) {
  if (!reply) return '';
  if (typeof reply === 'string') return reply;
  if (Array.isArray(reply)) {
    return reply.map((x) => extractReplyText(x)).filter(Boolean).join('\n');
  }
  if (typeof reply.text === 'string') return reply.text;
  if (typeof reply.message === 'string') return reply.message;
  if (typeof reply.content === 'string') return reply.content;
  if (Array.isArray(reply.content)) {
    return reply.content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Extract model name from reply payload. */
function extractReplyModel(reply) {
  if (!reply) return null;
  if (typeof reply === 'string') return null;
  if (typeof reply.model === 'string') return reply.model;
  if (typeof reply.response?.model === 'string') return reply.response.model;
  if (typeof reply.data?.model === 'string') return reply.data.model;
  if (typeof reply.details?.model === 'string') return reply.details.model;
  return null;
}

/** Normalize a single tool call from OpenAI (tool_calls) or Anthropic (tool_use) style. */
function normalizeToolCall(part) {
  if (part?.type === 'tool_calls' && Array.isArray(part.tool_calls)) {
    return part.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name || tc.name || 'tool',
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments || {}),
      result: tc.result,
      error: tc.error,
      status: tc.error ? 'error' : (tc.result !== undefined ? 'success' : 'calling'),
    }));
  }
  if (part?.type === 'tool_use') {
    const name = part.name || part.tool_use?.name || 'tool';
    const args = part.input ?? part.tool_use?.input ?? {};
    return [{
      id: part.id || part.tool_use?.id,
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
      result: part.result,
      error: part.error,
      status: part.error ? 'error' : (part.result !== undefined ? 'success' : 'calling'),
    }];
  }
  return [];
}

function extractReplyToolCalls(reply) {
  const out = [];
  function walk(r) {
    if (!r) return;
    if (Array.isArray(r)) {
      r.forEach(walk);
      return;
    }
    if (typeof r !== 'object') return;
    if (Array.isArray(r.content)) {
      r.content.forEach((p) => {
        const list = normalizeToolCall(p);
        list.forEach((tc) => out.push(tc));
      });
    }
    if (Array.isArray(r.tool_calls)) {
      normalizeToolCall({ type: 'tool_calls', tool_calls: r.tool_calls }).forEach((tc) => out.push(tc));
    }
    walk(r.reply);
    walk(r.response);
    walk(r.details?.reply);
  }
  walk(reply);
  return out;
}

function buildGatewayWsHeaders({ origin } = {}) {
  const headers = {};
  if (GATEWAY_TOKEN) {
    headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;
  }
  // Must match gateway.controlUi.allowedOrigins
  const requestOrigin = typeof origin === 'string' ? origin.trim() : '';
  const wsOrigin = requestOrigin || GATEWAY_WS_ORIGIN;
  if (wsOrigin) {
    headers.Origin = wsOrigin;
  }
  return headers;
}

function createRequestId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseGatewayFrame(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
  try {
    return JSON.parse(text);
  } catch {
    return { type: 'text', text };
  }
}

function frameMatchesId(frame, id) {
  if (!frame || !id) return false;
  return frame.id === id || frame.requestId === id || frame.replyTo === id;
}

function extractGatewayError(frame) {
  if (!frame) return '';
  if (typeof frame.error === 'string') return frame.error;
  if (frame.error?.message) return frame.error.message;
  if (frame.message && frame.status === 'error') return frame.message;
  return '';
}

function extractGatewayResult(frame) {
  if (!frame) return null;
  if (frame.result !== undefined) return frame.result;
  if (frame.reply !== undefined) return frame.reply;
  if (frame.data !== undefined) return frame.data;
  if (frame.payload !== undefined) return frame.payload;
  return frame;
}

// Use persistent WebSocket manager if available and connected, otherwise fall back to per-request WS
async function gatewayChatSendWithManager({ sessionKey, message, timeoutSeconds }) {
  if (!gatewayWsManager.isConnected()) {
    return null; // Signal to use fallback
  }

  // gatewayWsManager.send() handles timeouts internally
  try {
    const frame = await gatewayWsManager.send('chat.send', {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: gatewayWsManager.createRequestId('msg'),
    }, timeoutSeconds || 180);

    const error = extractGatewayError(frame);
    if (error) {
      throw new Error(error);
    }
    return extractGatewayResult(frame);
  } catch (err) {
    throw err; // Let main function handle fallback
  }
}

// Per-request WebSocket fallback (original implementation)
function gatewayChatSendFallback({ sessionKey, message, timeoutSeconds, origin }) {
  return new Promise((resolve, reject) => {
    const wsUrl = getGatewayWsUrl();
    const ws = new WebSocket(wsUrl, { headers: buildGatewayWsHeaders({ origin }) });
    const connectId = createRequestId('connect');
    const sendId = createRequestId('chat-send');
    const timeoutMs = Math.max(1000, Number(timeoutSeconds || 180) * 1000);

    let closed = false;
    let connected = false;

    const done = (err, result) => {
      if (closed) return;
      closed = true;
      clearTimeout(timeout);
      if (challengeWaitTimer) {
        clearTimeout(challengeWaitTimer);
        challengeWaitTimer = null;
      }
      try {
        ws.close();
      } catch {
        // noop
      }
      if (err) return reject(err);
      return resolve(result);
    };

    const timeout = setTimeout(() => {
      done(new Error(`Gateway websocket timeout after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const requestedScopes = ['operator.read', 'operator.write', 'operator.pairing', 'chat.send', 'sessions.send', 'sessions.list', 'sessions.history'];
    const hasDeviceIdentity = Boolean(ensureGatewayDeviceIdentity());
    let connectSent = false;
    let challengeWaitTimer = null;

    const sendConnect = (nonce = '') => {
      if (connectSent) return;
      connectSent = true;
      if (challengeWaitTimer) {
        clearTimeout(challengeWaitTimer);
        challengeWaitTimer = null;
      }

      const deviceAuth = nonce ? buildGatewayDeviceAuth({ nonce, scopes: requestedScopes }) : null;

      ws.send(
        JSON.stringify({
          type: 'req',
          id: connectId,
          method: 'connect',
          params: {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              id: GATEWAY_WS_CLIENT_ID,
              version: 'miso-chat/1.0.0',
              platform: process.platform,
              mode: GATEWAY_WS_CLIENT_MODE,
            },
            role: 'operator',
            scopes: requestedScopes,
            caps: [],
            ...(GATEWAY_TOKEN
              ? {
                  auth: {
                    token: GATEWAY_TOKEN,
                  },
                }
              : {}),
            ...(deviceAuth ? { device: deviceAuth } : {}),
          },
        })
      );
    };

    ws.on('open', () => {
      if (hasDeviceIdentity) {
        challengeWaitTimer = setTimeout(() => {
          console.warn('Gateway connect.challenge not received in time; falling back to unsigned connect request');
          sendConnect('');
        }, Math.max(200, GATEWAY_WS_WAIT_CHALLENGE_MS));
      } else {
        sendConnect('');
      }
    });

    ws.on('message', (raw) => {
      const frame = parseGatewayFrame(raw);
      if (closed) return;

      if (!connected) {
        const challengeNonce = extractConnectChallengeNonce(frame);
        if (challengeNonce) {
          sendConnect(challengeNonce);
          return;
        }

        if (frameMatchesId(frame, connectId) || frame.type === 'connected' || frame.type === 'connect.ok') {
          const connectError = extractGatewayError(frame);
          if (connectError) {
            return done(new Error(connectError));
          }

          connected = true;
          ws.send(
            JSON.stringify({
              type: 'req',
              id: sendId,
              method: 'chat.send',
              params: {
                sessionKey,
                message,
                deliver: false,
                idempotencyKey: createRequestId('msg'),
              },
            })
          );
          return;
        }

        if (frame.type === 'error' || frame.status === 'error') {
          const err = extractGatewayError(frame) || 'Gateway connect failed';
          return done(new Error(err));
        }

        return;
      }

      if (frameMatchesId(frame, sendId) || frame.type === 'chat.send.ok' || frame.type === 'chat.send.result') {
        const sendError = extractGatewayError(frame);
        if (sendError) {
          return done(new Error(sendError));
        }
        return done(null, extractGatewayResult(frame));
      }
    });

    ws.on('error', (error) => {
      done(error);
    });

    ws.on('close', () => {
      if (!closed) {
        done(new Error('Gateway websocket closed before chat.send response'));
      }
    });
  });
}

// Main gatewayChatSend - tries persistent manager first, falls back to per-request
async function gatewayChatSend({ sessionKey, message, timeoutSeconds, origin }) {
  // Try persistent manager first
  try {
    const result = await gatewayChatSendWithManager({ sessionKey, message, timeoutSeconds });
    if (result !== null) {
      return result; // Used persistent manager successfully
    }
  } catch (err) {
    console.warn('⚠️ Persistent WS manager failed, falling back to per-request:', err.message);
  }
  
  // Fall back to per-request WebSocket
  return gatewayChatSendFallback({ sessionKey, message, timeoutSeconds, origin });
}

const ANNOUNCE_NOISE_MARKERS = ['ANNOUNCE_SKIP', 'Agent-to-agent announce step.'];
function isAnnounceNoiseLine(line) {
  const value = (line || '').trim();
  if (!value) return false;
  return ANNOUNCE_NOISE_MARKERS.some((marker) =>
    marker === 'ANNOUNCE_SKIP' ? value.includes(marker) : value === marker
  );
}

function sanitizeAssistantText(text) {
  const value = typeof text === 'string' ? text : '';
  if (!value.trim()) return '';

  const cleaned = value
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !isAnnounceNoiseLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return cleaned;
}

// GET /api/sessions - List all sessions via gateway
app.get('/api/sessions', isAuthenticated, async (req, res) => {
  try {
    let rawSessions = [];

    const baseSessionsParams = {
      limit: 200,
      includeLastMessage: true,
      includeDerivedTitles: true,
    };

    const wsSessionsList = async () => {
      try {
        return await gatewayWsManager.send('sessions.list', { ...baseSessionsParams, includeArchived: true }, 15);
      } catch (err) {
        if (String(err?.message || '').includes('includeArchived')) {
          return gatewayWsManager.send('sessions.list', baseSessionsParams, 15);
        }
        throw err;
      }
    };

    const toolSessionsList = async () => {
      try {
        return await gatewayInvoke('sessions_list', { ...baseSessionsParams, includeArchived: true });
      } catch (err) {
        if (String(err?.message || '').includes('includeArchived')) {
          return gatewayInvoke('sessions_list', baseSessionsParams);
        }
        throw err;
      }
    };

    if (gatewayWsManager?.isConnected?.()) {
      try {
        const wsFrame = await wsSessionsList();
        // Handle multiple possible response structures from gateway
        if (wsFrame?.result?.sessions) {
          rawSessions = wsFrame.result.sessions;
        } else if (wsFrame?.sessions) {
          rawSessions = wsFrame.sessions;
        } else if (Array.isArray(wsFrame)) {
          rawSessions = wsFrame;
        } else if (wsFrame && typeof wsFrame === 'object') {
          // Try to find sessions array in any property
          const possibleSessionKeys = ['sessions', 'data', 'items', 'list'];
          for (const key of possibleSessionKeys) {
            if (Array.isArray(wsFrame[key])) {
              rawSessions = wsFrame[key];
              break;
            }
          }
        }
        console.log('[sessions.list] WS response structure:', JSON.stringify({
          hasResultSessions: !!wsFrame?.result?.sessions,
          hasSessions: !!wsFrame?.sessions,
          isArray: Array.isArray(wsFrame),
          keys: wsFrame ? Object.keys(wsFrame) : [],
          rawSessionCount: rawSessions.length
        }));
      } catch (wsErr) {
        console.warn('sessions.list via WS failed, falling back to tools invoke:', wsErr.message);
      }
    }

    if (!Array.isArray(rawSessions) || rawSessions.length === 0) {
      console.log('[sessions.list] WS returned no sessions, trying tool invoke');
      const result = await toolSessionsList();
      const payload = unwrapToolResult(result);
      rawSessions = payload?.sessions || payload?.data || payload?.items || [];
      console.log('[sessions.list] Tool response session count:', rawSessions.length);
    }

    const sessions = rawSessions
      .map((s, idx) => {
        const sessionKey = s.key || s.sessionKey || s.sessionId;
        if (!sessionKey) {
          console.log(`[sessions.list] Session ${idx} has no sessionKey, skipping. Keys:`, Object.keys(s || {}));
          return null;
        }
        if (sessionKey.includes(':cron:')) {
          console.log(`[sessions.list] Session ${idx} is a cron session, skipping: ${sessionKey}`);
          return null;
        }

        const inferredAgentName = inferAgentNameFromKey(sessionKey);
        return {
          sessionKey,
          displayName: s.displayName || s.derivedTitle || s.title || s.agentName || inferredAgentName || sessionKey,
          updatedAt: s.updatedAt,
          kind: s.kind,
          channel: s.channel,
          lastMessage: s.lastMessage,
          title: s.derivedTitle || s.title || s.displayName,
          agentId: s.agentId,
          agentName: s.agentName || inferredAgentName,
        };
      })
      .filter(Boolean);

    console.log('[sessions.list] Final session count after filtering:', sessions.length);
    if (sessions.length > 0) {
      console.log('[sessions.list] Session keys:', sessions.map(s => s.sessionKey));
    }

    const deduped = [];
    const seen = new Set();
    for (const s of sessions) {
      if (!s?.sessionKey || seen.has(s.sessionKey)) continue;
      seen.add(s.sessionKey);
      deduped.push(s);
    }

    console.log('[sessions.list] Final deduplicated session count:', deduped.length);
    res.json({ sessions: deduped, defaultSessionKey: DEFAULT_SESSION_KEY });
  } catch (error) {
    console.error('Error listing sessions:', error.message);
    res.json({ sessions: [], error: error.message });
  }
});

// GET /api/sessions/:sessionKey/history - Get session history via gateway
app.get('/api/sessions/:sessionKey/history', isAuthenticated, async (req, res) => {
  try {
    const { sessionKey } = req.params;
    const result = await gatewayInvoke('sessions_history', { sessionKey, limit: 100 });
    const payload = unwrapToolResult(result);
    const raw = payload?.history || payload?.messages || [];

    // Get reactions for this session (grouped by message_id)
    const sessionReactions = reactions.getForSession(sessionKey);

    const messages = raw
      .map((m) => {
        const role = m.role || 'assistant';
        let content;
        let toolCalls = [];

        if (typeof m.content === 'string') {
          content = m.content;
        } else if (Array.isArray(m.content)) {
          const textParts = [];
          m.content.forEach((p) => {
            if (typeof p === 'string') {
              textParts.push(p);
            } else if (p?.text) {
              textParts.push(p.text);
            } else if (p?.content) {
              textParts.push(p.content);
            } else {
              const list = normalizeToolCall(p);
              list.forEach((tc) => toolCalls.push(tc));
            }
          });
          content = textParts.filter(Boolean).join('\n');
        } else {
          content = m.content?.text || m.text || JSON.stringify(m.content || '');
        }

        const messageId =
          m.messageId ||
          m.message_id ||
          m.id ||
          m.externalMessageId ||
          m.external_id ||
          null;

        const text = role === 'assistant' ? sanitizeAssistantText(content) : content;
        const hasContent = typeof text === 'string' && text.trim().length > 0;
        const hasToolCalls = toolCalls.length > 0;
        if (!hasContent && !hasToolCalls) return null;

        const reactionEvent = role === 'system' ? parseGatewayReactionEvent(text) : null;

        // Get reaction counts for this message (match by timestamp prefix or gateway message id)
        const timestamp = m.timestamp;
        const messageReactions = [];
        if (sessionReactions) {
          for (const [msgId, emojis] of Object.entries(sessionReactions)) {
            const matchesTimestamp = timestamp
              && (msgId.startsWith(`history:${timestamp}:`) || msgId.startsWith(`reply:${timestamp}:`) || msgId.startsWith(`queued:${timestamp}`));
            const matchesGatewayId = messageId && msgId === `gateway:${messageId}`;
            if (matchesTimestamp || matchesGatewayId) {
              for (const [emoji, users] of Object.entries(emojis)) {
                messageReactions.push({ emoji, count: users.length });
              }
            }
          }
        }

        return {
          role,
          content: hasContent ? text : (hasToolCalls ? ' ' : ''),
          timestamp: m.timestamp,
          ...(messageId ? { messageId: String(messageId) } : {}),
          ...(reactionEvent ? { reactionEvent } : {}),
          ...(hasToolCalls ? { toolCalls } : {}),
          ...(messageReactions.length > 0 ? { reactions: messageReactions } : {}),
          ...(m.model ? { model: m.model } : {}),
        };
      })
      .filter(Boolean);
    res.json({ sessionKey, messages });
  } catch (error) {
    console.error('Error getting history:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/attachments - Upload one image attachment
app.post('/api/attachments', isAuthenticated, (req, res) => {
  uploadAttachment.single('file')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `Attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`,
          maxBytes: MAX_ATTACHMENT_BYTES,
        });
      }

      return res.status(400).json({
        error: error.message || 'Attachment upload failed',
        allowedTypes: Array.from(ALLOWED_ATTACHMENT_TYPES),
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Attachment file is required' });
    }

    const attachmentUrl = `/uploads/${encodeURIComponent(req.file.filename)}`;
    return res.json({
      success: true,
      attachment: {
        url: attachmentUrl,
        name: sanitizeAttachmentName(req.file.originalname),
        type: req.file.mimetype,
        size: req.file.size,
      },
    });
  });
});

// POST /api/sessions/:sessionKey/send - Send message via gateway
app.post('/api/sessions/:sessionKey/send', isAuthenticated, async (req, res) => {
  const requestedSessionKey = req.params.sessionKey;
  const sessionKey = requestedSessionKey && requestedSessionKey !== 'default'
    ? requestedSessionKey
    : DEFAULT_SESSION_KEY;
  const rawMessage = req.body?.message;

  if (typeof rawMessage !== 'string') {
    return res.status(400).json({ error: 'Message must be a string' });
  }

  const message = rawMessage.trim();
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(413).json({
      error: `Message exceeds ${MAX_CHAT_MESSAGE_LENGTH} characters`,
      maxLength: MAX_CHAT_MESSAGE_LENGTH,
    });
  }

  console.log(`Sending to ${sessionKey}: [message hidden]`);

  // Broadcast typing indicator start
  broadcastToSseClients('typing.start', { sessionKey, timestamp: Date.now() });

  try {
    const timeoutSeconds = Number(process.env.SEND_TIMEOUT_SECONDS || 180);
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const payload = await gatewayChatSend({ sessionKey, message, timeoutSeconds, origin: requestOrigin });
    const replyPayload = payload?.reply || payload?.response || payload?.details?.reply || payload;
    const responseText = extractReplyText(replyPayload);
    const filteredResponseText = sanitizeAssistantText(responseText);
    const toolCalls = extractReplyToolCalls(replyPayload);
    const model = extractReplyModel(replyPayload);

    res.json({ success: true, response: payload, responseText: filteredResponseText, toolCalls, model });
  } catch (error) {
    console.error('Error sending:', error.message);
    const msg = String(error.message || 'send failed');
    if (msg.includes('invalid connect params')) {
      return res.status(500).json({
        error:
          'Gateway rejected websocket connect params. Verify Origin is allowed, and ensure device identity is available at GATEWAY_DEVICE_IDENTITY_PATH so websocket scopes (operator.write) can be granted.',
      });
    }
    res.status(500).json({ error: msg });
  } finally {
    // Broadcast typing indicator stop
    broadcastToSseClients('typing.stop', { sessionKey, timestamp: Date.now() });
  }
});

// POST /api/sessions/:sessionKey/send-stream - Stream message response via SSE
app.post('/api/sessions/:sessionKey/send-stream', isAuthenticated, async (req, res) => {
  const requestedSessionKey = req.params.sessionKey;
  const sessionKey = requestedSessionKey && requestedSessionKey !== 'default'
    ? requestedSessionKey
    : DEFAULT_SESSION_KEY;
  const rawMessage = req.body?.message;

  if (typeof rawMessage !== 'string') {
    return res.status(400).json({ error: 'Message must be a string' });
  }

  const message = rawMessage.trim();
  if (!message) {
    return res.status(400).json({ error: 'Message is required' });
  }
  if (message.length > MAX_CHAT_MESSAGE_LENGTH) {
    return res.status(413).json({
      error: `Message exceeds ${MAX_CHAT_MESSAGE_LENGTH} characters`,
      maxLength: MAX_CHAT_MESSAGE_LENGTH,
    });
  }

  console.log(`Streaming to ${sessionKey}: [message hidden]`);

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send initial connection event
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);

  // Broadcast typing indicator start
  broadcastToSseClients('typing.start', { sessionKey, timestamp: Date.now() });

  try {
    const timeoutSeconds = Number(process.env.SEND_TIMEOUT_SECONDS || 180);
    const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const payload = await gatewayChatSend({ sessionKey, message, timeoutSeconds, origin: requestOrigin });
    const replyPayload = payload?.reply || payload?.response || payload?.details?.reply || payload;
    const responseText = extractReplyText(replyPayload);
    const filteredResponseText = sanitizeAssistantText(responseText);
    const toolCalls = extractReplyToolCalls(replyPayload);
    const model = extractReplyModel(replyPayload);

    // Send the complete response as a single "complete" event
    // This simulates streaming by sending all tokens at once
    // In the future, if gateway supports streaming, this can be enhanced
    res.write(`data: ${JSON.stringify({ 
      type: 'complete', 
      responseText: filteredResponseText, 
      toolCalls, 
      model,
      timestamp: Date.now() 
    })}\n\n`);

    // Send done event
    res.write(`data: ${JSON.stringify({ type: 'done', timestamp: Date.now() })}\n\n`);
    res.end();
  } catch (error) {
    console.error('Error streaming:', error.message);
    const msg = String(error.message || 'stream failed');
    res.write(`data: ${JSON.stringify({ type: 'error', error: msg, timestamp: Date.now() })}\n\n`);
    res.end();
  } finally {
    // Broadcast typing indicator stop
    broadcastToSseClients('typing.stop', { sessionKey, timestamp: Date.now() });
  }
});

// ============ REACTION API ENDPOINTS ============

// GET /api/reactions/:sessionKey - Get all reactions for a session (batch load)
app.get('/api/reactions/:sessionKey', isAuthenticated, (req, res) => {
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
app.get('/api/messages/:messageId/reactions', isAuthenticated, (req, res) => {
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
app.post('/api/messages/:messageId/reactions', isAuthenticated, (req, res) => {
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

const PORT = process.env.PORT || 3000;

// Initialize WebSocket manager at startup
const initGatewayWsManager = async () => {
  try {
    const origin = GATEWAY_WS_ORIGIN || 'http://localhost:3000';
    await gatewayWsManager.connect(origin);
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
      gatewayWsLastClose = {
        code,
        reason: typeof reason === 'string' ? reason : String(reason || ''),
        at: new Date().toISOString(),
      };
      const pendingCount = gatewayWsManager.getPendingRequestCount();
      console.log(`🔌 Gateway WS closed: ${code} ${reason} (pending: ${pendingCount})`);
    });
    
    gatewayWsManager.on('connected', () => {
      const pendingRecovered = gatewayWsManager.getPendingForRecoveryCount();
      if (pendingRecovered > 0) {
        console.log(`✅ Gateway WS reconnected with ${pendingRecovered} pending requests recovered`);
      } else {
        console.log('✅ Gateway WS manager connected');
      }
    });
    
    gatewayWsManager.on('error', (err) => {
      gatewayWsLastError = String(err?.message || err || 'unknown error');
      console.error('⚠️ Gateway WS error:', err.message);
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
server.listen(PORT, async () => {
  console.log(`
🎉 ${APP_TITLE} server running on port ${PORT}
   
   Gateway: ${GATEWAY_URL}
   Gateway WS: ${getGatewayWsUrl()}
   Gateway WS Origin: ${GATEWAY_WS_ORIGIN || '(none)'}
   Gateway WS Client: ${GATEWAY_WS_CLIENT_ID} (${GATEWAY_WS_CLIENT_MODE})
   Gateway Device Identity: ${fs.existsSync(GATEWAY_DEVICE_IDENTITY_PATH) ? GATEWAY_DEVICE_IDENTITY_PATH : 'missing'}
   Default Session: ${DEFAULT_SESSION_KEY}
   Push Notifications: ${PUSH_NOTIFICATIONS_ENABLED ? `enabled (${PUSH_CONFIG_READY ? 'configured' : 'misconfigured'})` : 'disabled'}
   Auth: ${process.env.OIDC_ENABLED === 'true' ? 'OIDC' : 'Local'}
   Node Env: ${process.env.NODE_ENV || 'development'}
   
   Login: http://localhost:${PORT}/login
   
   API:
   - GET  /api/sessions
   - GET  /api/sessions/:key/history
   - POST /api/sessions/:key/send
  `);
  
  // Initialize persistent WebSocket manager
  await initGatewayWsManager();
});

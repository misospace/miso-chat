const express = require('express');
const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const http = require('http');
const WebSocket = require('ws');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const cors = require('cors');
const https = require('https');
const fs = require('fs');
const path = require('path');
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
const CHAT_DISPLAY_NAME = process.env.CHAT_DISPLAY_NAME || process.env.ASSISTANT_NAME || 'Miso';
const APP_TITLE = process.env.APP_TITLE || `${CHAT_DISPLAY_NAME} Chat`;
const DEFAULT_SESSION_KEY = process.env.OPENCLAW_SESSION_KEY || process.env.MISO_CHAT_SESSION_KEY || process.env.DEFAULT_SESSION_KEY || 'agent:main:main';
const PUSH_NOTIFICATIONS_ENABLED = process.env.PUSH_NOTIFICATIONS_ENABLED === 'true';
const PUSH_VAPID_PUBLIC_KEY = String(process.env.PUSH_VAPID_PUBLIC_KEY || process.env.VAPID_PUBLIC_KEY || '').trim();
const PUSH_CONFIG_READY = Boolean(PUSH_VAPID_PUBLIC_KEY && (process.env.PUSH_VAPID_PRIVATE_KEY || process.env.VAPID_PRIVATE_KEY) && (process.env.PUSH_VAPID_SUBJECT || process.env.PUSH_SUBJECT));

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
    if (typeof cfIp === 'string' && cfIp.trim()) {
      return ipKeyGenerator(cfIp.trim());
    }

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return ipKeyGenerator(forwarded.split(',')[0].trim());
    }

    return ipKeyGenerator(req.ip);
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
  console.log('[MobileAuth] consume endpoint called');
  console.log('[MobileAuth] request body:', JSON.stringify(req.body));
  console.log('[MobileAuth] request headers:', JSON.stringify(req.headers));
  console.log('[MobileAuth] request authenticated:', req.isAuthenticated());
  console.log('[MobileAuth] request user:', req.user);
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  const user = consumeMobileAuthToken(token);
  console.log('[MobileAuth] token valid, user:', user);
  if (!user) {
    return res.status(400).json({ error: 'Invalid or expired token' });
  }

  return establishLoginSession(req, user, (err) => {
    if (err) {
      console.error('Mobile auth session setup failed:', err.message || err);
      console.log('[MobileAuth] session established');
      return res.status(500).json({ error: 'Failed to establish session' });
    }

    return persistLoginSession(req, (saveErr) => {
      if (saveErr) {
        console.error('Mobile auth session persist failed:', saveErr.message || saveErr);
        console.log('[MobileAuth] session persisted');
        return res.status(500).json({ error: 'Failed to establish session' });
      }

      console.log('[MobileAuth] session persisted, authenticated:', req.isAuthenticated());
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
const gatewayWsOrigin = process.env.GATEWAY_WS_ORIGIN || 'http://localhost:3000';
const GATEWAY_URL = process.env.GATEWAY_URL || process.env.OPENCLAW_API_URL || 'http://openclaw.llm.svc.cluster.local:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || process.env.GATEWAY_AUTH_TOKEN || '';
const gatewayWsManager = new GatewayWsManager({
  wsUrl: process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789',
  clientId: process.env.GATEWAY_WS_CLIENT_ID || 'webchat-ui',
  clientVersion: `miso-chat/${APP_VERSION}`,
  clientMode: process.env.GATEWAY_WS_CLIENT_MODE || 'webchat',
});
gatewayWsManager.on('error', (err) => {
  gatewayWsLastError = String(err?.message || err || 'unknown error');
  console.error('⚠️ Gateway WS error:', err?.message || err);
});

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

      const displayName = String(
        item?.displayName
        || item?.title
        || item?.name
        || inferAgentNameFromKey(sessionKey)
        || sessionKey
      ).trim();

      return {
        ...item,
        sessionKey,
        displayName,
        provider: item?.provider || 'openclaw',
      };
    })
    .filter(Boolean)
    .filter((item, index, arr) => arr.findIndex((other) => other.sessionKey === item.sessionKey) === index);
}

app.get('/api/sessions', isAuthenticated, async (req, res) => {
  try {
    if (await waitForGatewayWsReady()) {
      try {
        const frame = await gatewayWsManager.send('sessions.list', {}, 10);
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

    const listSessionsResult = await gatewayInvoke('sessions_list', {});
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

app.get('/api/sessions/:key/history', isAuthenticated, async (req, res) => {
  try {
    const sessionKey = String(req.params.key || '').trim();
    if (!sessionKey) {
      return res.status(400).json({ error: 'session key is required' });
    }

    let payload = null;
    let historyResult = null;

    if (await waitForGatewayWsReady()) {
      try {
        const frame = await gatewayWsManager.send('sessions.history', { sessionKey }, 10);
        payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
      } catch (wsErr) {
        console.warn('sessions.history via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    if (!payload) {
      historyResult = await gatewayInvoke('sessions_history', { sessionKey });
      payload = unwrapToolResult(historyResult);
    }
    const messages = Array.isArray(payload?.messages)
      ? payload.messages
      : Array.isArray(payload)
        ? payload
        : Array.isArray(historyResult?.messages)
          ? historyResult.messages
          : [];

    return res.json({ sessionKey, messages });
  } catch (error) {
    console.error('Error fetching session history:', error.message || error);
    return res.status(500).json({ error: 'Failed to fetch session history' });
  }
});

app.post('/api/sessions/:key/send', isAuthenticated, async (req, res) => {
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
      try {
        const frame = await gatewayWsManager.send('chat.send', { sessionKey, text }, 30);
        payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
      } catch (wsErr) {
        console.warn('chat.send via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    if (!payload) {
      result = await gatewayInvoke('chat_send', { sessionKey, text });
      payload = unwrapToolResult(result);
    }

    const body = payload && typeof payload === 'object' ? payload : { result: payload ?? result };
    return res.json({ ok: true, success: true, ...body });
  } catch (error) {
    console.error('Error sending chat message:', error.message || error);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/sessions/:key/send-stream', isAuthenticated, async (req, res) => {
  try {
    const sessionKey = String(req.params.key || '').trim();
    const text = String(req.body?.text || req.body?.message || '').trim();

    if (!sessionKey) return res.status(400).json({ error: 'session key is required' });
    if (!text) return res.status(400).json({ error: 'text is required' });

    let payload = null;
    let result = null;

    if (gatewayWsManager?.isConnected?.()) {
      try {
        const frame = await gatewayWsManager.send('chat.send', { sessionKey, text }, 30);
        payload = frame?.result ?? frame?.payload ?? frame?.data ?? frame;
      } catch (wsErr) {
        console.warn('chat.send stream shim via WS failed, trying HTTP fallback:', wsErr.message || wsErr);
      }
    }

    if (!payload) {
      result = await gatewayInvoke('chat_send', { sessionKey, text });
      payload = unwrapToolResult(result);
    }

    const responseText = payload?.responseText || payload?.response?.text || payload?.response?.message || payload?.text || '';
    const toolCalls = Array.isArray(payload?.toolCalls) ? payload.toolCalls : [];
    const model = payload?.response?.model || payload?.model || null;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: 'message', text: responseText, toolCalls, model })}\n\n`);
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

function gatewayInvoke(tool, args = {}) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ tool, args });
    const url = new URL('/tools/invoke', GATEWAY_URL);
    const transport = url.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData),
    };

    if (GATEWAY_TOKEN) {
      headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;
    }

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

// ============ REACTION API ENDPOINTS ============
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

app.get('/api/config', (req, res) => {
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

app.get('/api/events', isAuthenticated, (req, res) => {
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

function broadcastToSseClients(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of sseClients) {
    try {
      client.write(`data: ${payload}\n\n`);
    } catch {}
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
  const gatewayHttpUrl = process.env.GATEWAY_URL || process.env.OPENCLAW_API_URL || '(not set)';
  const gatewayWsUrl = process.env.GATEWAY_WS_URL || 'ws://openclaw.llm.svc.cluster.local:18789';
  const gatewayWsOriginLabel = process.env.GATEWAY_WS_ORIGIN || '(none)';
  const gatewayWsClientId = process.env.GATEWAY_WS_CLIENT_ID || 'webchat-ui';
  const gatewayWsClientMode = process.env.GATEWAY_WS_CLIENT_MODE || 'webchat';
  const gatewayDeviceIdentityPath = process.env.GATEWAY_DEVICE_IDENTITY_PATH || '';
  const defaultSessionKey = DEFAULT_SESSION_KEY;
  const pushNotificationsEnabled = process.env.PUSH_NOTIFICATIONS_ENABLED === 'true';
  const pushConfigReady = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.PUSH_SUBJECT;

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
});

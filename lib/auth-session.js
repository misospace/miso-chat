/**
 * Auth & Session Management Module
 *
 * Extracted from server.js to provide a clean, focused boundary for:
 * - Session configuration (Redis-backed when REDIS_URL is set)
 * - Passport initialization and authentication strategies
 * - Login/logout routes (local + OIDC)
 * - Mobile auth token handoff
 * - Auth middleware (isAuthenticated, getOidcLabel)
 *
 * Usage in server.js:
 *   const { registerAuthRoutes, sessionMiddleware } = require('./lib/auth-session');
 *   // After app creation and before route definitions:
 *   registerAuthRoutes(app, { authMode, localAuthEnabled, oidcEnabled });
 */

const session = require('express-session');
const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const crypto = require('crypto');

// ─── Environment Helpers ──────────────────────────────────────────────

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

// ─── Session Configuration ────────────────────────────────────────────

function buildSessionConfig({ authMode }) {
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

  const sessionCookieSecure = parseBooleanEnv(process.env.SESSION_COOKIE_SECURE, process.env.NODE_ENV === 'production');
  const sessionCookieSameSite = parseSameSiteEnv(
    process.env.SESSION_COOKIE_SAMESITE,
    authMode === 'oidc' ? 'lax' : 'strict'
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
  } else if (process.env.ALLOW_MEMORY_STORE === 'true') {
    console.warn('⚠️ Session store: MemoryStore (REDIS_URL not set, ALLOW_MEMORY_STORE=true)');
  } else if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'REDIS_URL is required in production. Set REDIS_URL or allow in-memory sessions with ALLOW_MEMORY_STORE=true.'
    );
  } else {
    console.warn('⚠️ Session store: MemoryStore (REDIS_URL not set) — not recommended for production.');
  }

  return sessionConfig;
}

// ─── Mobile Auth Token Handoff ────────────────────────────────────────

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

// Clean up expired tokens every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of mobileAuthHandoffs.entries()) {
    if (entry.expiresAt < now) mobileAuthHandoffs.delete(token);
  }
}, 60 * 1000).unref?.();

// ─── Auth Helpers ─────────────────────────────────────────────────────

const WEB_RETURN_TO_SCHEMES = new Set(['http:', 'https:']);
const MOBILE_RETURN_TO_SCHEMES = new Set(['capacitor:', 'ionic:', 'misochat:']);
const CROSS_ORIGIN_ALLOWLIST = new Set(
  (process.env.ALLOWED_RETURN_ORIGINS || '')
    .split(',')
    .map((o) => {
      try {
        return new URL(o.trim()).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
);

function getReturnTo(req, fallback = '/', mode = 'any') {
  const raw = typeof req.body?.return_to === 'string' && req.body.return_to.trim()
    ? req.body.return_to.trim()
    : (typeof req.query?.return_to === 'string' && req.query.return_to.trim()
      ? req.query.return_to.trim()
      : '');

  if (!raw) return fallback;
  if (raw.startsWith('/')) {
    try {
      const normalized = new URL('http://x' + raw);
      return normalized.pathname + normalized.search + normalized.hash || '/';
    } catch {
      return fallback;
    }
  }

  try {
    const parsed = new URL(raw);

    if (mode === 'web') {
      if (WEB_RETURN_TO_SCHEMES.has(parsed.protocol)) {
        if (parsed.origin === `${req.protocol}://${req.get('host')}`) {
          return parsed.pathname + parsed.search + parsed.hash;
        }
        if (CROSS_ORIGIN_ALLOWLIST.has(parsed.origin)) {
          return parsed.toString();
        }
      }
      return fallback;
    }

    if (mode === 'mobile') {
      if (MOBILE_RETURN_TO_SCHEMES.has(parsed.protocol)) {
        return parsed.toString();
      }
      return fallback;
    }

    const allSchemes = new Set([...WEB_RETURN_TO_SCHEMES, ...MOBILE_RETURN_TO_SCHEMES]);
    if (!allSchemes.has(parsed.protocol)) return fallback;
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

// ─── Auth Middleware ──────────────────────────────────────────────────

function getOidcLabel() {
  return process.env.OIDC_ISSUER_LABEL
    || process.env.OIDC_PROVIDER_NAME
    || (process.env.OIDC_ISSUER ? String(process.env.OIDC_ISSUER).replace(/^https?:\/\//, '').replace(/\/.*/, '') : 'OIDC');
}

function buildIsAuthenticated(authMode) {
  return (req, res, next) => {
    if (authMode === 'none') return next();
    if (req.isAuthenticated()) return next();

    if (requestWantsJson(req)) {
      return res.status(401).json({
        error: 'Authentication required',
        loginUrl: '/login',
      });
    }

    const returnTo = encodeURIComponent(getReturnTo(req, req.originalUrl || '/', 'web'));
    return res.redirect(`/login?return_to=${returnTo}`);
  };
}

// ─── Passport & Strategy Setup ────────────────────────────────────────

function setupPassport({ authMode, localAuthEnabled, oidcEnabled }) {
  // Serialize/deserialize
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

  // OIDC Strategy
  if (oidcEnabled) {
    const providerUrl = (process.env.OIDC_PROVIDER_URL || '').trim();
    const providerIssuer = providerUrl
      ? providerUrl.replace(/\/\.well-known\/openid-configuration\/?$/, '/')
      : '';

    const issuer = providerIssuer || process.env.OIDC_ISSUER;

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

  // Return passport instance for middleware registration
  return passport;
}

// ─── Auth Routes ──────────────────────────────────────────────────────

function registerAuthRoutes(app, { authMode, localAuthEnabled, oidcEnabled, isAuthenticated, authLimiter }) {
  const login = (req, res) => {
    const returnTo = getReturnTo(req, '/', 'web');

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
  };

  app.get('/login', login);

  app.get('/api/login-options', (req, res) => {
    res.json({
      authMode,
      requiresAuth: authMode !== 'none',
      localAuthEnabled,
      oidcEnabled,
      oidcLabel: getOidcLabel(),
    });
  });

  app.post('/login', authLimiter, (req, res, next) => {
    if (!localAuthEnabled) {
      const returnTo = encodeURIComponent(getReturnTo(req, '/', 'web'));
      return res.redirect(`/login?error=local_disabled&return_to=${returnTo}`);
    }

    const returnTo = getReturnTo(req, '/', 'web');
    const failureReturnTo = encodeURIComponent(returnTo);

    passport.authenticate('local', (err, user) => {
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
    const returnTo = getReturnTo(req, '/', 'web');
    const mobileRequested = req.query?.mobile === '1';
    const prompt = req.query?.prompt === 'login' ? 'login' : undefined;
    req.session.oidcReturnTo = returnTo;
    req.session.oidcMobileFlow = mobileRequested;

    const authOptions = {};
    if (prompt) {
      authOptions.authorizationParams = { prompt };
    }

    return passport.authenticate('oidc', authOptions)(req, res, next);
  });

  app.get('/auth/oidc/callback', (req, res, next) => {
    passport.authenticate('oidc', (err, user) => {
      if (err || !user) {
        const returnTo = encodeURIComponent(getReturnTo(req, '/', 'web'));
        return res.redirect(`/login?error=oidc_failed&return_to=${returnTo}`);
      }

      const storedReturnTo = req.session?.oidcReturnTo;
      const mobileFlowFromSession = Boolean(req.session?.oidcMobileFlow);

      return establishLoginSession(req, user, (loginErr) => {
        if (loginErr) {
          const returnTo = encodeURIComponent(getReturnTo(req, '/', 'web'));
          console.error('OIDC login session setup failed:', loginErr.message || loginErr);
          return res.redirect(`/login?error=oidc_failed&return_to=${returnTo}`);
        }

        return persistLoginSession(req, (saveErr) => {
          if (saveErr) {
            const returnTo = encodeURIComponent(getReturnTo(req, '/', 'web'));
            console.error('OIDC login session persist failed:', saveErr.message || saveErr);
            return res.redirect(`/login?error=oidc_failed&return_to=${returnTo}`);
          }

          const ua = String(req.get('user-agent') || '');
          const isMobileUa = /Android|iPhone|iPad|iPod/i.test(ua);
          const mobileFlow = mobileFlowFromSession || (isMobileUa && !storedReturnTo);

          const safeReturnTo = storedReturnTo
            ? getReturnTo({ query: { return_to: storedReturnTo } }, '/', 'web')
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
    const returnTo = getReturnTo(req, '/', 'mobile');

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
}

// ─── Public Exports ───────────────────────────────────────────────────

module.exports = {
  buildSessionConfig,
  setupPassport,
  registerAuthRoutes,
  buildIsAuthenticated,
  // Re-export helpers that other modules may need
  getReturnTo,
  requestWantsJson,
  issueMobileAuthToken,
  consumeMobileAuthToken,
  establishLoginSession,
  persistLoginSession,
  getOidcLabel,
  parseBooleanEnv,
  parseSameSiteEnv,
};

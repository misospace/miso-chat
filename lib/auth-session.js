/**
 * Auth & Session Management Module
 *
 * Session configuration (Redis-backed when REDIS_URL is set), Passport initialization,
 * login/logout routes (local + OIDC), mobile auth token handoff, and auth middleware.
 */

const { RedisStore } = require('connect-redis');
const { createClient } = require('redis');
const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const crypto = require('crypto');
const { safeProtocol, safeHost } = require('./trusted-proxies');

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
const MOBILE_AUTH_TTL_SEC = Math.max(1, Math.ceil(MOBILE_AUTH_TTL_MS / 1000));
const MOBILE_AUTH_REDIS_PREFIX = 'miso-chat:mobile-auth:';
let mobileAuthRedis = null;

function initMobileAuthRedis() {
  if (mobileAuthRedis !== null) return mobileAuthRedis;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    mobileAuthRedis = false;
    return mobileAuthRedis;
  }
  try {
    const { createClient } = require('redis');
    const client = createClient({ url: redisUrl });
    client.on('error', (err) => {
      console.warn('[auth-session] mobile-auth redis error:', err.message);
    });
    client.connect().catch((err) => {
      console.warn('[auth-session] mobile-auth redis connect failed:', err.message);
    });
    mobileAuthRedis = client;
  } catch (err) {
    console.warn('[auth-session] mobile-auth redis unavailable, using in-memory fallback:', err.message);
    mobileAuthRedis = false;
  }
  return mobileAuthRedis;
}

function _setMobileAuthHandoffRedisForTesting(client) {
  mobileAuthRedis = client;
}

function issueMobileAuthToken(user) {
  const token = crypto.randomBytes(24).toString('hex');
  const entry = {
    user,
    expiresAt: Date.now() + MOBILE_AUTH_TTL_MS,
  };
  mobileAuthHandoffs.set(token, entry);
  const redis = initMobileAuthRedis();
  if (redis && typeof redis.set === 'function') {
    // Best-effort persistence; do not block issuance if Redis is slow/unreachable.
    redis
      .set(MOBILE_AUTH_REDIS_PREFIX + token, JSON.stringify(entry), { EX: MOBILE_AUTH_TTL_SEC })
      .catch((err) => {
        console.warn('[auth-session] mobile-auth redis set failed:', err.message);
      });
  }
  return token;
}

async function consumeMobileAuthToken(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const redis = initMobileAuthRedis();
  if (redis && typeof redis.getDel === 'function') {
    let raw = null;
    try {
      raw = await redis.getDel(MOBILE_AUTH_REDIS_PREFIX + token);
    } catch (err) {
      console.warn('[auth-session] mobile-auth redis getDel failed:', err.message);
      raw = null;
    }
    if (raw) {
      let entry;
      try {
        entry = JSON.parse(raw);
      } catch (err) {
        console.warn('[auth-session] mobile-auth redis payload malformed, treating as invalid:', err.message);
        return null;
      }
      if (!entry || typeof entry.expiresAt !== 'number') return null;
      if (entry.expiresAt < Date.now()) return null;
      // Mirror to in-memory map so the issuing instance is consistent.
      mobileAuthHandoffs.set(token, entry);
      return entry.user;
    }
  }
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
        if (parsed.origin === `${safeProtocol(req)}://${safeHost(req)}`) {
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

// ─── OIDC Profile Mapping ─────────────────────────────────────────────

/**
 * Map OIDC token claims to user profile shape.
 * @param {object} claims - JWT claims from id_token
 * @returns {object} User profile with sub, username, and optional email
 */
function mapProfileFromClaims(claims) {
  const profile = {};

  if (typeof claims?.sub === 'string' && claims.sub) {
    profile.sub = claims.sub;
  }

  // Username priority: preferred_username > name > sub
  profile.username =
    typeof claims?.preferred_username === 'string' && claims.preferred_username
      ? claims.preferred_username
      : (typeof claims?.name === 'string' && claims.name ? claims.name : claims?.sub);

  // Email only when present
  if (typeof claims?.email === 'string' && claims.email) {
    profile.email = claims.email;
  }

  return profile;
}

/**
 * Build absolute callback URL for OIDC strategy.
 * Uses OIDC_CALLBACK_URL env if set; in production, validates as absolute http(s).
 * Falls back to constructing from request headers.
 * @param {object} req - Express request object
 * @returns {string} Absolute callback URL
 */
function buildOidcCallbackURL(req) {
  const envUrl = (process.env.OIDC_CALLBACK_URL || '').trim();
  if (envUrl) {
    try {
      const parsed = new URL(envUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error('OIDC_CALLBACK_URL must be an absolute http(s) URL');
      }
    } catch (err) {
      if (err.message.includes('OIDC_CALLBACK_URL')) throw err;
      throw new Error('OIDC_CALLBACK_URL must be an absolute http(s) URL: ' + err.message);
    }
    return envUrl;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('OIDC_CALLBACK_URL is required in production');
  }

  const protocol = safeProtocol(req);
  const host = safeHost(req) || 'localhost:3000';
  return `${protocol}://${host}/auth/oidc/callback`;
}

/**
 * Build AuthenticateOptions for openid-client v6 passport Strategy.
 * @param {object} req - Express request object
 * @returns {object} AuthenticateOptions for passport.authenticate()
 */
function buildOidcAuthOptions(req) {
  const options = {
    callbackURL: buildOidcCallbackURL(req),
  };

  const prompt = typeof req.query?.prompt === 'string' ? req.query.prompt : undefined;
  if (prompt === 'login') {
    options.prompt = prompt;
  }

  return options;
}

/**
 * Authentik includes an empty `state` parameter in authorization responses
 * even when the request omitted one. oauth4webapi rejects that as an
 * unexpected response parameter, so always include and persist our own state.
 */
function withOidcState(Strategy) {
  return class StatefulOidcStrategy extends Strategy {
    authorizationRequestParams(req, options) {
      const params = super.authorizationRequestParams(req, options);
      if (!params.has('state')) {
        params.set('state', crypto.randomBytes(32).toString('hex'));
      }
      return params;
    }
  };
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

let _oidcConfig = null;
let _oidcSetupPromise = null;

function setupPassport({ localAuthEnabled }) {
  // Serialize/deserialize
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((obj, done) => done(null, obj));

  // Local Auth Strategy
  if (localAuthEnabled) {
    if (!process.env.LOCAL_USERS) {
      console.warn('⚠️ LOCAL_USERS environment variable is not set. Local authentication is enabled but no users are configured.');
    }
    const localUsers = (process.env.LOCAL_USERS || '').split(',').filter(u => u.trim());
    const validUsers = localUsers.map(u => {
      const [user, pass] = u.split(':');
      return { user: user.trim(), pass: pass.trim() };
    });

    // Production guard: reject weak or default LOCAL_USERS credentials,
    // mirroring the SESSION_SECRET guard in buildSessionConfig.
    if (process.env.NODE_ENV === 'production') {
      const insecureDefaults = ['password123', 'password', 'admin', 'changeme', 'secret', 'letmein'];
      for (const u of validUsers) {
        if (insecureDefaults.includes(u.pass)) {
          throw new Error(`LOCAL_USERS credential for "${u.user}" uses a known-insecure default password in production. Set a strong password (minimum 12 characters).`);
        }
        if (u.pass.length < 12) {
          throw new Error(`LOCAL_USERS credential for "${u.user}" is too short in production (minimum 12 characters). Set a strong password.`);
        }
      }
    }

    passport.use(new LocalStrategy(
      (username, password, done) => {
        const valid = validUsers.find(u => u.user === username && u.pass === password);
        if (valid) return done(null, { username });
        return done(null, false, { message: 'Invalid credentials' });
      }
    ));
  }

  return passport;
}

/**
 * Ensure OIDC strategy is registered. Performs discovery on first call,
 * caches in-flight promise to prevent concurrent duplicate setup.
 * Resets _oidcSetupPromise on failure so corrected config can retry.
 * @returns {Promise<object>} The OIDC Configuration
 */
async function ensureOidcSetup() {
  if (_oidcConfig) return _oidcConfig;
  if (_oidcSetupPromise) return _oidcSetupPromise;

  const issuer = (process.env.OIDC_ISSUER || '').trim();
  const clientId = (process.env.OIDC_CLIENT_ID || '').trim();
  const clientSecret = (process.env.OIDC_CLIENT_SECRET || '').trim();

  if (!issuer) throw new Error('OIDC_ENABLED=true requires OIDC_ISSUER');
  if (!clientId) throw new Error('OIDC_ENABLED=true requires OIDC_CLIENT_ID');
  if (!clientSecret) throw new Error('OIDC_ENABLED=true requires OIDC_CLIENT_SECRET');

  _oidcSetupPromise = (async () => {
    try {
      const [clientLib, passportLib] = await Promise.all([
        import('openid-client'),
        import('openid-client/passport'),
      ]);

      const config = await clientLib.discovery(
        new URL(issuer),
        clientId,
        clientSecret,
      );

      const StatefulOidcStrategy = withOidcState(passportLib.Strategy);
      passport.use('oidc', new StatefulOidcStrategy({
        config,
        scope: 'openid profile email',
        passReqToCallback: true,
      }, (_req, tokens, verified) => {
        const claims = tokens.claims();
        if (!claims?.sub) {
          console.error('OIDC: id_token missing required "sub" claim');
          return verified(new Error('OIDC: missing sub claim'));
        }

        const profile = mapProfileFromClaims(claims);
        if (!profile.username) {
          return verified(new Error('OIDC: could not determine username from claims'));
        }

        return verified(null, profile);
      }));

      _oidcConfig = config;
      console.log(`✅ OIDC strategy registered (issuer: ${new URL(issuer).host})`);
      return config;
    } finally {
      _oidcSetupPromise = null;
    }
  })();

  return _oidcSetupPromise;
}

// ─── Auth Routes ──────────────────────────────────────────────────────

function registerAuthRoutes(app, { authMode, localAuthEnabled, oidcEnabled, authLimiter, passport: pp, ensureOidcSetup: eoSetup }) {
  const ppAuth = (pp || passport);
  const eoSetupFn = eoSetup || ensureOidcSetup;
  const login = (req, res) => {
    const returnTo = getReturnTo(req, '/', 'web');

    if (authMode === 'none') {
      return res.redirect(returnTo);
    }

    if (authMode === 'oidc') {
      const error = typeof req.query?.error === 'string' ? req.query.error : '';
      if (error) {
        return res.sendFile(__dirname + '/public/login.html');
      }
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

    ppAuth.authenticate('local', (err, user) => {
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

  app.get('/auth/oidc', async (req, res, next) => {
    if (!oidcEnabled) return res.redirect('/login?error=oidc_disabled');

    try {
      await eoSetupFn();
    } catch (setupErr) {
      console.error('OIDC setup failed:', setupErr.message || setupErr);
      return res.redirect('/login?error=oidc_setup_failed');
    }

    const returnTo = getReturnTo(req, '/', 'web');
    const mobileRequested = req.query?.mobile === '1';
    req.session.oidcReturnTo = returnTo;
    req.session.oidcMobileFlow = mobileRequested;

    return ppAuth.authenticate('oidc', buildOidcAuthOptions(req))(req, res, next);
  });

  app.get('/auth/oidc/callback', (req, res, next) => {
    ppAuth.authenticate('oidc', buildOidcAuthOptions(req), (err, user) => {
      if (err || !user) {
        console.error('OIDC callback failed:', err?.stack || err?.message || err || 'no user returned');
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
            req.session.mobileAuthToken = token;
            const target = new URL('/auth/mobile-complete', `${safeProtocol(req)}://${safeHost(req)}`);
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
          logoutUrl.searchParams.set('next', encodeURIComponent(safeProtocol(req) + '://' + safeHost(req) + '/login?prompt=login'));
          return res.redirect(logoutUrl.toString());
        }
        return res.redirect('/login');
      });
    });
  });

  app.get('/auth/mobile-complete', (req, res) => {
    // The token was issued during the OIDC callback and stored in the session
    // (see /auth/oidc/callback). It is deliberately NOT carried in this URL's
    // query string so it never appears in browser history, in-app-browser
    // URLs, or access logs.
    const token = typeof req.session?.mobileAuthToken === 'string' ? req.session.mobileAuthToken : '';
    delete req.session?.mobileAuthToken;
    const returnTo = getReturnTo(req, '/', 'mobile');

    if (!token) {
      return res.status(400).send('Missing mobile auth token');
    }

    // The token is delivered in the URL fragment (#...), which is never sent
    // to servers and is not retained in server-side logs. The app's deep-link
    // handler reads it from the fragment and consumes it via the POST-only
    // /api/mobile-auth/consume endpoint.
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
    const fragment = new URLSearchParams();
    fragment.set('mobile_token', ${JSON.stringify(token)});
    const href = appTarget.toString() + '#' + fragment.toString();
    document.getElementById('openApp').href = href;
    window.location.replace(href);
  </script>
</body></html>`;

    res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(html);
  });

  app.post('/api/mobile-auth/consume', async (req, res) => {
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!token) {
      return res.status(400).json({ error: 'Missing token' });
    }

    const user = await consumeMobileAuthToken(token);
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
  getReturnTo,
  requestWantsJson,
  issueMobileAuthToken,
  consumeMobileAuthToken,
  establishLoginSession,
  persistLoginSession,
  getOidcLabel,
  parseBooleanEnv,
  parseSameSiteEnv,
  mapProfileFromClaims,
  buildOidcCallbackURL,
  buildOidcAuthOptions,
  withOidcState,
  ensureOidcSetup,
  mobileAuthHandoffs,
  _setMobileAuthHandoffRedisForTesting,
};

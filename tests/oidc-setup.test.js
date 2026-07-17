const test = require('node:test');
const assert = require('node:assert/strict');

// Save and set test env before requiring module
const _origEnv = {
  NODE_ENV: process.env.NODE_ENV,
  SESSION_SECRET: process.env.SESSION_SECRET,
  AUTH_MODE: process.env.AUTH_MODE,
  LOCAL_USERS: process.env.LOCAL_USERS,
};
const _hadEnv = {
  NODE_ENV: process.env.NODE_ENV !== undefined,
  SESSION_SECRET: process.env.SESSION_SECRET !== undefined,
  AUTH_MODE: process.env.AUTH_MODE !== undefined,
  LOCAL_USERS: process.env.LOCAL_USERS !== undefined,
};
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';
process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';

const { mapProfileFromClaims, buildOidcCallbackURL, buildOidcAuthOptions, ensureOidcSetup, registerAuthRoutes } = require('../lib/auth-session');

// Restore env after all tests
test.after(() => {
  for (const [key, original] of Object.entries(_origEnv)) {
    if (_hadEnv[key]) process.env[key] = original;
    else delete process.env[key];
  }
});

// ─── Profile mapping tests ────────────────────────────────────────────

test('mapProfileFromClaims omits sub when absent', () => {
  const result = mapProfileFromClaims({ name: 'Test User' });
  assert.equal(result.sub, undefined);
  assert.ok(result.username);
});

test('mapProfileFromClaims uses preferred_username for username', () => {
  const result = mapProfileFromClaims({
    sub: 'user-123',
    preferred_username: 'jdoe',
    name: 'John Doe',
    email: 'john@example.com',
  });

  assert.equal(result.sub, 'user-123');
  assert.equal(result.username, 'jdoe');
  assert.equal(result.email, 'john@example.com');
});

test('mapProfileFromClaims falls back to name for username', () => {
  const result = mapProfileFromClaims({
    sub: 'user-456',
    name: 'Jane Smith',
  });

  assert.equal(result.sub, 'user-456');
  assert.equal(result.username, 'Jane Smith');
  assert.equal(result.email, undefined);
});

test('mapProfileFromClaims falls back to sub for username', () => {
  const result = mapProfileFromClaims({
    sub: 'user-789',
  });

  assert.equal(result.sub, 'user-789');
  assert.equal(result.username, 'user-789');
});

test('mapProfileFromClaims includes email when present', () => {
  const result = mapProfileFromClaims({
    sub: 'user-101',
    name: 'Alice',
    email: 'alice@example.com',
  });

  assert.equal(result.email, 'alice@example.com');
});

test('mapProfileFromClaims omits email when absent', () => {
  const result = mapProfileFromClaims({
    sub: 'user-102',
    name: 'Bob',
  });

  assert.equal(result.email, undefined);
});

// ─── Callback URL tests ───────────────────────────────────────────────

test('buildOidcCallbackURL returns absolute URL from req', () => {
  const req = {
    protocol: 'https',
    get: (header) => {
      if (header === 'host') return 'app.example.com';
      return '';
    },
  };

  const url = buildOidcCallbackURL(req);
  assert.equal(url, 'https://app.example.com/auth/oidc/callback');
});

test('buildOidcCallbackURL uses http protocol', () => {
  const req = {
    protocol: 'http',
    get: (header) => {
      if (header === 'host') return 'localhost:3000';
      return '';
    },
  };

  const url = buildOidcCallbackURL(req);
  assert.equal(url, 'http://localhost:3000/auth/oidc/callback');
});

test('buildOidcCallbackURL respects OIDC_CALLBACK_URL env', () => {
  const original = process.env.OIDC_CALLBACK_URL;
  const hadValue = original !== undefined;
  try {
    process.env.OIDC_CALLBACK_URL = 'https://custom.example.com/oidc/redirect';

    const req = {
      protocol: 'http',
      get: (header) => {
        if (header === 'host') return 'localhost:3000';
        return '';
      },
    };

    const url = buildOidcCallbackURL(req);
    assert.equal(url, 'https://custom.example.com/oidc/redirect');
  } finally {
    if (hadValue) process.env.OIDC_CALLBACK_URL = original;
    else delete process.env.OIDC_CALLBACK_URL;
  }
});

test('buildOidcCallbackURL rejects non-http protocols in production', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalUrl = process.env.OIDC_CALLBACK_URL;
  const hadEnv = originalEnv !== undefined;
  const hadUrl = originalUrl !== undefined;
  try {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_CALLBACK_URL = 'ftp://evil.com/callback';

    assert.throws(
      () => buildOidcCallbackURL({}),
      /OIDC_CALLBACK_URL must be an absolute http/,
    );
  } finally {
    if (hadEnv) process.env.NODE_ENV = originalEnv; else delete process.env.NODE_ENV;
    if (hadUrl) process.env.OIDC_CALLBACK_URL = originalUrl; else delete process.env.OIDC_CALLBACK_URL;
  }
});

test('buildOidcCallbackURL rejects malformed URLs in production', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalUrl = process.env.OIDC_CALLBACK_URL;
  const hadEnv = originalEnv !== undefined;
  const hadUrl = originalUrl !== undefined;
  try {
    process.env.NODE_ENV = 'production';
    process.env.OIDC_CALLBACK_URL = 'not-a-url';

    assert.throws(
      () => buildOidcCallbackURL({}),
      /OIDC_CALLBACK_URL must be an absolute http/,
    );
  } finally {
    if (hadEnv) process.env.NODE_ENV = originalEnv; else delete process.env.NODE_ENV;
    if (hadUrl) process.env.OIDC_CALLBACK_URL = originalUrl; else delete process.env.OIDC_CALLBACK_URL;
  }
});

test('buildOidcCallbackURL requires explicit URL in production', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalUrl = process.env.OIDC_CALLBACK_URL;
  const hadEnv = originalEnv !== undefined;
  const hadUrl = originalUrl !== undefined;
  try {
    process.env.NODE_ENV = 'production';
    delete process.env.OIDC_CALLBACK_URL;

    assert.throws(
      () => buildOidcCallbackURL({}),
      /OIDC_CALLBACK_URL is required in production/,
    );
  } finally {
    if (hadEnv) process.env.NODE_ENV = originalEnv; else delete process.env.NODE_ENV;
    if (hadUrl) process.env.OIDC_CALLBACK_URL = originalUrl; else delete process.env.OIDC_CALLBACK_URL;
  }
});

// ─── Auth options tests (openid-client v6 API) ────────────────────────

test('buildOidcAuthOptions uses callbackURL not redirect_uri', () => {
  const req = {
    protocol: 'https',
    get: (header) => (header === 'host' ? 'app.example.com' : ''),
    query: {},
  };

  const options = buildOidcAuthOptions(req);
  assert.equal(options.callbackURL, 'https://app.example.com/auth/oidc/callback');
  assert.equal(options.redirect_uri, undefined);
});

test('buildOidcAuthOptions passes prompt directly not authorizationParams', () => {
  const req = {
    protocol: 'https',
    get: (header) => (header === 'host' ? 'app.example.com' : ''),
    query: { prompt: 'login' },
  };

  const options = buildOidcAuthOptions(req);
  assert.equal(options.prompt, 'login');
  assert.equal(options.authorizationParams, undefined);
});

test('buildOidcAuthOptions omits prompt when not requested', () => {
  const req = {
    protocol: 'https',
    get: (header) => (header === 'host' ? 'app.example.com' : ''),
    query: {},
  };

  const options = buildOidcAuthOptions(req);
  assert.equal(options.prompt, undefined);
});

// ─── ensureOidcSetup error handling tests ─────────────────────────────

test('ensureOidcSetup throws when OIDC_ISSUER is missing', async () => {
  const originalIssuer = process.env.OIDC_ISSUER;
  const originalClientId = process.env.OIDC_CLIENT_ID;
  const originalClientSecret = process.env.OIDC_CLIENT_SECRET;
  const hadIssuer = originalIssuer !== undefined;
  const hadClientId = originalClientId !== undefined;
  const hadClientSecret = originalClientSecret !== undefined;

  try {
    // Clear all OIDC env vars
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;

    await assert.rejects(
      () => ensureOidcSetup(),
      /OIDC_ENABLED=true requires OIDC_ISSUER/,
    );
  } finally {
    if (hadIssuer) process.env.OIDC_ISSUER = originalIssuer;
    if (hadClientId) process.env.OIDC_CLIENT_ID = originalClientId;
    if (hadClientSecret) process.env.OIDC_CLIENT_SECRET = originalClientSecret;
  }
});

test('ensureOidcSetup throws when OIDC_CLIENT_ID is missing', async () => {
  const originalIssuer = process.env.OIDC_ISSUER;
  const originalClientId = process.env.OIDC_CLIENT_ID;
  const originalClientSecret = process.env.OIDC_CLIENT_SECRET;
  const hadIssuer = originalIssuer !== undefined;
  const hadClientId = originalClientId !== undefined;
  const hadClientSecret = originalClientSecret !== undefined;

  try {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    process.env.OIDC_ISSUER = 'https://accounts.google.com';

    await assert.rejects(
      () => ensureOidcSetup(),
      /OIDC_ENABLED=true requires OIDC_CLIENT_ID/,
    );
  } finally {
    if (hadIssuer) process.env.OIDC_ISSUER = originalIssuer;
    else delete process.env.OIDC_ISSUER;
    if (hadClientId) process.env.OIDC_CLIENT_ID = originalClientId;
    if (hadClientSecret) process.env.OIDC_CLIENT_SECRET = originalClientSecret;
  }
});

test('ensureOidcSetup throws when OIDC_CLIENT_SECRET is missing', async () => {
  const originalIssuer = process.env.OIDC_ISSUER;
  const originalClientId = process.env.OIDC_CLIENT_ID;
  const originalClientSecret = process.env.OIDC_CLIENT_SECRET;
  const hadIssuer = originalIssuer !== undefined;
  const hadClientId = originalClientId !== undefined;
  const hadClientSecret = originalClientSecret !== undefined;

  try {
    delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
    process.env.OIDC_ISSUER = 'https://accounts.google.com';
    process.env.OIDC_CLIENT_ID = 'test-client-id';

    await assert.rejects(
      () => ensureOidcSetup(),
      /OIDC_ENABLED=true requires OIDC_CLIENT_SECRET/,
    );
  } finally {
    if (hadIssuer) process.env.OIDC_ISSUER = originalIssuer;
    else delete process.env.OIDC_ISSUER;
    if (hadClientId) process.env.OIDC_CLIENT_ID = originalClientId;
    if (hadClientSecret) process.env.OIDC_CLIENT_SECRET = originalClientSecret;
  }
});

// ─── ensureOidcSetup retry after failure ──────────────────────────────

test('ensureOidcSetup allows retry after env validation failure', async () => {
  const originalIssuer = process.env.OIDC_ISSUER;
  const hadIssuer = originalIssuer !== undefined;
  try {
    delete process.env.OIDC_ISSUER;

    await assert.rejects(() => ensureOidcSetup(), /OIDC_ISSUER/);

    // After failure, setting the env var should allow retry (not stuck on cached rejection)
    process.env.OIDC_ISSUER = 'https://accounts.google.com';
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;

    await assert.rejects(() => ensureOidcSetup(), /OIDC_CLIENT_ID/);
  } finally {
    if (hadIssuer) process.env.OIDC_ISSUER = originalIssuer;
    else delete process.env.OIDC_ISSUER;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_CLIENT_SECRET;
  }
});

// ─── Auth route options tests ─────────────────────────────────────────

test('registerAuthRoutes captures callbackURL on /auth/oidc', async () => {
  const capturedOptions = [];
  const mockPassport = {
    serializeUser: () => {},
    deserializeUser: () => {},
    use: () => {},
    authenticate: (strategy, options) => {
      capturedOptions.push({ strategy, options });
      return (_req, _res, next) => next();
    },
  };

  const routes = {};
  const mockApp = {
    get: (path, handler) => { routes[path] = handler; },
    post: () => {},
  };

  registerAuthRoutes(mockApp, {
    authMode: 'oidc',
    localAuthEnabled: false,
    oidcEnabled: true,
    authLimiter: (_req, _res, next) => next(),
    passport: mockPassport,
    ensureOidcSetup: async () => ({}),
  });

  const req = {
    protocol: 'http',
    get: (h) => h === 'host' ? 'www.example.com' : '',
    query: {},
    session: {},
  };
  const res = { redirect: () => {} };
  const next = () => {};

  await routes['/auth/oidc'](req, res, next);

  const oidcCall = capturedOptions.find(c => c.strategy === 'oidc');
  assert.ok(oidcCall, '/auth/oidc should call passport.authenticate');
  assert.equal(oidcCall.options.callbackURL, 'http://www.example.com/auth/oidc/callback');
  assert.equal(oidcCall.options.redirect_uri, undefined);
});

test('registerAuthRoutes passes callbackURL on /auth/oidc/callback', async () => {
  const capturedOptions = [];
  const mockPassport = {
    serializeUser: () => {},
    deserializeUser: () => {},
    use: () => {},
    authenticate: (strategy, options, cb) => {
      capturedOptions.push({ strategy, options, hasCallback: typeof cb === 'function' });
      return (_req, _res, next) => next();
    },
  };

  const routes = {};
  const mockApp = {
    get: (path, handler) => { routes[path] = handler; },
    post: () => {},
  };

  registerAuthRoutes(mockApp, {
    authMode: 'oidc',
    localAuthEnabled: false,
    oidcEnabled: true,
    authLimiter: (_req, _res, next) => next(),
    passport: mockPassport,
    ensureOidcSetup: async () => ({}),
  });

  const req = {
    protocol: 'https',
    get: (h) => h === 'host' ? 'app.example.com' : '',
    query: {},
    session: {},
  };
  const res = { redirect: () => {} };
  const next = () => {};

  routes['/auth/oidc/callback'](req, res, next);

  const oidcCall = capturedOptions.find(c => c.strategy === 'oidc');
  assert.ok(oidcCall, '/auth/oidc/callback should call passport.authenticate');
  assert.equal(oidcCall.options.callbackURL, 'https://app.example.com/auth/oidc/callback');
  assert.equal(oidcCall.hasCallback, true);
});

test('registerAuthRoutes passes prompt directly on /auth/oidc', async () => {
  const capturedOptions = [];
  const mockPassport = {
    serializeUser: () => {},
    deserializeUser: () => {},
    use: () => {},
    authenticate: (strategy, options) => {
      capturedOptions.push({ strategy, options });
      return (_req, _res, next) => next();
    },
  };

  const routes = {};
  const mockApp = {
    get: (path, handler) => { routes[path] = handler; },
    post: () => {},
  };

  registerAuthRoutes(mockApp, {
    authMode: 'oidc',
    localAuthEnabled: false,
    oidcEnabled: true,
    authLimiter: (_req, _res, next) => next(),
    passport: mockPassport,
    ensureOidcSetup: async () => ({}),
  });

  const req = {
    protocol: 'http',
    get: (h) => h === 'host' ? 'www.example.com' : '',
    query: { prompt: 'login' },
    session: {},
  };
  const res = { redirect: () => {} };
  const next = () => {};

  await routes['/auth/oidc'](req, res, next);

  const oidcCall = capturedOptions.find(c => c.strategy === 'oidc');
  assert.equal(oidcCall.options.prompt, 'login');
  assert.equal(oidcCall.options.authorizationParams, undefined);
});

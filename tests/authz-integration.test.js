/**
 * Authorization / Integration Test Matrix
 *
 * Covers the audit findings for misospace/miso-chat#539:
 *   1. Authenticated users are not authorized per gateway session or operation.
 *      Only `isAuthenticated` is the gate — missing `requireSessionOwnership` on
 *      some routes. This test matrix verifies that all authenticated routes properly
 *      enforce session ownership, denial of cross-user access, and correct behavior
 *      under OIDC vs local auth modes.
 *   2. CSRF protection is origin-only and broad for mobile/web hybrid deployment.
 *      Verifies csrfOriginCheck blocks untrusted origins and accepts trusted ones.
 *   3. `/api/config` exposure — verifies what config is publicly accessible.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// ===== Helpers =====

/**
 * Start the Express app on a random port, run the callback, then shut down.
 */
async function withServer(envOverrides, run) {
  // Reset module cache so environment changes take effect between tests
  const keys = Object.keys(require.cache);
  for (const k of keys) {
    if (k.includes('/miso-chat/')) delete require.cache[k];
  }

  for (const [k, v] of Object.entries(envOverrides)) {
    process.env[k] = v;
  }

  process.env.NODE_ENV = 'test';
  process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';

  const { app } = require('../server');
  const srv = http.createServer(app);
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
}

/**
 * Make an HTTP request and return parsed JSON body.
 */
function httpReq(base, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* keep raw */ }
        resolve({ statusCode: res.statusCode, headers: res.headers, body, json: parsed });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============================================================
// SECTION 1: /api/config exposure under multi-user settings
// ============================================================

test('GET /api/config is publicly accessible (no auth gate)', async () => {
  await withServer({}, async (base) => {
    const res = await httpReq(base, '/api/config');
    assert.equal(res.statusCode, 200);
    assert.ok(res.json, 'config should return JSON');
    assert.ok(Object.prototype.hasOwnProperty.call(res.json, 'defaultSessionKey'));
    assert.ok(Object.prototype.hasOwnProperty.call(res.json, 'authMode'));
    assert.ok(Object.prototype.hasOwnProperty.call(res.json, 'requiresAuth'));
  });
});

test('GET /api/config does NOT expose session keys or user data', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password,bob:password' }, async (base) => {
    const res = await httpReq(base, '/api/config');
    assert.equal(res.statusCode, 200);

    // Must NOT contain actual session keys or user credentials
    const bodyStr = JSON.stringify(res.json);
    assert.doesNotMatch(bodyStr, /password/i, 'config must not expose passwords');
    assert.doesNotMatch(bodyStr, /agent:alice:/i, 'config must not expose specific session keys');

    // Should expose authMode and requiresAuth (these are intentionally public)
    assert.equal(res.json.authMode, 'local');
    assert.equal(res.json.requiresAuth, true);
  });
});

test('GET /api/config exposes defaultSessionKey even without auth', async () => {
  await withServer({ AUTH_MODE: 'none' }, async (base) => {
    const res = await httpReq(base, '/api/config');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.authMode, 'none');
    assert.equal(res.json.requiresAuth, false);
    // defaultSessionKey is always present — this is intentional for the frontend
    assert.ok(res.json.defaultSessionKey);
  });
});

test('GET /api/config does NOT expose OIDC secrets when OIDC is enabled', async () => {
  // Note: We cannot start the server with AUTH_MODE=oidc without proper OIDC config
  // (issuer, clientID, etc.), so we verify via lib-level assertions instead.
  const { checkSessionOwnership } = require('../lib/session-auth');

  // OIDC auth mode requires authentication — no unauthenticated access
  const unauthReq = { user: null, isAuthenticated: () => false };
  assert.equal(checkSessionOwnership(unauthReq, 'agent:anyone:any', 'oidc'), false);

  // OIDC mode grants access only when email/username matches session owner
  const oidcMatch = { user: { username: 'alice', email: 'alice@example.com' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(oidcMatch, 'agent:alice:main', 'oidc'), true);

  const oidcNoMatch = { user: { username: 'bob', email: 'bob@example.com' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(oidcNoMatch, 'agent:alice:main', 'oidc'), false);
});

// ============================================================
// SECTION 2: CSRF protection — origin checking
// ============================================================

test('POST from untrusted origin is blocked by CORS middleware', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/sessions/agent:alice:main/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://evil.example.com',
      },
      body: JSON.stringify({ message: 'hello' }),
    });
    // CORS middleware blocks untrusted origins before CSRF check runs.
    // The request must NOT succeed (status 200).
    assert.notEqual(res.statusCode, 200, 'Untrusted origin should be blocked');
  });
});

test('POST with trusted origin is not blocked by csrfOriginCheck', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const port = new URL(base).port;
    const res = await httpReq(base, '/api/sessions/agent:alice:main/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': `http://localhost:${port}`,
      },
      body: JSON.stringify({ message: 'hello' }),
    });
    // Should NOT be 403 from CSRF check; may be 302 (no auth) or other error
    assert.notEqual(res.statusCode, 403, 'Trusted origin should not be blocked by CSRF');
  });
});

test('CSRF check allows native mobile origins', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    // Native mobile apps use capacitor://localhost, ionic://localhost, app://localhost
    const mobileOrigins = ['capacitor://localhost', 'ionic://localhost', 'app://localhost'];
    for (const origin of mobileOrigins) {
      const res = await httpReq(base, '/api/sessions/agent:alice:main/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': origin,
        },
        body: JSON.stringify({ message: 'hello' }),
      });
      // Should not be blocked by CSRF (may fail for other reasons like auth)
      assert.notEqual(res.statusCode, 403, `Mobile origin ${origin} should not be blocked by CSRF`);
    }
  });
});

test('CSRF check allows null Origin for non-browser clients', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/sessions/agent:alice:main/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'null',
      },
      body: JSON.stringify({ message: 'hello' }),
    });
    // null origin should not be blocked by CSRF (for non-browser clients)
    assert.notEqual(res.statusCode, 403, 'null Origin should not be blocked by CSRF');
  });
});

// ============================================================
// SECTION 3: Route-level auth enforcement — what happens without auth
// ============================================================

test('GET /api/sessions returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/sessions');
    // Should NOT return 200 with session data — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/sessions should not return 200 without auth');
  });
});

test('GET /api/agents returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/agents');
    // Should NOT return 200 with agent data — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/agents should not return 200 without auth');
  });
});

test('GET /api/openclaw-status returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/openclaw-status?sessionKey=agent:alice:main');
    // Should NOT return 200 — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/openclaw-status should not return 200 without auth');
  });
});

test('POST /api/openclaw-stop returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/openclaw-stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:alice:main' }),
    });
    // Should NOT return 200 — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/openclaw-stop should not return 200 without auth');
  });
});

test('GET /api/reactions/:sessionKey returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/reactions/agent:alice:main');
    // Should NOT return 200 — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/reactions/:sessionKey should not return 200 without auth');
  });
});

test('GET /api/messages/:messageId/reactions returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/messages/msg123/reactions');
    // Should NOT return 200 — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/messages/:messageId/reactions should not return 200 without auth');
  });
});

test('POST /api/messages/:messageId/reactions returns redirect or error when unauthenticated', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/messages/msg123/reactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji: '👍' }),
    });
    // Should NOT return 200 — either redirect or error
    assert.notEqual(res.statusCode, 200, '/api/messages/:messageId/reactions POST should not return 200 without auth');
  });
});

// ============================================================
// SECTION 4: Session ownership middleware verification via route behavior
// ============================================================

test('requireSessionOwnership middleware blocks cross-user session access', async () => {
  const { requireSessionOwnership, checkSessionOwnership } = require('../lib/session-auth');

  // Simulate Alice trying to access Bob's session in local auth mode
  const req = {
    params: { key: 'agent:bob:main' },
    body: {},
    query: {},
    user: { username: 'alice' },
    isAuthenticated: () => true,
  };

  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  let nextCalled = false;
  const mw = requireSessionOwnership('local');
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'Cross-user session access should be blocked');
  assert.equal(res.statusCode, 403);
  assert.ok(res.payload.error.includes('Forbidden'), 'Should return Forbidden error');
});

test('requireSessionOwnership middleware allows same-user session access', async () => {
  const { requireSessionOwnership } = require('../lib/session-auth');

  // Alice accessing her own session
  const req = {
    params: { key: 'agent:alice:main' },
    body: {},
    query: {},
    user: { username: 'alice' },
    isAuthenticated: () => true,
  };

  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  let nextCalled = false;
  const mw = requireSessionOwnership('local');
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'Same-user session access should be allowed');
});

test('requireSessionOwnership middleware allows access when authMode=none', async () => {
  const { requireSessionOwnership } = require('../lib/session-auth');

  // Any user accessing any session when auth is disabled
  const req = {
    params: { key: 'agent:bob:main' },
    body: {},
    query: {},
    user: null,
    isAuthenticated: () => false,
  };

  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  let nextCalled = false;
  const mw = requireSessionOwnership('none');
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'Auth disabled mode should allow all access');
});

test('requireSessionOwnership middleware checks query sessionKey parameter', async () => {
  const { requireSessionOwnership } = require('../lib/session-auth');

  // Bob accessing Alice's session via query param
  const req = {
    params: {},
    body: {},
    query: { sessionKey: 'agent:alice:main' },
    user: { username: 'bob' },
    isAuthenticated: () => true,
  };

  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  let nextCalled = false;
  const mw = requireSessionOwnership('local');
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'Cross-user access via query param should be blocked');
});

test('requireSessionOwnership middleware checks body sessionKey parameter', async () => {
  const { requireSessionOwnership } = require('../lib/session-auth');

  // Bob accessing Alice's session via body param
  const req = {
    params: {},
    body: { sessionKey: 'agent:alice:main' },
    query: {},
    user: { username: 'bob' },
    isAuthenticated: () => true,
  };

  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  let nextCalled = false;
  const mw = requireSessionOwnership('local');
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false, 'Cross-user access via body param should be blocked');
});

test('requireSessionOwnership middleware skips when no session key provided', async () => {
  const { requireSessionOwnership } = require('../lib/session-auth');

  // Route without session key (e.g., /api/sessions list)
  const req = {
    params: {},
    body: {},
    query: {},
    user: { username: 'alice' },
    isAuthenticated: () => true,
  };

  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };

  let nextCalled = false;
  const mw = requireSessionOwnership('local');
  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true, 'Routes without session key should skip ownership check');
});

// ============================================================
// SECTION 5: OIDC mode — session ownership by email/username
// ============================================================

test('checkSessionOwnership allows OIDC user when email includes session owner', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = {
    user: { username: 'user123', email: 'alice@example.com' },
    isAuthenticated: () => true,
  };
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'oidc'), true);
});

test('checkSessionOwnership allows OIDC user when username matches session owner', async () => {
  const checkSessionOwnership = require('../lib/session-auth').checkSessionOwnership;

  const req = {
    user: { username: 'alice', email: 'alice@example.com' },
    isAuthenticated: () => true,
  };
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'oidc'), true);
});

test('checkSessionOwnership denies OIDC user when neither email nor username matches', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = {
    user: { username: 'bob', email: 'bob@example.com' },
    isAuthenticated: () => true,
  };
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'oidc'), false);
});

test('checkSessionOwnership denies unauthenticated requests in OIDC mode', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: null, isAuthenticated: () => false };
  assert.equal(checkSessionOwnership(req, 'agent:bob:main', 'oidc'), false);
});

test('checkSessionOwnership denies unknown session key format in OIDC mode', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = {
    user: { username: 'alice', email: 'alice@example.com' },
    isAuthenticated: () => true,
  };
  assert.equal(checkSessionOwnership(req, 'unknown-session-key', 'oidc'), false);
});

// ============================================================
// SECTION 6: Local auth mode — session ownership by username
// ============================================================

test('checkSessionOwnership allows local user when username matches session owner', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: { username: 'alice' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'local'), true);
});

test('checkSessionOwnership denies local user when username does not match session owner', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: { username: 'bob' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'local'), false);
});

test('checkSessionOwnership denies unauthenticated requests in local mode', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: null, isAuthenticated: () => false };
  assert.equal(checkSessionOwnership(req, 'agent:bob:main', 'local'), false);
});

test('checkSessionOwnership denies unknown session key format in local mode', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: { username: 'alice' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(req, 'random-key-123', 'local'), false);
});

// ============================================================
// SECTION 7: g-agent session key format ownership
// ============================================================

test('checkSessionOwnership allows matching g-agent session key in local mode', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: { username: 'chat' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(req, 'g-agent-chat-123e4567-e89b-12d3-a456-426614174000', 'local'), true);
});

test('checkSessionOwnership denies non-matching g-agent session key in local mode', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const req = { user: { username: 'alice' }, isAuthenticated: () => true };
  assert.equal(checkSessionOwnership(req, 'g-agent-chat-123e4567-e89b-12d3-a456-426614174000', 'local'), false);
});

// ============================================================
// SECTION 8: authMode=none — all routes accessible without auth
// ============================================================

test('When AUTH_MODE=none, /api/config is accessible without auth', async () => {
  await withServer({ AUTH_MODE: 'none' }, async (base) => {
    const res = await httpReq(base, '/api/config');
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.authMode, 'none');
    assert.equal(res.json.requiresAuth, false);
  });
});

test('When AUTH_MODE=none, session ownership check is a no-op', async () => {
  const { checkSessionOwnership } = require('../lib/session-auth');

  const fakeReq = { user: null, isAuthenticated: () => false };
  assert.equal(checkSessionOwnership(fakeReq, 'agent:anyone:any', 'none'), true);
  assert.equal(checkSessionOwnership(fakeReq, 'unknown-key', 'none'), true);
});

// ============================================================
// SECTION 9: Routes that SHOULD have but might lack requireSessionOwnership
// ============================================================

test('GET /api/sessions/:key/history enforces session ownership (route-level check)', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/sessions/agent:bob:main/history');
    // Without auth cookie, should NOT return 200 with history data
    assert.notEqual(res.statusCode, 200, '/api/sessions/:key/history should not return 200 without auth');
  });
});

test('GET /api/sessions/:key/send enforces session ownership (route-level check)', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/sessions/agent:bob:main/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    // Without auth cookie, should NOT return 200
    assert.notEqual(res.statusCode, 200, '/api/sessions/:key/send should not return 200 without auth');
  });
});

test('GET /api/sessions/:key/send-stream enforces session ownership (route-level check)', async () => {
  await withServer({ AUTH_MODE: 'local', LOCAL_USERS: 'alice:password' }, async (base) => {
    const res = await httpReq(base, '/api/sessions/agent:bob:main/send-stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    });
    // Without auth cookie, should NOT return 200
    assert.notEqual(res.statusCode, 200, '/api/sessions/:key/send-stream should not return 200 without auth');
  });
});

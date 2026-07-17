const test = require('node:test');
const assert = require('node:assert/strict');

// security.js exports [securityHeaders, csrfTokenCheck, csrfOriginCheck]
const [securityHeaders, , csrfOriginCheck] = require('../security');

function createResponseMock() {
  const headers = {};
  return {
    headers,
    statusCode: 200,
    payload: undefined,
    setHeader(name, value) {
      headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

test('securityHeaders sets required baseline headers including CSP', () => {
  const req = {};
  const res = createResponseMock();
  let nextCalled = false;

  securityHeaders(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true);
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(res.headers['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');

  const csp = res.headers['Content-Security-Policy'];
  assert.ok(csp, 'CSP header should be set');

  // Core directives
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);

  // Resource directives
  assert.match(csp, /img-src 'self' data:/);
  // Audit #629: inline-script CSP restored via SHA-256 hash pinning.
  // The browser compares the inline <script> bytes against these hashes and
  // refuses to execute the script if the hash is missing. This preserves the
  // defense-in-depth we lost when nonce-based inline-script policy was dropped.
  assert.match(
    csp,
    /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'(?: 'sha256-[A-Za-z0-9+/=]+')*/,
  );
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  assert.match(csp, /connect-src 'self' ws: wss:/);

  // Navigation-restriction directives (audit #640)
  assert.match(csp, /base-uri 'self'/);
  assert.match(csp, /form-action 'self'/);
  assert.match(csp, /media-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
});

// ---------------------------------------------------------------------------
// Header-presence tests (audit #640): ensure every expected security header
// is set and CSP contains every required directive.
// ---------------------------------------------------------------------------

test('all required security headers are present on every response', () => {
  const req = {};
  const res = createResponseMock();
  securityHeaders(req, res, () => {});

  const requiredHeaders = [
    'X-Content-Type-Options',
    'X-Frame-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Content-Security-Policy',
  ];

  for (const header of requiredHeaders) {
    assert.ok(res.headers[header], `Header ${header} must be set`);
  }

  // Specific header values
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(
    res.headers['Permissions-Policy'],
    'camera=(), microphone=(), geolocation=()',
  );
});

test('CSP includes all required directives (header-presence)', () => {
  const req = {};
  const res = createResponseMock();
  securityHeaders(req, res, () => {});

  const csp = res.headers['Content-Security-Policy'];
  assert.ok(csp, 'CSP must be set');

  // Parse CSP into a map of directive -> value string
  const directives = {};
  for (const part of csp.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(' ');
    if (spaceIdx === -1) {
      directives[trimmed] = '';
    } else {
      directives[trimmed.slice(0, spaceIdx)] = trimmed.slice(spaceIdx + 1);
    }
  }

  // Required directives per audit #640 + existing baseline
  const requiredDirectives = [
    'default-src',
    'base-uri',
    'object-src',
    'frame-ancestors',
    'img-src',
    'style-src',
    'script-src',
    'connect-src',
    'form-action',
    'media-src',
    'worker-src',
  ];

  for (const dir of requiredDirectives) {
    assert.ok(directives[dir] !== undefined, `CSP must include ${dir} directive`);
  }

  // Spot-check key values
  assert.equal(directives['base-uri'], "'self'");
  assert.equal(directives['frame-ancestors'], "'none'");
  assert.equal(directives['form-action'], "'self'");
  assert.equal(directives['media-src'], "'self'");
  assert.equal(directives['worker-src'], "'self'");
  assert.equal(directives['object-src'], "'none'");
});

test('csrfOriginCheck blocks state-changing requests from untrusted origins', () => {
  const req = {
    method: 'POST',
    protocol: 'https',
    headers: {},
    get(name) {
      if (name.toLowerCase() === 'origin') return 'https://evil.example';
      if (name.toLowerCase() === 'host') return 'miso-chat.example.com';
      return undefined;
    },
  };

  const res = createResponseMock();
  let nextCalled = false;

  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, { error: 'Forbidden: untrusted request origin' });
});

// ---------------------------------------------------------------------------
// LOCAL_USERS default credential removal (audit #693)
// ---------------------------------------------------------------------------

test('setupPassport warns when LOCAL_USERS is unset and local auth is enabled', () => {
  // Save original env values
  const originalLocalUsers = process.env.LOCAL_USERS;

  // Capture console.warn output
  let warnMessage = null;
  const originalWarn = console.warn;
  console.warn = (msg) => { warnMessage = msg; };

  try {
    // Clear LOCAL_USERS
    delete process.env.LOCAL_USERS;

    // Clear the require cache so setupPassport re-evaluates env vars
    delete require.cache[require.resolve('../lib/auth-session')];
    const { setupPassport } = require('../lib/auth-session');

    setupPassport({ authMode: 'local', localAuthEnabled: true, oidcEnabled: false });

    assert.ok(
      warnMessage != null,
      'console.warn should be called when LOCAL_USERS is not set',
    );
    assert.match(
      warnMessage,
      /LOCAL_USERS.*not set/i,
      'warning message should mention LOCAL_USERS',
    );
  } finally {
    console.warn = originalWarn;
    // Restore env
    if (originalLocalUsers !== undefined) {
      process.env.LOCAL_USERS = originalLocalUsers;
    } else {
      delete process.env.LOCAL_USERS;
    }
  }
});

test('setupPassport does not use hardcoded default credentials when LOCAL_USERS is unset', () => {
  // Verify the source code does not contain hardcoded default credentials
  const fs = require('fs');
  const path = require('path');

  const authSessionPath = path.resolve(__dirname, '../lib/auth-session.js');
  const sourceCode = fs.readFileSync(authSessionPath, 'utf-8');

  // Check that the hardcoded default "admin:password123" is not present
  assert.doesNotMatch(
    sourceCode,
    /admin:password123/,
    'auth-session.js should not contain hardcoded default credentials',
  );

  // Verify that LOCAL_USERS fallback does not include any default users
  // The pattern should be something like: (process.env.LOCAL_USERS || '').split(',')
  assert.match(
    sourceCode,
    /process\.env\.LOCAL_USERS.*\|\|.*['"]['"]/,
    'LOCAL_USERS should fall back to empty string when not set',
  );
});

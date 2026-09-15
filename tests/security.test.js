const test = require('node:test');
const assert = require('node:assert/strict');

// security.js exports [securityHeaders, csrfTokenCheck, csrfOriginCheck]
const [securityHeaders, , csrfOriginCheck] = require('../security');
const tp = require('../lib/trusted-proxies');

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
  assert.equal(res.headers['X-DNS-Prefetch-Control'], 'off');
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
    'X-DNS-Prefetch-Control',
    'Referrer-Policy',
    'Permissions-Policy',
    'Cross-Origin-Resource-Policy',
    'Cross-Origin-Opener-Policy',
    'Content-Security-Policy',
  ];

  for (const header of requiredHeaders) {
    assert.ok(res.headers[header], `Header ${header} must be set`);
  }

  // Specific header values
  assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(res.headers['X-Frame-Options'], 'DENY');
  assert.equal(res.headers['X-DNS-Prefetch-Control'], 'off');
  assert.equal(res.headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(
    res.headers['Permissions-Policy'],
    'camera=(), microphone=(), geolocation=()',
  );
  assert.equal(res.headers['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(res.headers['Cross-Origin-Opener-Policy'], 'same-origin');
});

test('Strict-Transport-Security is omitted on plain-HTTP requests', () => {
  const req = { protocol: 'http', headers: {} };
  const res = createResponseMock();
  securityHeaders(req, res, () => {});
  assert.equal(
    res.headers['Strict-Transport-Security'],
    undefined,
    'HSTS must not be emitted over plaintext HTTP',
  );
});

test('Strict-Transport-Security is set when req.protocol is https', () => {
  const req = { protocol: 'https', headers: {} };
  const res = createResponseMock();
  securityHeaders(req, res, () => {});
  assert.equal(
    res.headers['Strict-Transport-Security'],
    'max-age=31536000; includeSubDomains',
  );
});

test('Strict-Transport-Security is set when X-Forwarded-Proto is https from a trusted peer', () => {
  process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
  tp.resetTrustedProxiesCache();
  try {
    const req = {
      protocol: 'http',
      headers: { 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = createResponseMock();
    securityHeaders(req, res, () => {});
    assert.equal(
      res.headers['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains',
    );
  } finally {
    delete process.env.TRUSTED_PROXY_IPS;
    tp.resetTrustedProxiesCache();
  }
});

test('Strict-Transport-Security is set when ENFORCE_HTTPS=true', () => {
  const originalEnforceHttps = process.env.ENFORCE_HTTPS;
  process.env.ENFORCE_HTTPS = 'true';
  try {
    const req = { protocol: 'http', headers: {} };
    const res = createResponseMock();
    securityHeaders(req, res, () => {});
    assert.equal(
      res.headers['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains',
    );
  } finally {
    if (originalEnforceHttps === undefined) {
      delete process.env.ENFORCE_HTTPS;
    } else {
      process.env.ENFORCE_HTTPS = originalEnforceHttps;
    }
  }
});

test('Strict-Transport-Security honours comma-separated X-Forwarded-Proto from a trusted peer', () => {
  // Envoy/ALB often append to a comma-separated X-Forwarded-Proto; the first
  // hop is the authoritative one.
  process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
  tp.resetTrustedProxiesCache();
  try {
    const req = {
      protocol: 'http',
      headers: { 'x-forwarded-proto': 'https,http' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const res = createResponseMock();
    securityHeaders(req, res, () => {});
    assert.equal(
      res.headers['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains',
    );
  } finally {
    delete process.env.TRUSTED_PROXY_IPS;
    tp.resetTrustedProxiesCache();
  }
});

// ---------------------------------------------------------------------------
// Regression tests (issue #883): `isHttpsRequest` and `getServerOrigin` used
// to read `X-Forwarded-Proto` / `X-Forwarded-Host` unconditionally. On the
// default direct-on-port-3000 deployment shape (empty TRUSTED_PROXY_IPS) a
// plain-HTTP client could therefore (a) trick a victim's browser into
// caching a one-year HSTS pin for a plaintext origin and (b) forge both
// forwarded headers so `csrfOriginCheck`'s same-origin short-circuit accepts
// a cross-site request. These tests pin that the forwarded headers are now
// gated on the trusted-proxy allowlist.
// ---------------------------------------------------------------------------

test('forged X-Forwarded-Proto from an untrusted peer does not emit HSTS', () => {
  // No trusted proxies configured: the default deployment shape.
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();

  const req = {
    protocol: 'http',
    headers: { 'x-forwarded-proto': 'https' },
    socket: { remoteAddress: '203.0.113.5' },
  };
  const res = createResponseMock();
  securityHeaders(req, res, () => {});
  assert.equal(
    res.headers['Strict-Transport-Security'],
    undefined,
    'a forged X-Forwarded-Proto must not mint HSTS on a plaintext deployment',
  );
});

test('forged X-Forwarded-Host does not let an untrusted peer pass csrfOriginCheck', () => {
  // No trusted proxies configured. The attacker spoofs both forwarded headers
  // so the server-claimed origin matches their attacker Origin; that must no
  // longer satisfy the same-origin short-circuit — only the configured
  // allowlist can.
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();

  const req = {
    method: 'POST',
    protocol: 'http',
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'attacker.example',
      host: '127.0.0.1:3000',
    },
    socket: { remoteAddress: '203.0.113.5' },
    get(name) {
      if (name === 'origin') return 'https://attacker.example';
      if (name === 'referer') return undefined;
      if (name === 'host') return '127.0.0.1:3000';
      return undefined;
    },
  };

  const res = createResponseMock();
  let nextCalled = false;
  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, 'forged forwarded headers must not satisfy the same-origin check');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.payload, { error: 'Forbidden: untrusted request origin' });
});

test('csrfOriginCheck still passes when the Origin is on the configured allowlist (untrusted peer)', () => {
  // Even with an untrusted peer, a legitimate browser Origin that is on the
  // allowlist must still be accepted — the hardening must not break the
  // allowlist path.
  delete process.env.TRUSTED_PROXY_IPS;
  tp.resetTrustedProxiesCache();

  const req = {
    method: 'POST',
    protocol: 'http',
    headers: { host: '127.0.0.1:3000' },
    socket: { remoteAddress: '203.0.113.5' },
    get(name) {
      if (name === 'origin') return 'http://127.0.0.1:3000'; // on the default allowlist
      if (name === 'host') return '127.0.0.1:3000';
      return undefined;
    },
  };

  const res = createResponseMock();
  let nextCalled = false;
  csrfOriginCheck(req, res, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, true, 'an allowlisted Origin must still pass');
  assert.equal(res.statusCode, 200);
});

test('a trusted proxy peer with X-Forwarded-Proto: https emits HSTS and uses the forwarded origin', () => {
  process.env.TRUSTED_PROXY_IPS = '127.0.0.1';
  tp.resetTrustedProxiesCache();

  try {
    // HSTS: a trusted proxy terminates TLS; the forwarded https must be honored.
    const hstsReq = {
      protocol: 'http',
      headers: { 'x-forwarded-proto': 'https' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    const hstsRes = createResponseMock();
    securityHeaders(hstsReq, hstsRes, () => {});
    assert.equal(
      hstsRes.headers['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains',
    );

    // CSRF: a trusted proxy also sets X-Forwarded-Host, so the server origin
    // reflects the public https origin and a matching same-origin POST passes
    // without needing to be on the allowlist.
    const csrfReq = {
      method: 'POST',
      protocol: 'http',
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'miso-chat.example.com',
        host: '127.0.0.1:3000',
      },
      socket: { remoteAddress: '127.0.0.1' },
      get(name) {
        if (name === 'origin') return 'https://miso-chat.example.com';
        if (name === 'host') return '127.0.0.1:3000';
        return undefined;
      },
    };

    const csrfRes = createResponseMock();
    let nextCalled = false;
    csrfOriginCheck(csrfReq, csrfRes, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true, 'a trusted proxy asserting the real origin must satisfy the same-origin check');
    assert.equal(csrfRes.statusCode, 200);
  } finally {
    delete process.env.TRUSTED_PROXY_IPS;
    tp.resetTrustedProxiesCache();
  }
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
// CSP manifest fallback log level (audit #812): the degraded `unsafe-inline`
// CSP must be loud in production (error) and a warn in dev.
// ---------------------------------------------------------------------------

function withMissingManifest(nodeEnv, fn) {
  const fs = require('fs');
  const path = require('path');
  const manifestPath = path.resolve(__dirname, '../public/csp-hashes.json');
  const backupPath = manifestPath + '.test-backup';

  const originalNodeEnv = process.env.NODE_ENV;
  const originalError = console.error;
  const originalWarn = console.warn;
  const captured = { error: null, warn: null };
  console.error = (msg) => { captured.error = msg; };
  console.warn = (msg) => { captured.warn = msg; };

  try {
    fs.renameSync(manifestPath, backupPath);
    process.env.NODE_ENV = nodeEnv;
    delete require.cache[require.resolve('../security')];
    const [securityHeaders] = require('../security');

    const req = {};
    const res = createResponseMock();
    securityHeaders(req, res, () => {});

    fn(captured, res);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
    fs.renameSync(backupPath, manifestPath);
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
    delete require.cache[require.resolve('../security')];
  }
}

test('CSP manifest fallback escalates to console.error in production', () => {
  withMissingManifest('production', (captured, res) => {
    assert.ok(
      captured.error != null,
      'console.error should be called in production',
    );
    assert.match(captured.error, /csp-hashes\.json missing or empty/);
    assert.equal(
      captured.warn,
      null,
      'dev-level console.warn must not be used in production',
    );
    // The degraded CSP is still served (fallback, not startup failure)
    assert.match(
      res.headers['Content-Security-Policy'],
      /script-src[^;]*'unsafe-inline'/,
    );
  });
});

test('CSP manifest fallback keeps console.warn in dev', () => {
  withMissingManifest('development', (captured, res) => {
    assert.ok(
      captured.warn != null,
      'console.warn should be called in dev',
    );
    assert.match(captured.warn, /csp-hashes\.json missing or empty/);
    assert.equal(
      captured.error,
      null,
      'console.error must not be used in dev',
    );
    assert.match(
      res.headers['Content-Security-Policy'],
      /script-src[^;]*'unsafe-inline'/,
    );
  });
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

const test = require('node:test');
const assert = require('node:assert/strict');

const [securityHeaders, csrfOriginCheck] = require('../security');

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
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline'/);
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
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

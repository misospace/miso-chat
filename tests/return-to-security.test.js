const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars-long';
process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';

const { getReturnTo } = require('../server');

function makeReq(protocol, host, body, query) {
  return {
    protocol: protocol || 'http',
    get: (header) => {
      if (header === 'host') return host || 'localhost:3000';
      return '';
    },
    body: body || null,
    query: query || null,
  };
}

test('web mode rejects cross-origin http/https return_to', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'https://evil.example.com/phish' });
  assert.equal(getReturnTo(req, '/', 'web'), '/');

  const req2 = makeReq('http', 'localhost:3000', null, { return_to: 'https://phishing.evil.example.com/steal' });
  assert.equal(getReturnTo(req2, '/', 'web'), '/');
});

test('web mode allows same-origin relative paths', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: '/dashboard' });
  assert.equal(getReturnTo(req, '/', 'web'), '/dashboard');

  const req2 = makeReq('http', 'localhost:3000', null, { return_to: '/chat?session=abc' });
  assert.equal(getReturnTo(req2, '/', 'web'), '/chat?session=abc');

  const req3 = makeReq('http', 'localhost:3000', {}, { return_to: '/sessions/123/messages' });
  assert.equal(getReturnTo(req3, '/', 'web'), '/sessions/123/messages');
});

test('web mode allows same-origin absolute URLs (strips to path)', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'http://localhost:3000/dashboard' });
  assert.equal(getReturnTo(req, '/', 'web'), '/dashboard');

  const req2 = makeReq('https', 'localhost:3000', {}, { return_to: 'https://localhost:3000/chat?foo=bar' });
  assert.equal(getReturnTo(req2, '/', 'web'), '/chat?foo=bar');
});

test('mobile mode allows mobile schemes', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'misochat://auth/callback' });
  assert.equal(getReturnTo(req, '/', 'mobile'), 'misochat://auth/callback');

  const req2 = makeReq('http', 'localhost:3000', {}, { return_to: 'capacitor://localhost/auth' });
  assert.equal(getReturnTo(req2, '/', 'mobile'), 'capacitor://localhost/auth');

  const req3 = makeReq('http', 'localhost:3000', { return_to: 'ionic://localhost/deep-link' }, null);
  assert.equal(getReturnTo(req3, '/', 'mobile'), 'ionic://localhost/deep-link');
});

test('mobile mode rejects http/https', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'https://example.com' });
  assert.equal(getReturnTo(req, '/', 'mobile'), '/');

  const req2 = makeReq('http', 'localhost:3000', {}, { return_to: 'http://evil.com/phish' });
  assert.equal(getReturnTo(req2, '/', 'mobile'), '/');
});

test('any mode accepts all schemes (backward compat)', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'https://example.com' });
  assert.equal(getReturnTo(req, '/', 'any'), 'https://example.com/');

  const req2 = makeReq('http', 'localhost:3000', {}, { return_to: 'misochat://auth/callback' });
  assert.equal(getReturnTo(req2, '/', 'any'), 'misochat://auth/callback');

  const req3 = makeReq('http', 'localhost:3000', { return_to: '/relative' }, null);
  assert.equal(getReturnTo(req3, '/', 'any'), '/relative');
});

test('web mode rejects hostile return_to via query param', () => {
  const req = makeReq('http', 'localhost:3000', null, { return_to: 'https://evil.example.com/steal' });
  assert.equal(getReturnTo(req, '/', 'web'), '/');
});

test('web mode rejects hostile return_to via body param', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'https://evil.example.com/steal' }, null);
  assert.equal(getReturnTo(req, '/', 'web'), '/');
});

test('empty and whitespace return_to falls back', () => {
  const req = makeReq('http', 'localhost:3000', {}, {});
  assert.equal(getReturnTo(req, '/fallback', 'web'), '/fallback');

  const req2 = makeReq('http', 'localhost:3000', { return_to: '   ' }, null);
  assert.equal(getReturnTo(req2, '/fallback', 'web'), '/fallback');
});

test('invalid URLs fall back gracefully', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'not a url at all' }, null);
  assert.equal(getReturnTo(req, '/', 'web'), '/');

  const req2 = makeReq('http', 'localhost:3000', {}, { return_to: 'misochat://:invalid' });
  assert.equal(getReturnTo(req2, '/', 'mobile'), '/');
});

test('path traversal in relative paths is normalized by getReturnTo', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: '/../etc/passwd' }, null);
  assert.equal(getReturnTo(req, '/', 'web'), '/etc/passwd');

  const req2 = makeReq('http', 'localhost:3000', {}, { return_to: '/foo/../../bar' });
  assert.equal(getReturnTo(req2, '/', 'web'), '/bar');

  const req3 = makeReq('http', 'localhost:3000', { return_to: '/..%2F..%2Fetc/passwd' }, null);
  // %2F is not decoded by URL class, so it stays as a literal segment
  assert.equal(getReturnTo(req3, '/', 'web'), '/..%2F..%2Fetc/passwd');
});

test('same-origin absolute URL with path traversal normalizes to relative path', () => {
  const req = makeReq('http', 'localhost:3000', { return_to: 'http://localhost:3000/../dashboard' }, null);
  assert.equal(getReturnTo(req, '/', 'web'), '/dashboard');

  const req2 = makeReq('http', 'localhost:3000', {}, { return_to: 'http://localhost:3000/foo/../../bar' });
  assert.equal(getReturnTo(req2, '/', 'web'), '/bar');
});

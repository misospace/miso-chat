const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSessionAccess, requireSessionAccess } = require('../lib/session-auth');

function makeRequest(authenticated = true) {
  return {
    user: authenticated ? { username: 'web-user' } : null,
    isAuthenticated: () => authenticated,
  };
}

test('authenticated users can access OpenClaw agent sessions', () => {
  const req = makeRequest();

  assert.equal(checkSessionAccess(req, 'local'), true);
  assert.equal(checkSessionAccess(req, 'oidc'), true);
});

test('session access does not treat the OpenClaw agent ID as a username', () => {
  const req = makeRequest();

  assert.equal(checkSessionAccess(req, 'oidc'), true);
});

test('session access rejects unauthenticated users when auth is enabled', () => {
  const req = makeRequest(false);

  assert.equal(checkSessionAccess(req, 'local'), false);
  assert.equal(checkSessionAccess(req, 'oidc'), false);
});

test('session access allows auth-disabled deployments', () => {
  assert.equal(checkSessionAccess(makeRequest(false), 'none'), true);
});

test('session access denies unknown auth modes', () => {
  assert.equal(checkSessionAccess(makeRequest(), 'unexpected'), false);
});

test('requireSessionAccess allows an authenticated request', () => {
  const middleware = requireSessionAccess('oidc');
  let nextCalled = false;

  middleware(makeRequest(), {}, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
});

test('requireSessionAccess blocks an unauthenticated request', () => {
  const middleware = requireSessionAccess('oidc');
  const res = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  let nextCalled = false;

  middleware(makeRequest(false), res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.payload.error, /authenticated session access required/i);
});

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkSessionOwnership, requireSessionOwnership, extractSessionOwner } = require('../lib/session-auth');

// ===== extractSessionOwner tests =====

test('extractSessionOwner parses agent:<username>:<thread> format', () => {
  assert.equal(extractSessionOwner('agent:admin:main'), 'admin');
  assert.equal(extractSessionOwner('agent:alice:thread-123'), 'alice');
  assert.equal(extractSessionOwner('agent:bob:chat:gpt-4o-thread-abc'), 'bob');
});

test('extractSessionOwner parses g-agent-<name>-<uuid> format', () => {
  assert.equal(extractSessionOwner('g-agent-chat-123e4567-e89b-12d3-a456-426614174000'), 'chat');
  assert.equal(extractSessionOwner('g_agent-asistent-123e4567-e89b-12d3-a456-426614174000'), 'asistent');
});

test('extractSessionOwner returns null for unknown formats', () => {
  assert.equal(extractSessionOwner('unknown-key'), null);
  assert.equal(extractSessionOwner(''), null);
  assert.equal(extractSessionOwner(null), null);
  assert.equal(extractSessionOwner(undefined), null);
  assert.equal(extractSessionOwner('agent:main:main'), 'main'); // edge case: single-part after agent:
});

// ===== checkSessionOwnership tests =====

function makeUser(username, email) {
  const user = { username };
  if (email) user.email = email;
  return user;
}

function makeRequest(user) {
  return {
    user,
    isAuthenticated: () => true,
  };
}

test('checkSessionOwnership allows access when authMode is none', () => {
  const req = makeRequest(makeUser('anyone'));
  assert.equal(checkSessionOwnership(req, 'agent:admin:main', 'none'), true);
  assert.equal(checkSessionOwnership(req, 'unknown-key', 'none'), true);
});

test('checkSessionOwnership denies unauthenticated requests', () => {
  const req = { user: null, isAuthenticated: () => false };
  assert.equal(checkSessionOwnership(req, 'agent:admin:main', 'local'), false);
});

test('checkSessionOwnership allows matching local auth user', () => {
  const req = makeRequest(makeUser('admin'));
  assert.equal(checkSessionOwnership(req, 'agent:admin:main', 'local'), true);
  assert.equal(checkSessionOwnership(req, 'agent:alice:thread-1', 'local'), false);
});

test('checkSessionOwnership allows matching OIDC user by username', () => {
  const req = makeRequest(makeUser('alice', 'alice@example.com'));
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'oidc'), true);
  assert.equal(checkSessionOwnership(req, 'agent:bob:main', 'oidc'), false);
});

test('checkSessionOwnership allows matching OIDC user by email substring', () => {
  const req = makeRequest(makeUser('user123', 'alice@example.com'));
  // email contains owner name
  assert.equal(checkSessionOwnership(req, 'agent:alice:main', 'oidc'), true);
});

test('checkSessionOwnership denies unknown session key format', () => {
  const req = makeRequest(makeUser('admin'));
  assert.equal(checkSessionOwnership(req, 'unknown-session-key', 'local'), false);
  assert.equal(checkSessionOwnership(req, 'unknown-session-key', 'oidc'), false);
});

// ===== requireSessionOwnership middleware tests =====

function createReq(params, body, query) {
  return {
    params: params || {},
    body: body || {},
    query: query || {},
    user: makeUser('admin'),
    isAuthenticated: () => true,
  };
}

function createResMock() {
  const res = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  return res;
}

test('requireSessionOwnership middleware blocks unauthorized access', () => {
  const mw = requireSessionOwnership('local');
  const req = createReq({ key: 'agent:bob:main' });
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.ok(res.payload.error.includes('Forbidden'));
});

test('requireSessionOwnership middleware allows authorized access', () => {
  const mw = requireSessionOwnership('local');
  const req = createReq({ key: 'agent:admin:main' });
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
});

test('requireSessionOwnership middleware skips when no session key', () => {
  const mw = requireSessionOwnership('local');
  const req = createReq({});
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
});

test('requireSessionOwnership middleware checks query sessionKey', () => {
  const mw = requireSessionOwnership('local');
  const req = createReq({}, {}, { sessionKey: 'agent:bob:main' });
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
});

test('requireSessionOwnership middleware checks body sessionKey', () => {
  const mw = requireSessionOwnership('local');
  const req = createReq({}, { sessionKey: 'agent:bob:main' });
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
});

test('requireSessionOwnership middleware allows OIDC user by email', () => {
  const req = createReq({ key: 'agent:alice:main' });
  req.user = makeUser('user123', 'alice@example.com');
  const mw = requireSessionOwnership('oidc');
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, true);
});

test('requireSessionOwnership middleware denies OIDC user without match', () => {
  const req = createReq({ key: 'agent:bob:main' });
  req.user = makeUser('alice', 'alice@example.com');
  const mw = requireSessionOwnership('oidc');
  const res = createResMock();
  let nextCalled = false;

  mw(req, res, () => { nextCalled = true; });

  assert.equal(nextCalled, false);
});

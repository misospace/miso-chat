const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER_PATH = path.join(__dirname, '..', 'server.js');

/**
 * Spawn a fresh Node.js process running server.js with given env vars.
 * Returns { stdout, stderr, code }.
 */
function runServerWithEnv(envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);

    // Kill after 5s (server.js runs forever)
    setTimeout(() => child.kill('SIGTERM'), 5000).unref();
  });
}

// ===== Test: default behavior (no SESSION_COOKIE_DOMAIN) =====

test('without SESSION_COOKIE_DOMAIN, server starts without wildcard warning', async () => {
  const { stderr } = await runServerWithEnv({
    AUTH_MODE: 'local',
    LOCAL_USERS: 'admin:password123',
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-at-least-32-chars',
    // Ensure SESSION_COOKIE_DOMAIN is NOT set
    SESSION_COOKIE_DOMAIN: '',
  });

  assert.ok(!stderr.includes('SESSION_COOKIE_DOMAIN'),
    'Should not mention SESSION_COOKIE_DOMAIN in warnings when unset');
});

// ===== Test: explicit SESSION_COOKIE_DOMAIN =====

test('with SESSION_COOKIE_DOMAIN=example.com, server starts without wildcard warning', async () => {
  const { stderr } = await runServerWithEnv({
    AUTH_MODE: 'local',
    LOCAL_USERS: 'admin:password123',
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-at-least-32-chars',
    SESSION_COOKIE_DOMAIN: 'example.com',
  });

  assert.ok(!stderr.includes('wildcard domain'),
    'Should not warn about wildcard when SESSION_COOKIE_DOMAIN is a plain domain');
});

// ===== Test: wildcard SESSION_COOKIE_DOMAIN triggers warning =====

test('wildcard SESSION_COOKIE_DOMAIN triggers warning log', async () => {
  const { stderr } = await runServerWithEnv({
    AUTH_MODE: 'local',
    LOCAL_USERS: 'admin:password123',
    NODE_ENV: 'test',
    SESSION_SECRET: 'test-session-secret-at-least-32-chars',
    SESSION_COOKIE_DOMAIN: '.example.com',
  });

  assert.ok(stderr.includes('SESSION_COOKIE_DOMAIN'),
    'Should mention SESSION_COOKIE_DOMAIN in warning');
  assert.ok(stderr.includes('wildcard domain'),
    'Warning should mention wildcard domain');
  assert.ok(stderr.includes('Session cookies will be sent to all subdomains'),
    'Warning should mention subdomain impact');
});

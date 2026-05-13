const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars';

const { app, server } = require('../server');

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const req = http.request({
        hostname: '127.0.0.1',
        port: address.port,
        path,
        method: options.method || 'GET',
        headers: options.headers || {},
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          listener.close(() => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        });
      });

      req.on('error', (err) => {
        listener.close(() => reject(err));
      });

      if (options.body) req.write(options.body);
      req.end();
    });

    listener.on('error', reject);
  });
}

test('GET / redirects to login when unauthenticated', async () => {
  const res = await request('/');

  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, '/login?return_to=%2F');
});

test('GET /api/auth reports unauthenticated local auth state', async () => {
  const res = await request('/api/auth', { headers: { Accept: 'application/json' } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'].includes('application/json'), true);

  const body = JSON.parse(res.body);
  assert.equal(body.authenticated, false);
  assert.equal(body.authMode, 'local');
  assert.equal(body.requiresAuth, true);
});

test.after(() => {
  server.close();
});

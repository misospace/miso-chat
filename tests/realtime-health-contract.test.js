const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.AUTH_MODE = 'local';
process.env.LOCAL_USERS = 'admin:password123';
process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-chars';

const { app } = require('../server');

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

test('GET /api/health returns gateway WS state fields', async () => {
  const res = await request('/api/health', { headers: { Accept: 'application/json' } });

  assert.equal(res.statusCode, 200);
  assert.ok(res.headers['content-type'].includes('application/json'));

  const body = JSON.parse(res.body);

  // Top-level fields must always be present
  assert.ok(body.status === 'healthy', 'status should be healthy');
  assert.ok(typeof body.version === 'string', 'version should be a string');
  assert.ok(typeof body.timestamp === 'string', 'timestamp should be an ISO string');

  // Gateway WS state must be exposed
  assert.ok(body.gatewayWs, 'gatewayWs field must exist');
  assert.ok(typeof body.gatewayWs.connected === 'boolean', 'gatewayWs.connected must be boolean');
  assert.ok(typeof body.gatewayWs.connecting === 'boolean', 'gatewayWs.connecting must be boolean');
  assert.ok(typeof body.gatewayWs.reconnectAttempts === 'number', 'gatewayWs.reconnectAttempts must be number');
  assert.ok(typeof body.gatewayWs.pendingRequests === 'number', 'gatewayWs.pendingRequests must be number');
  assert.ok(typeof body.gatewayWs.pendingForRecovery === 'number', 'gatewayWs.pendingForRecovery must be number');
  assert.ok(body.gatewayWs.lastError === null || typeof body.gatewayWs.lastError === 'string', 'lastError must be null or string');
  assert.ok(body.gatewayWs.lastClose === null || typeof body.gatewayWs.lastClose === 'object', 'lastClose must be null or object');

  // Realtime state must be exposed
  assert.ok(body.realtime, 'realtime field must exist');
  assert.ok(['healthy', 'degraded', 'reconnecting', 'disconnected'].includes(body.realtime.state),
    `realtime.state must be one of healthy/degraded/reconnecting/disconnected, got: ${body.realtime.state}`);
  assert.ok(typeof body.realtime.message === 'string', 'realtime.message must be a string');
});

test('GET /api/health realtime state reflects gateway connection', async () => {
  const res = await request('/api/health', { headers: { Accept: 'application/json' } });
  const body = JSON.parse(res.body);

  // In test mode, the gateway WS is not connected (no actual gateway running)
  assert.equal(body.gatewayWs.connected, false, 'gatewayWs.connected should be false in test mode');
  assert.ok(
    ['disconnected', 'degraded'].includes(body.realtime.state),
    `realtime.state should reflect disconnected or degraded state in test mode, got: ${body.realtime.state}`
  );
});

test('GET /api/health returns consistent structure across multiple calls', async () => {
  const results = [];
  for (let i = 0; i < 3; i++) {
    const res = await request('/api/health', { headers: { Accept: 'application/json' } });
    assert.equal(res.statusCode, 200);
    results.push(JSON.parse(res.body));
  }

  // All responses should have the same shape
  for (const body of results) {
    assert.ok(body.gatewayWs, 'gatewayWs must exist in every response');
    assert.ok(body.realtime, 'realtime must exist in every response');
    assert.ok(typeof body.version === 'string', 'version must be consistent');
  }

  // Timestamps should be different (monotonically increasing)
  const timestamps = results.map(r => new Date(r.timestamp).getTime());
  for (let i = 1; i < timestamps.length; i++) {
    assert.ok(timestamps[i] >= timestamps[i - 1], 'timestamps should be monotonically increasing');
  }
});

test('GET /api/health body is valid JSON with no trailing content', async () => {
  const res = await request('/api/health', { headers: { Accept: 'application/json' } });

  // Should parse as a single JSON object
  const body = JSON.parse(res.body);
  assert.equal(typeof body, 'object', 'body should be an object');

  // No extra keys that shouldn't be there
  const expectedKeys = new Set(['status', 'version', 'timestamp', 'gatewayWs', 'realtime']);
  const actualKeys = new Set(Object.keys(body));
  assert.ok(actualKeys.size === expectedKeys.size, `expected keys ${[...expectedKeys].join(', ')}, got ${[...actualKeys].join(', ')}`);
});

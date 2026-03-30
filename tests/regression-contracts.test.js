const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'development';
process.env.LOCAL_AUTH_ENABLED = 'false';
process.env.OIDC_ENABLED = 'false';

const { app } = require('../server');
const { GatewayWsManager } = require('../lib/gateway-ws');

async function withServer(run) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function fetchJson(base, path, options = {}) {
  const res = await fetch(`${base}${path}`, options);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { res, body };
}

test('GatewayWsManager defaults are still legacy and must be overridden explicitly', () => {
  const ws = new GatewayWsManager({ wsUrl: 'ws://example.invalid' });
  assert.equal(ws.clientId, 'miso-chat');
  assert.equal(ws.clientMode, 'ui');
});

test('GET /api/config exposes restored config contract defaults', async () => {
  await withServer(async (base) => {
    const { res, body } = await fetchJson(base, '/api/config');
    assert.equal(res.status, 200);
    assert.equal(body.defaultSessionKey, 'agent:main:main');
    assert.equal(body.assistantName, 'Miso');
    assert.ok(Object.prototype.hasOwnProperty.call(body, 'pushNotifications'));
    assert.equal(typeof body.pushNotifications.enabled, 'boolean');
  });
});

test('GET /api/sessions returns development fallback session with baseline default key', async () => {
  await withServer(async (base) => {
    const { res, body } = await fetchJson(base, '/api/sessions');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.sessions));
    assert.equal(body.sessions[0]?.sessionKey, 'agent:main:main');
    assert.equal(body.sessions[0]?.fallback, true);
  });
});

test('GET /api/events exists and returns SSE headers/initial chunk instead of silently 404ing', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get('content-type') || ''), /text\/event-stream/i);
    const reader = res.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value || new Uint8Array());
    assert.match(text, /connected/);
    await reader.cancel();
  });
});

test('POST /api/sessions/:key/send accepts frontend message field and rejects empty payloads cleanly', async () => {
  await withServer(async (base) => {
    const { res, body } = await fetchJson(base, '/api/sessions/default/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    assert.equal(res.status, 400);
    assert.match(String(body.error || ''), /text is required/i);
  });
});

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

test('POST /api/sessions/:key/send prefers sanitized assistant content over raw tool-result responseText', async () => {
  const originalIsConnected = GatewayWsManager.prototype.isConnected;
  const originalSend = GatewayWsManager.prototype.send;

  GatewayWsManager.prototype.isConnected = () => true;
  GatewayWsManager.prototype.send = async () => ({
    result: {
      responseText: 'tool_result: {"private":true}',
      response: {
        model: 'test-model',
        content: [
          { type: 'tool_result', content: 'internal tool output' },
          { type: 'text', text: 'Clean final answer' },
        ],
      },
      toolCalls: [],
    },
  });

  try {
    await withServer(async (base) => {
      const { res, body } = await fetchJson(base, '/api/sessions/default/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      assert.equal(res.status, 200);
      assert.equal(body.responseText, 'Clean final answer');
      assert.equal(body.responseText.includes('tool_result'), false);
    });
  } finally {
    GatewayWsManager.prototype.isConnected = originalIsConnected;
    GatewayWsManager.prototype.send = originalSend;
  }
});

test('POST /api/sessions/:key/send-stream emits sanitized assistant text instead of raw tool output', async () => {
  const originalIsConnected = GatewayWsManager.prototype.isConnected;
  const originalSend = GatewayWsManager.prototype.send;

  GatewayWsManager.prototype.isConnected = () => true;
  GatewayWsManager.prototype.send = async () => ({
    result: {
      responseText: 'tool_result: {"private":true}',
      response: {
        model: 'test-model',
        content: [
          { type: 'tool_result', content: 'internal tool output' },
          { type: 'text', text: 'Clean streamed answer' },
        ],
      },
      toolCalls: [],
    },
  });

  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/api/sessions/default/send-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello' }),
      });

      assert.equal(res.status, 200);
      assert.match(String(res.headers.get('content-type') || ''), /text\/event-stream/i);

      const text = await res.text();
      assert.match(text, /Clean streamed answer/);
      assert.doesNotMatch(text, /tool_result/);
      assert.doesNotMatch(text, /internal tool output/);
    });
  } finally {
    GatewayWsManager.prototype.isConnected = originalIsConnected;
    GatewayWsManager.prototype.send = originalSend;
  }
});

test('GET /api/sessions/:key/history strips raw tool_result from stored assistant messages', async () => {
  const originalIsConnected = GatewayWsManager.prototype.isConnected;
  const originalSend = GatewayWsManager.prototype.send;

  GatewayWsManager.prototype.isConnected = () => true;
  GatewayWsManager.prototype.send = async (action) => {
    if (action === 'chat.history') {
      return {
        result: {
          messages: [
            {
              role: 'user',
              content: 'run a tool please',
              timestamp: '2026-04-03T10:00:00Z',
            },
            {
              role: 'assistant',
              content: [
                { type: 'tool_result', content: 'raw internal tool output should not appear' },
                { type: 'text', text: 'Here is the final answer to the user' },
              ],
              responseText: 'raw tool_result: internal plumbing should be hidden',
              timestamp: '2026-04-03T10:00:01Z',
            },
          ],
        },
      };
    }
    return {};
  };

  try {
    await withServer(async (base) => {
      const { res, body } = await fetchJson(base, '/api/sessions/default/history');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(body?.messages));

      const assistantMsg = body.messages.find((m) => m.role === 'assistant');
      assert.ok(assistantMsg, 'assistant message should be present');

      // Content must be the cleaned final text, not the raw tool_result responseText
      assert.equal(assistantMsg.content, 'Here is the final answer to the user');
      assert.equal(String(assistantMsg.content).includes('tool_result'), false);
      assert.equal(String(assistantMsg.content).includes('internal plumbing'), false);

      // toolCalls must be stripped from history regardless
      assert.ok(Array.isArray(assistantMsg.toolCalls));
      assert.equal(assistantMsg.toolCalls.length, 0);
    });
  } finally {
    GatewayWsManager.prototype.isConnected = originalIsConnected;
    GatewayWsManager.prototype.send = originalSend;
  }
});

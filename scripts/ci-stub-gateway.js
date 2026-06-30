#!/usr/bin/env node
/**
 * CI stub gateway — minimal HTTP gateway for pre-merge smoke tests.
 *
 * Listens on a port and answers `POST /tools/invoke` with deterministic
 * responses for the few tools the smoke script exercises. This lets the
 * server boot, authenticate, and exercise `POST /api/sessions/:key/send`
 * without depending on the real OpenClaw Gateway.
 *
 * Used by `scripts/ci-pre-merge-smoke.sh` and `scripts/ci-auth-smoke.sh`.
 * Not for production use.
 */
'use strict';

const http = require('node:http');

const PORT = Number(process.env.STUB_GATEWAY_PORT || 3890);
const HOST = process.env.STUB_GATEWAY_HOST || '127.0.0.1';

const REQUEST_TIMEOUT_MS = 15_000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > 1_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function ok(result) {
  return { ok: true, result };
}

function sessionRecordFor(sessionKey) {
  return {
    sessionKey,
    displayName: sessionKey,
    fallback: false,
    lastMessage: null,
  };
}

function buildToolResponse(tool, args = {}) {
  const sessionKey = typeof args?.sessionKey === 'string' && args.sessionKey.trim()
    ? args.sessionKey.trim()
    : 'agent:main:main';

  switch (tool) {
    case 'sessions_list':
      return ok({
        sessions: [sessionRecordFor(sessionKey)],
      });
    case 'sessions_history':
      return ok({
        messages: [],
        cursor: null,
        hasMore: false,
      });
    case 'agent_identity_get':
      return ok({
        sessionKey,
        agentName: 'stub-agent',
        displayName: 'Stub Agent',
      });
    case 'agents_list':
      return ok({
        agents: [
          { id: 'stub-agent', name: 'stub-agent', displayName: 'Stub Agent' },
        ],
      });
    case 'sessions_send': {
      const text = typeof args?.message === 'string' ? args.message : '';
      const echoed = text && text.length > 0 ? text : 'stub reply';
      return ok({
        responseText: `stub-ack: ${echoed}`,
        response: {
          model: 'stub-model',
          content: [
            { type: 'text', text: `stub-ack: ${echoed}` },
          ],
        },
        toolCalls: [],
      });
    }
    case 'sessions_create':
      return ok({ session: sessionRecordFor(args?.sessionKey || sessionKey) });
    case 'session_status':
      return ok({ status: 'ready', sessionKey });
    case 'chat_abort':
      return ok({ aborted: false });
    default:
      return ok({ accepted: true, tool });
  }
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && (url === '/health' || url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (!(req.method === 'POST' && url === '/tools/invoke')) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
    return;
  }

  try {
    const body = await readJsonBody(req);
    const tool = body?.tool;
    const args = body?.args || {};
    const result = buildToolResponse(tool, args);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: { message: String(err?.message || err) } }));
  }
});

server.requestTimeout = REQUEST_TIMEOUT_MS;
server.keepAliveTimeout = 5_000;

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`ci-stub-gateway listening on http://${HOST}:${PORT}`);
});

function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`ci-stub-gateway received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
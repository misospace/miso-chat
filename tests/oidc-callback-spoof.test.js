'use strict';

/**
 * Regression test for issue #852.
 *
 * `app.set('trust proxy', 1)` used to let a direct TCP client on port 3000
 * spoof `X-Forwarded-Proto` / `X-Forwarded-Host` and have those values surface
 * as `req.protocol` / `req.get('host')`, which `buildOidcCallbackURL` fed into
 * the OIDC callback URL. With the trust-proxy knob removed and the safe
 * helpers in lib/trusted-proxies.js gating forwarded headers behind the
 * TRUSTED_PROXY_IPS allowlist, a direct client's forwarded headers must be
 * ignored and the callback URL must reflect the origin the client actually
 * reached.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const express = require('express');

const { buildOidcCallbackURL } = require('../lib/auth-session');
const tp = require('../lib/trusted-proxies');

// Ensure a clean allowlist: no trusted proxies, so forwarded headers are
// never honored for a direct peer.
delete process.env.TRUSTED_PROXY_IPS;
tp.resetTrustedProxiesCache();

function withServer() {
  return new Promise((resolve, reject) => {
    const app = express();
    // Deliberately do NOT call app.set('trust proxy', ...) — this mirrors the
    // hardened server.js.
    app.get('/probe', (req, res) => {
      res.json({
        callbackUrl: buildOidcCallbackURL(req),
        protocol: req.protocol,
        host: req.get('host'),
      });
    });
    const listener = app.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: address.port,
          path: '/probe',
          method: 'GET',
          headers: {
            // The attacker's spoofed forwarded headers.
            'X-Forwarded-Proto': 'https',
            'X-Forwarded-Host': 'attacker.example',
          },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            listener.close(() => {
              try {
                resolve({ port: address.port, body: JSON.parse(body) });
              } catch (err) {
                reject(err);
              }
            });
          });
        },
      );
      req.on('error', (err) => {
        listener.close(() => reject(err));
      });
      req.end();
    });
    listener.on('error', reject);
  });
}

test('direct client cannot spoof the OIDC callback URL via forwarded headers', async () => {
  const { port, body } = await withServer();

  // The legitimate origin is the one the client actually reached: plain HTTP
  // to 127.0.0.1:<port>. The spoofed https://attacker.example must not leak
  // into the callback URL.
  const expected = `http://127.0.0.1:${port}/auth/oidc/callback`;
  assert.equal(body.callbackUrl, expected);
  assert.ok(!body.callbackUrl.includes('attacker.example'), 'callback URL must not contain the spoofed host');
  assert.ok(!body.callbackUrl.startsWith('https://'), 'callback URL must not adopt the spoofed protocol');
});

test('safeProtocol/safeHost ignore forwarded headers for an untrusted peer', () => {
  const req = {
    headers: {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'attacker.example',
      host: 'localhost:3000',
    },
    socket: { remoteAddress: '203.0.113.5' },
    protocol: 'http',
    get: (header) => (header === 'host' ? 'localhost:3000' : ''),
  };

  assert.equal(tp.safeProtocol(req), 'http');
  assert.equal(tp.safeHost(req), 'localhost:3000');
});

test('safeProtocol/safeHost honor forwarded headers only for a trusted peer', () => {
  process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';
  tp.resetTrustedProxiesCache();
  try {
    const req = {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example.com',
        host: '10.0.0.5:3000',
      },
      socket: { remoteAddress: '10.0.0.5' },
      protocol: 'http',
      get: (header) => (header === 'host' ? '10.0.0.5:3000' : ''),
    };

    assert.equal(tp.safeProtocol(req), 'https');
    assert.equal(tp.safeHost(req), 'app.example.com');
  } finally {
    delete process.env.TRUSTED_PROXY_IPS;
    tp.resetTrustedProxiesCache();
  }
});

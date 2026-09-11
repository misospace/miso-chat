// Regression test for #869: GET /api/mobile/update-manifest used to perform
// two unbounded GitHub fetches (`/repos/.../releases/latest` and the manifest
// asset `browser_download_url`), so a stalled api.github.com edge could hold
// the mobile app's update check open indefinitely. The fix binds both fetches
// to an AbortSignal composed from a new MOBILE_UPDATE_FETCH_TIMEOUT_MS budget
// and the inbound request's own abort signal, and surfaces a stalled connect
// or stalled read as a logged 502 response — with no partial cache write.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Configure before server.js loads so its module-level constants pick up our
// values. We need a small fetch timeout so the test does not wait on the
// real 8s default, and a TTL of 0 so the in-memory cache never short-circuits
// the fetch path across multiple sub-tests (every request misses the cache).
process.env.MOBILE_UPDATE_FETCH_TIMEOUT_MS = '200';
process.env.MOBILE_UPDATE_CACHE_TTL_MS = '0';
// No auth so the route is reachable without a session.
process.env.AUTH_MODE = 'none';

// Capture the real http.request before any test mocks fetch: the client-side
// request() helper below must keep talking to the app over a real socket,
// while the mocks only intercept the route's outbound fetch() calls.
const realHttpRequest = http.request;

const { app, createMobileUpdateFetchSignal, MOBILE_UPDATE_FETCH_TIMEOUT_MS,
  getMobileUpdateCache, getMobileUpdateCacheTime } = require('../server');

function request(method = 'GET') {
  return new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const req = realHttpRequest(
        { hostname: '127.0.0.1', port: address.port, path: '/api/mobile/update-manifest', method },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            listener.close(() => resolve({ statusCode: res.statusCode, body }));
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

// A fetch mock that respects the signal it receives but otherwise never
// resolves. This is the exact shape of an upstream that has accepted the TCP
// connection but is wedged (and would otherwise hold the route handler open).
// We listen for the abort event so the test exits cleanly when the route's
// own deadline fires.
function makeStalledFetch() {
  return (url, opts = {}) => new Promise((_resolve, reject) => {
    const signal = opts && opts.signal;
    if (signal) {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }
    // Intentionally never resolve — the abort listener above is what tears
    // the promise down when the route's deadline fires.
  });
}

// A fetch mock whose first call stalls forever and whose second call returns
// a valid release payload. This is the path where the upstream served the
// /releases/latest response but the manifest asset download then stalled —
// the route must still surface that as 502 without writing the cache.
function makeFirstStallSecondRespondFetch(manifestPayload) {
  let callCount = 0;
  return (url, opts = {}) => {
    callCount += 1;
    const signal = opts && opts.signal;
    const onAbort = () => { /* abort handled below */ };
    if (callCount === 1) {
      return new Promise((_resolve, reject) => {
        if (signal) {
          if (signal.aborted) {
            reject(new Error('aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          signal.addEventListener('abort', onAbort, { once: true });
        }
        // never resolves
      });
    }
    // Second call resolves quickly with a valid release payload.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => manifestPayload,
    });
  };
}

const VALID_MANIFEST_PAYLOAD = {
  tag_name: 'v0.5.0',
  assets: [
    {
      name: 'update-manifest.json',
      browser_download_url: 'https://github.com/misospace/miso-chat/releases/download/v0.5.0/update-manifest.json',
    },
  ],
};

test('stalled first fetch returns 502 within timeout and does not cache', async (t) => {
  t.mock.method(globalThis, 'fetch', makeStalledFetch());

  const start = Date.now();
  const res = await request();
  const elapsed = Date.now() - start;

  assert.equal(
    res.statusCode,
    502,
    `expected 502 on stalled first fetch, got ${res.statusCode}: ${res.body}`,
  );
  // The deadline is 200ms in this test; allow generous slack for slow CI but
  // the rejection MUST happen well before a much longer no-deadline path would.
  assert.ok(
    elapsed < MOBILE_UPDATE_FETCH_TIMEOUT_MS + 1000,
    `should reject within ~MOBILE_UPDATE_FETCH_TIMEOUT_MS (${MOBILE_UPDATE_FETCH_TIMEOUT_MS}ms) but took ${elapsed}ms`,
  );

  // No partial write: the cache must still be empty after a failed fetch so
  // the next caller cannot be served (or held open on) a partial manifest.
  assert.equal(getMobileUpdateCache(), null,
    'mobileUpdateCache must NOT be written when the first fetch is stalled (issue #869)');
  assert.equal(getMobileUpdateCacheTime(), 0,
    'mobileUpdateCacheTime must NOT be updated when the first fetch is stalled');
});

test('stalled second fetch returns 502 within timeout and does not cache', async (t) => {
  t.mock.method(globalThis, 'fetch', makeFirstStallSecondRespondFetch(VALID_MANIFEST_PAYLOAD));

  const start = Date.now();
  const res = await request();
  const elapsed = Date.now() - start;

  // First fetch in this mock resolves quickly, but the second (the manifest
  // asset download) stalls forever. The route's signal-driven abort must
  // surface as 502.
  assert.equal(
    res.statusCode,
    502,
    `expected 502 on stalled second fetch, got ${res.statusCode}: ${res.body}`,
  );
  assert.ok(
    elapsed < MOBILE_UPDATE_FETCH_TIMEOUT_MS + 1000,
    `should reject within ~MOBILE_UPDATE_FETCH_TIMEOUT_MS (${MOBILE_UPDATE_FETCH_TIMEOUT_MS}ms) but took ${elapsed}ms`,
  );

  // No partial write: even though the first fetch succeeded and the route
  // saw a valid-looking asset URL, a stalled manifest asset download must
  // NOT populate the cache. Otherwise the next caller would be served a
  // manifest whose digest was never verified server-side.
  assert.equal(getMobileUpdateCache(), null,
    'mobileUpdateCache must NOT be written when the second fetch is stalled (issue #869)');
  assert.equal(getMobileUpdateCacheTime(), 0,
    'mobileUpdateCacheTime must NOT be updated when the second fetch is stalled');
});

test('createMobileUpdateFetchSignal composes timeout + request signal', () => {
  // The helper must return a fresh AbortSignal on every call so the route
  // handler is not sharing a timer across requests.
  const fakeReq = { signal: new AbortController().signal };
  const a = createMobileUpdateFetchSignal(fakeReq);
  const b = createMobileUpdateFetchSignal(fakeReq);
  assert.ok(a instanceof AbortSignal, 'createMobileUpdateFetchSignal must return an AbortSignal');
  assert.ok(b instanceof AbortSignal, 'createMobileUpdateFetchSignal must return an AbortSignal');
  assert.notEqual(a, b, 'each call must return a distinct AbortSignal (no shared timer)');
  assert.equal(a.aborted, false);
  assert.equal(b.aborted, false);
});

test('createMobileUpdateFetchSignal aborts on request disconnect (no req signal falls back)', () => {
  // Without an inbound request signal, the helper must still produce a
  // timeout-driven AbortSignal (no null deref, no infinite hang).
  const sig = createMobileUpdateFetchSignal(null);
  assert.ok(sig instanceof AbortSignal);
  assert.equal(sig.aborted, false);
});

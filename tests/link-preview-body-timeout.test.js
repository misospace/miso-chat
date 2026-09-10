// Regression test for #871: the link-preview body-read timeout used to break
// out of the `for await` body loop silently, so a body that paused past
// LINK_PREVIEW_BODY_READ_TIMEOUT_MS fell through to a 200 response carrying a
// truncated preview (and the partial HTML was then cached for 5 minutes).
// The fix surfaces the per-phase body-read timeout as a phased AbortError
// (phase 'body') that the /api/link-preview route maps to a 504, and the soft
// body-length limit as phase 'body-truncated', so the cache never stores
// partial HTML.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Shorten the per-phase body-read budget so the test does not wait 30s.
// Must be set before requiring server.js (the constant is read at load time).
process.env.LINK_PREVIEW_BODY_READ_TIMEOUT_MS = '250';
// Keep the overall budget well above the body-read budget so the body-read
// timer is guaranteed to fire first.
process.env.LINK_PREVIEW_TIMEOUT_MS = '5000';
// No auth so the route is reachable without a session.
process.env.AUTH_MODE = 'none';

// Allow loopback hosts in this test: the SSRF guard would normally block
// them, but the bug being fixed only manifests when the function actually
// reaches a body read, so we bypass the guard to exercise that path.
const ssrfModule = require('../lib/ssrf-validation');
const originalIsForbidden = ssrfModule.isForbiddenLinkPreviewHost;
const originalIsForbiddenAddress = ssrfModule.isForbiddenLinkPreviewAddress;
ssrfModule.isForbiddenLinkPreviewHost = async () => false;
ssrfModule.isForbiddenLinkPreviewAddress = () => false;

const { app, linkPreviewCache } = require('../server');

// Capture the real http.request before any test mocks it: the client-side
// request() helper below must keep talking to the app over a real socket,
// while the mock only intercepts the server's outbound preview fetch.
const realHttpRequest = http.request;

function request(path) {
  return new Promise((resolve, reject) => {
    const listener = app.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const req = realHttpRequest(
        { hostname: '127.0.0.1', port: address.port, path, method: 'GET' },
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

// An upstream that sends headers and one chunk, then goes quiet (no further
// chunks, no end). This is the exact shape of the upstream that used to hang
// the read and then return a truncated 200: the body-read timer must fire
// and surface a 504.
async function startPausedBodyServer() {
  const serverInstance = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    });
    res.write('<html><head><title>partial</title></head>');
    // Then go quiet: no further writes, no end.
    req.on('close', () => { /* upstream socket torn down by the client */ });
  });
  await new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
  const { port } = serverInstance.address();
  return { serverInstance, port };
}

test('body-read timeout returns 504 and writes nothing to the cache', async () => {
  const { serverInstance, port } = await startPausedBodyServer();
  const url = `http://127.0.0.1:${port}/paused`;

  const res = await request('/api/link-preview?url=' + encodeURIComponent(url));

  await new Promise((resolve) => serverInstance.close(resolve));

  assert.equal(
    res.statusCode,
    504,
    `expected 504 on body-read timeout, got ${res.statusCode}: ${res.body}`,
  );
  assert.match(
    res.body,
    /body phase after \d+ms/,
    `expected the 504 body to name the body phase and elapsed ms, got: ${res.body}`,
  );

  // The partial preview must never be cached: a later caller for the same
  // URL must not see the truncated card.
  assert.equal(
    linkPreviewCache.get(url),
    undefined,
    'the truncated preview must not be written to linkPreviewCache (issue #871)',
  );
});

test('soft body-length limit returns an error and writes nothing to the cache', async (t) => {
  // A single chunk past LINK_PREVIEW_MAX_HTML_CHARS * 1.5 trips the soft
  // limit; the partial HTML must be surfaced as a phased error, not a 200.
  t.mock.method(http, 'request', (_options, callback) => {
    const res = require('node:stream').Readable.from([
      '<html><head><title>huge</title></head>' + 'x'.repeat(400_000),
    ]);
    res.statusCode = 200;
    res.headers = { 'content-type': 'text/html' };
    setTimeout(() => callback(res), 0);
    const req = new (require('node:stream').Writable)({ write(_chunk, _enc, cb) { cb(); } });
    return req;
  });

  const url = 'http://93.184.216.34/huge';
  const res = await request('/api/link-preview?url=' + encodeURIComponent(url));

  t.mock.restoreAll();

  assert.notEqual(
    res.statusCode,
    200,
    `expected a non-200 response for a truncated body, got 200: ${res.body}`,
  );
  assert.equal(
    res.statusCode,
    502,
    `expected 502 for the body-truncated phase, got ${res.statusCode}: ${res.body}`,
  );
  assert.equal(
    linkPreviewCache.get(url),
    undefined,
    'the truncated preview must not be written to linkPreviewCache (issue #871)',
  );
});

test.after(() => {
  ssrfModule.isForbiddenLinkPreviewHost = originalIsForbidden;
  ssrfModule.isForbiddenLinkPreviewAddress = originalIsForbiddenAddress;
});

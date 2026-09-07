// Regression test for #780: the link preview overall-timeout was
// implemented as a setTimeout that threw from a timer callback, so a slow
// upstream could take down the Node process via an uncaughtException.
// The fix wires the overall budget through an AbortController so the
// fetch aborts and the function returns a phased 504 timeout error
// while the process stays alive.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

// Allow 127.0.0.1 (and other loopback) hosts in this test: the SSRF
// guard would normally block them, but the bug being fixed only
// manifests when the function actually reaches a fetch, so we have
// to bypass that guard to exercise the overall-timeout path.
const ssrfModule = require('../lib/ssrf-validation');
const originalIsForbidden = ssrfModule.isForbiddenLinkPreviewHost;
const originalResolveAndPinHost = ssrfModule.resolveAndPinHost;
ssrfModule.isForbiddenLinkPreviewHost = async () => false;
// Bypass the pin check for the same reason: the overall-timeout path is only
// reachable if the hop actually connects, which the private-IP check would
// otherwise refuse. Pass the hostname through as-is so the trickle server
// can serve the request at 127.0.0.1.
ssrfModule.resolveAndPinHost = async (hostname) => ({
  hostname,
  address: hostname,
  family: 4,
});

const server = require('../server');

// Default overall budget is 5s. We trickle chunks every 250ms for ~7s
// so the body-read phase (30s) outlives the overall budget (5s) and
// the overall timer is guaranteed to fire while the body is still
// streaming.
const TRICKLE_INTERVAL_MS = 250;
const TRICKLE_CHUNKS = 30; // 30 * 250ms = 7.5s, well over the 5s overall budget

async function startTrickleServer() {
  const serverInstance = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Transfer-Encoding': 'chunked',
    });
    let sent = 0;
    const interval = setInterval(() => {
      if (sent >= TRICKLE_CHUNKS) {
        clearInterval(interval);
        res.end('</html>');
        return;
      }
      if (res.writableEnded || res.destroyed) {
        clearInterval(interval);
        return;
      }
      res.write(`<!-- trickle chunk ${sent} -->`);
      sent++;
    }, TRICKLE_INTERVAL_MS);
    req.on('close', () => clearInterval(interval));
  });
  await new Promise((resolve) => serverInstance.listen(0, '127.0.0.1', resolve));
  const { port } = serverInstance.address();
  return { serverInstance, port };
}

test.after(() => {
  ssrfModule.isForbiddenLinkPreviewHost = originalIsForbidden;
  ssrfModule.resolveAndPinHost = originalResolveAndPinHost;
});

test('slow upstream trickling body past overall budget no longer crashes the process', async () => {
  const { serverInstance, port } = await startTrickleServer();
  const url = `http://127.0.0.1:${port}/`;

  // If the overall timer ever throws from a setTimeout callback, the
  // process dies before we reach the next assertion. Install a
  // process-level listener that records any uncaught exception; the
  // assertion at the end fails the test if one fired.
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);

  let caughtError = null;
  try {
    await server._fetchLinkPreview(url, new URL(url));
  } catch (error) {
    caughtError = error;
  }

  // Phased overall timeout error: must look like an AbortError with
  // phase 'overall' so the route handler returns 504.
  assert.ok(caughtError, 'expected a phased timeout error to be thrown');
  assert.equal(
    caughtError.name,
    'AbortError',
    `expected AbortError, got ${caughtError.name}: ${caughtError.message}`,
  );
  assert.equal(
    caughtError.phase,
    'overall',
    `expected phase 'overall', got ${caughtError.phase}`,
  );
  assert.ok(
    typeof caughtError.ms === 'number' && caughtError.ms > 0,
    `expected a positive ms, got ${caughtError.ms}`,
  );

  // Give a short window for any latent uncaughtException to surface,
  // then verify the process is still alive and that no uncaught
  // exception fired from the timer callback.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(
    uncaught.length,
    0,
    `uncaughtException fired: ${uncaught.map((e) => e.stack || e.message).join('\n')}`,
  );

  process.off('uncaughtException', onUncaught);
  await new Promise((resolve) => serverInstance.close(resolve));
});

test('overall timer is abort-based, not a throwing setTimeout', () => {
  // Static check: the source must not contain a setTimeout that
  // throws from inside its callback, because that is the pattern
  // that crashed the process.
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');
  assert.ok(
    !/setTimeout\(\s*\(\)\s*=>\s*\{\s*throw/.test(source),
    'server.js must not contain a setTimeout that throws from its callback (issue #780)',
  );
});

// Regression test for #766: the per-hop connect+headers timeout used a
// `new Promise(() => { setTimeout(...) })` executor that never resolved and
// whose timer was never cleared, so every successful hop left a dangling
// timer that kept the event loop alive for up to
// CONNECT_TIMEOUT + HEADERS_TIMEOUT (15s default). The fix tracks the
// timer handle and clears it once the hop completes (success or abort).
//
// SSRF validation blocks loopback, so a real successful hop cannot be driven
// through _fetchLinkPreview in-process; we assert the timer-lifecycle
// contract on the source instead. This is the exact invariant that prevents
// the dangling 15s timer.
test('hop connect+headers timer is tracked and cleared (no dangling timer)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf-8');

  // The dead Promise.race no-op must be gone.
  assert.ok(
    !/Promise\.race\(\[\s*Promise\.resolve\(\)/.test(source),
    'server.js must not contain the dead Promise.race([Promise.resolve(), ...]) no-op (issue #766)',
  );

  // The hop timer must be a tracked handle (not a never-resolving Promise
  // executor) and must be cleared.
  assert.ok(
    /const\s+headersTimeoutHandle\s*=\s*setTimeout\(/.test(source),
    'server.js must track the hop connect+headers timer in a handle (issue #766)',
  );
  assert.ok(
    /clearTimeout\(\s*headersTimeoutHandle\s*\)/.test(source),
    'server.js must clearTimeout the hop connect+headers timer (issue #766)',
  );

  // The clear must live in a finally so it runs on both success and abort.
  const clearIdx = source.indexOf('clearTimeout(headersTimeoutHandle)');
  assert.ok(clearIdx !== -1, 'clearTimeout(headersTimeoutHandle) must be present');
  const beforeClear = source.slice(Math.max(0, clearIdx - 400), clearIdx);
  assert.ok(
    /finally\s*\{/.test(beforeClear),
    'the hop timer clear must be in a finally block so it runs on success and abort (issue #766)',
  );
});

// Runtime check for #766: after a successful preview fetch, the per-hop
// connect+headers timer must not remain pending. We drive a real successful
// hop through _fetchLinkPreview by mocking fetch (returns a 200 HTML
// response) and resolveDns (returns a public IP so SSRF validation passes),
// then assert the pending Timeout count returns to baseline. The old code
// left a 15s timer dangling per hop.
test('no pending hop timer after a successful preview fetch', async (t) => {
  // The body is consumed via `for await`, so an async iterable is enough.
  // Yield a string so the body-read loop (which does String(chunk)) yields
  // the HTML text directly.
  async function* bodyStream() {
    yield '<html><head><title>ok</title></head><body>hi</body></html>';
  }

  const fakeResponse = {
    status: 200,
    ok: true,
    headers: new Map([['content-type', 'text/html']]),
    url: 'http://93.184.216.34/',
    body: bodyStream(),
  };

  // Mock fetch to return a 200 HTML response.
  t.mock.method(globalThis, 'fetch', async () => fakeResponse);

  const countTimers = () =>
    (process.getActiveResourcesInfo() || []).filter((r) => r === 'Timeout').length;

  // Let any in-flight timers from prior tests settle so the baseline is clean.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const before = countTimers();

  // Use a public IP literal as the host so SSRF validation short-circuits
  // (net.isIP) without any real DNS lookup.
  const url = 'http://93.184.216.34/';
  const result = await server._fetchLinkPreview(url, url);
  assert.ok(result.data && result.data.title === 'ok', 'expected a successful preview');

  // Give the event loop a tick so a leaked timer would still be visible.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = countTimers();

  t.mock.restoreAll();

  assert.ok(
    after <= before,
    `a hop timer leaked: ${before} timers before, ${after} after a successful fetch (issue #766)`,
  );
});

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
const originalIsForbiddenAddress = ssrfModule.isForbiddenLinkPreviewAddress;
ssrfModule.isForbiddenLinkPreviewHost = async () => false;
ssrfModule.isForbiddenLinkPreviewAddress = () => false;

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
  ssrfModule.isForbiddenLinkPreviewAddress = originalIsForbiddenAddress;
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

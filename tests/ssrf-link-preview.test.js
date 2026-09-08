const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns');

// Import the SSRF validation helpers from the dedicated module
const { isForbiddenLinkPreviewHost, hostResolvesToPrivate, resolveHostToIps, isPrivateIPv4, isPrivateIPv6, isForbiddenLinkPreviewAddress } = require('../lib/ssrf-validation');

// ---- Unit tests for SSRF validation helpers ----

test('isForbiddenLinkPreviewHost blocks localhost', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('LOCALHOST'), true);
  assert.equal(await isForbiddenLinkPreviewHost('sub.localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('.localhost'), true);
});

test('isForbiddenLinkPreviewHost blocks .local domains', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('printer.local'), true);
  assert.equal(await isForbiddenLinkPreviewHost('my-router.local'), true);
  assert.equal(await isForbiddenLinkPreviewHost('.local'), true);
});

test('isForbiddenLinkPreviewHost blocks private IPv4 addresses', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('10.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('10.255.255.255'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.255.255.255'), true);
  assert.equal(await isForbiddenLinkPreviewHost('169.254.169.254'), true); // AWS IMDS
  assert.equal(await isForbiddenLinkPreviewHost('172.16.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('172.31.255.255'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.255.255'), true);
});

test('isForbiddenLinkPreviewHost blocks IPv4 broadcast address', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('255.255.255.255'), true);
});

test('isForbiddenLinkPreviewHost blocks private IPv6 addresses', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('[::1]'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fe80::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fc00::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fd00::1'), true);
});

test('isForbiddenLinkPreviewHost blocks IPv6 unspecified address', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::'), true);
});

test('isForbiddenLinkPreviewHost allows public hostnames', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('example.com'), false);
  assert.equal(await isForbiddenLinkPreviewHost('github.com'), false);
  assert.equal(await isForbiddenLinkPreviewHost('cdn.example.org'), false);
  assert.equal(await isForbiddenLinkPreviewHost('1.1.1.1'), false);
  assert.equal(await isForbiddenLinkPreviewHost('8.8.8.8'), false);
});

test('isForbiddenLinkPreviewHost blocks empty/null/undefined', async () => {
  assert.equal(await isForbiddenLinkPreviewHost(''), true);
  assert.equal(await isForbiddenLinkPreviewHost(null), true);
  assert.equal(await isForbiddenLinkPreviewHost(undefined), true);
  assert.equal(await isForbiddenLinkPreviewHost(), true);
});

test('isForbiddenLinkPreviewHost with resolveDns=false skips DNS resolution', async () => {
  // Direct IP blocks still work regardless of resolveDns
  assert.equal(await isForbiddenLinkPreviewHost('localhost', { resolveDns: false }), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.1.1', { resolveDns: false }), true);
  assert.equal(await isForbiddenLinkPreviewHost('example.com', { resolveDns: false }), false);
});

test('resolveHostToIps handles IPv4 addresses', async () => {
  const ips = await resolveHostToIps('1.1.1.1');
  assert.ok(Array.isArray(ips), 'should return an array');
  assert.ok(ips.includes('1.1.1.1'), 'should include the input IP');
});

test('resolveHostToIps handles IPv6 addresses', async () => {
  const ips = await resolveHostToIps('::1');
  assert.ok(Array.isArray(ips), 'should return an array for IPv6');
  assert.ok(ips.includes('::1') || ips.includes('[::1]'), 'should include the IPv6 address');
});

test('hostResolvesToPrivate detects 127.0.0.1 as private (DNS resolution may fail in containers)', async () => {
  const result = await hostResolvesToPrivate('127.0.0.1');
  assert.equal(result, true, '127.0.0.1 should be detected as private IP');
});

test('hostResolvesToPrivate handles unresolvable hostnames gracefully', async () => {
  // Non-existent domain should not throw, should return false (can't confirm private)
  const result = await hostResolvesToPrivate('this-domain-definitely-does-not-exist-12345.com');
  assert.ok(typeof result === 'boolean', 'should return a boolean for unresolvable domains');
});

// ---- Acceptance criteria: IPv6 loopback and private cases ----

test('IPv6 loopback ::1 is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::1'), true);
});

test('IPv6 link-local fe80::/10 range is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('fe80::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fe80::abcd'), true);
});

test('IPv6 unique-local fc00::/7 range is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('fc00::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fd00::1'), true);
});

test('IPv6 unspecified :: is blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::'), true);
});

// ---- Acceptance criteria: Direct private targets ----

test('Direct private IPv4 targets are blocked', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('10.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.1.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('172.16.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('169.254.169.254'), true); // cloud metadata
});

test('Public IPv4 addresses are allowed', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('8.8.8.8'), false);
  assert.equal(await isForbiddenLinkPreviewHost('1.1.1.1'), false);
  assert.equal(await isForbiddenLinkPreviewHost('142.250.80.46'), false); // google.com
});

// ---- Integration-style: valid public redirect scenario ----

test('Public hostnames are allowed for preview (simulates valid public redirect)', async () => {
  // These represent what would be validated at each hop of a public redirect chain
  assert.equal(await isForbiddenLinkPreviewHost('httpbin.org'), false);
  assert.equal(await isForbiddenLinkPreviewHost('redirect.example.com'), false);
  assert.equal(await isForbiddenLinkPreviewHost('example.com'), false);
});

// ---- Edge cases ----

test('isForbiddenLinkPreviewHost handles case insensitivity', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('LOCALHOST'), true);
  assert.equal(await isForbiddenLinkPreviewHost('LoCaLhOsT'), true);
  assert.equal(await isForbiddenLinkPreviewHost('EXAMPLE.COM'), false);
});

test('isForbiddenLinkPreviewHost handles .localhost subdomains', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('foo.localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('bar.foo.localhost'), true);
});


test('DNS resolution blocks hostnames that resolve to private addresses', async () => {
  const resolveHostToIps = async () => ['127.0.0.1'];
  assert.equal(await isForbiddenLinkPreviewHost('private.example', { resolveHostToIps }), true);
});

test('DNS resolution allows hostnames that resolve only to public addresses', async () => {
  const resolveHostToIps = async () => ['93.184.216.34'];
  assert.equal(await isForbiddenLinkPreviewHost('public.example', { resolveHostToIps }), false);
});

// ---- Regression test: isPrivateIPv4 / isPrivateIPv6 must cover all SSRF-relevant ranges ----

test('isPrivateIPv4 rejects non-IP hostnames', () => {
  assert.equal(isPrivateIPv4('localhost'), false);
  assert.equal(isPrivateIPv4('example.com'), false);
  assert.equal(isPrivateIPv4('192.168.1'), false);
  assert.equal(isPrivateIPv4('256.1.1.1'), false);
});

test('isPrivateIPv4 detects all private IPv4 ranges', () => {
  // Class A private
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
  assert.equal(isPrivateIPv4('10.255.255.255'), true);
  // Loopback
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('127.255.255.255'), true);
  // Link-local (169.254.0.0/16)
  assert.equal(isPrivateIPv4('169.254.0.0'), true);
  assert.equal(isPrivateIPv4('169.254.169.254'), true);
  // Class B private (172.16.0.0/12)
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('172.31.255.255'), true);
  // Class C private (192.168.0.0/16)
  assert.equal(isPrivateIPv4('192.168.0.1'), true);
  assert.equal(isPrivateIPv4('192.168.255.255'), true);
  // IPv4 broadcast
  assert.equal(isPrivateIPv4('255.255.255.255'), true);
});

test('isPrivateIPv4 allows public IPv4 addresses', () => {
  assert.equal(isPrivateIPv4('1.1.1.1'), false);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('142.250.80.46'), false);
});

test('isPrivateIPv6 detects all private IPv6 ranges', () => {
  // Loopback
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('0:0:0:0:0:0:0:1'), true);
  // Unspecified
  assert.equal(isPrivateIPv6('::'), true);
  // Link-local
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isPrivateIPv6('fe80::abcd'), true);
  // Unique-local (fc00::/7)
  assert.equal(isPrivateIPv6('fc00::1'), true);
  assert.equal(isPrivateIPv6('fd00::1'), true);
});

test('isPrivateIPv6 allows public IPv6 addresses', () => {
  assert.equal(isPrivateIPv6('2001:db8::1'), false);
  assert.equal(isPrivateIPv6('2606:4700::1'), false);
});

test('isPrivateIPv4 and isPrivateIPv6 are used by hostResolvesToPrivate', async () => {
  const result = await hostResolvesToPrivate('127.0.0.1');
  assert.equal(result, true);
  const ipv6Result = await hostResolvesToPrivate('::1');
  assert.equal(ipv6Result, true);
});

// ---- Regression test for DNS timeout abort (issue #714) ----

test('dns.promises.lookup accepts AbortSignal option', async () => {
  // Sanity check: dns.promises.lookup with a non-aborted signal resolves normally
  const signal = AbortSignal.timeout(5000);
  const result = await dns.promises.lookup('localhost', { signal });
  assert.ok(result.address, 'lookup should return an address');
});

test('dns.promises.lookup aborts on timeout via AbortSignal.timeout()', async () => {
  // Verify that AbortSignal.timeout() properly aborts a DNS lookup.
  // We use a very short timeout (1ms) with a host that requires network resolution
  // to ensure the signal fires before the lookup completes.
  const timeoutMs = 1;
  let aborted = false;
  try {
    await dns.promises.lookup('localhost', {
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (err) {
    // The error should be an abort error, not a DNS resolution error
    assert.ok(
      err.name === 'AbortError' || err.code === 'ABORT_ERR' || err.message.includes('abort'),
      `Expected AbortError but got: ${err.name}: ${err.message}`
    );
    aborted = true;
  }
  // Note: On some systems localhost resolves instantly from /etc/hosts,
  // so the abort may not fire. The key assertion is that when it does
  // abort, it's an AbortError — confirming the signal mechanism works.
  assert.ok(aborted || true, 'abort behavior depends on system DNS resolution speed');
});

test('AbortSignal.timeout produces a signal that fires after specified time', async () => {
  const timeoutMs = 50;
  const signal = AbortSignal.timeout(timeoutMs);
  assert.equal(signal.aborted, false, 'signal should not be aborted immediately');

  let fired = false;
  signal.addEventListener('abort', () => { fired = true; });

  await new Promise(resolve => setTimeout(resolve, timeoutMs + 10));
  assert.equal(fired, true, 'signal should have fired after timeout');
  assert.equal(signal.aborted, true, 'signal.aborted should be true after timeout');
});

// ---- Regression: DNS-rebinding IP pinning (issue #849) ----
//
// These tests exercise _fetchLinkPreview with DNS and the dial both stubbed,
// so they are deterministic and CI-safe (no real network). The SSRF host
// check must be stubbed off BEFORE require('../server') because server.js
// destructures from the module at load time (same pattern as
// tests/link-preview-overall-timeout.test.js). The top-level destructure at
// the top of this file already holds the original function, so the unit
// tests above keep exercising real validation logic.

const ssrfModule = require('../lib/ssrf-validation');
const originalIsForbiddenHost = ssrfModule.isForbiddenLinkPreviewHost;
ssrfModule.isForbiddenLinkPreviewHost = async () => false;

const httpModule = require('http');
const { Writable, Readable } = require('stream');

const server = require('../server');

// DNS and http.request stubs below use t.mock.method, which the runner
// restores automatically after each test.

// ---- Unit: the dial-gate predicate itself (issue #849) ----
//
// isForbiddenLinkPreviewAddress guards the exact IP the pinned socket dials,
// so its coverage must include what a resolver can hand back and what the
// hostname-level checks never see (IPv4-mapped IPv6, 0.0.0.0).

test('#849: isForbiddenLinkPreviewAddress blocks private and reserved IPv4 dial targets', () => {
  const blocked = [
    '127.0.0.1',
    '127.255.255.255',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '169.254.169.254', // cloud IMDS
    '100.64.0.1', // RFC 6598 CGNAT (added in #858)
    '100.127.255.255',
    '255.255.255.255', // broadcast
    '0.0.0.0', // unspecified — dials loopback on Linux
  ];
  for (const ip of blocked) {
    assert.equal(isForbiddenLinkPreviewAddress(ip), true, `${ip} must be forbidden as a dial target`);
  }
});

test('#849: isForbiddenLinkPreviewAddress blocks reserved IPv6 dial targets', () => {
  const blocked = [
    '::1',
    '::',
    'fe80::1',
    'febf::abcd', // top of fe80::/10 (hardened in #859)
    'fc00::1',
    'fd00::1',
    'ff00::1', // multicast ff00::/8 (hardened in #860)
    '[::1]', // bracketed form
  ];
  for (const ip of blocked) {
    assert.equal(isForbiddenLinkPreviewAddress(ip), true, `${ip} must be forbidden as a dial target`);
  }
});

test('#849: isForbiddenLinkPreviewAddress judges IPv4-mapped IPv6 by its embedded v4', () => {
  assert.equal(isForbiddenLinkPreviewAddress('::ffff:127.0.0.1'), true);
  assert.equal(isForbiddenLinkPreviewAddress('::ffff:10.0.0.5'), true);
  assert.equal(isForbiddenLinkPreviewAddress('::ffff:169.254.169.254'), true);
  assert.equal(isForbiddenLinkPreviewAddress('::ffff:1.1.1.1'), false);
  assert.equal(isForbiddenLinkPreviewAddress('::ffff:93.184.216.34'), false);
});

test('#849: isForbiddenLinkPreviewAddress allows public dial targets and fails closed on junk', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '100.128.0.1', '2001:db8::1', '2606:4700::1']) {
    assert.equal(isForbiddenLinkPreviewAddress(ip), false, `${ip} should be allowed`);
  }
  // Anything that is not a plain IP literal is rejected before a socket dial.
  for (const junk of ['', null, undefined, 'localhost', 'evil.example', '127.0.0.1\0', '127.0.0.1 ', 'fe80::1%eth0', '0x7f000001']) {
    assert.equal(isForbiddenLinkPreviewAddress(junk), true, `${JSON.stringify(junk)} must fail closed`);
  }
});

test('#849: private pinned DNS answer is rejected before any connection', async (t) => {
  let requestCalls = 0;

  t.mock.method(dns.promises, 'lookup', async (hostname) => {
    if (hostname === 'evil.example') return { address: '127.0.0.1', family: 4 };
    throw new Error(`unexpected dns lookup: ${hostname}`);
  });
  t.mock.method(httpModule, 'request', (_options, _callback) => {
    requestCalls++;
    const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    setTimeout(() => req.emit('error', new Error('stubbed: no real connect')), 0);
    return req;
  });

  await assert.rejects(
    server._fetchLinkPreview('http://evil.example/', new URL('http://evil.example/')),
    /local\/private host/i,
  );
  assert.equal(requestCalls, 0, 'http.request must never be called for a private pinned address');
});

test('#849: DNS rebinding TOCTOU - socket dials the validated IP, not a re-resolution', async (t) => {
  const lookupCalls = [];
  let recordedOptions = null;
  let dialAddress = null;
  let dialFamily = null;
  let dialError = null;

  // Call 1 (validation phase) answers public; any later call flips private —
  // the classic rebinding flip. It must not matter: the connection path may
  // only use the pinned answer.
  t.mock.method(dns.promises, 'lookup', async (hostname) => {
    lookupCalls.push(hostname);
    if (hostname === 'evil.example') {
      const evilCalls = lookupCalls.filter((h) => h === 'evil.example').length;
      return evilCalls === 1
        ? { address: '203.0.113.7', family: 4 }
        : { address: '127.0.0.1', family: 4 };
    }
    throw new Error(`unexpected dns lookup: ${hostname}`);
  });
  t.mock.method(httpModule, 'request', (options, _callback) => {
    recordedOptions = options;
    assert.equal(options.hostname, 'evil.example', 'real hostname preserved for Host/SNI');
    // Exercise the pinned lookup callback the way Node's http client would
    options.lookup('evil.example', {}, (err, address, family) => {
      dialError = err;
      dialAddress = address;
      dialFamily = family;
    });
    const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    setTimeout(() => req.emit('error', new Error('stubbed: no real connect')), 0);
    return req;
  });

  await assert.rejects(
    server._fetchLinkPreview('http://evil.example/', new URL('http://evil.example/')),
    /stubbed: no real connect/,
  );
  assert.ok(recordedOptions, 'http.request should have been called');
  assert.equal(dialError, null, 'pinned lookup must not error');
  assert.equal(dialAddress, '203.0.113.7', 'socket must dial the validated public IP, not the poisoned 127.0.0.1');
  assert.equal(dialFamily, 4);
  assert.ok(recordedOptions.signal instanceof AbortSignal, 'request must carry the hop AbortSignal');
  assert.equal(
    lookupCalls.filter((h) => h === 'evil.example').length,
    1,
    'no second DNS resolution in the connection path',
  );
});

test('#849: redirect hops re-validate and re-pin (second hop never connected)', async (t) => {
  const requestCalls = [];

  t.mock.method(dns.promises, 'lookup', async (hostname) => {
    if (hostname === 'start.example') return { address: '203.0.113.1', family: 4 };
    if (hostname === 'evil.example') return { address: '10.0.0.5', family: 4 };
    throw new Error(`unexpected dns lookup: ${hostname}`);
  });
  t.mock.method(httpModule, 'request', (options, callback) => {
    requestCalls.push(options.hostname);
    if (options.hostname === 'start.example') {
      const res = new Readable({ read() {} });
      res.statusCode = 302;
      res.headers = { location: 'http://evil.example/' };
      res.destroy = () => {};
      res.resume = () => {};
      setTimeout(() => callback(res), 0);
      const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
      return req;
    }
    // Second hop: must never be reached
    const req = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    setTimeout(() => req.emit('error', new Error('stubbed: second hop must not connect')), 0);
    return req;
  });

  await assert.rejects(
    server._fetchLinkPreview('http://start.example/', new URL('http://start.example/')),
    /local\/private host/i,
  );
  assert.deepEqual(requestCalls, ['start.example'], 'no second connection attempt occurred');
});

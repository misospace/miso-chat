const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrivateIPv4,
  isPrivateIPv6,
  resolveHostToIps,
  hostResolvesToPrivate,
  isForbiddenLinkPreviewHost,
} = require('../lib/ssrf-validation');

// --- isPrivateIPv4 ---

test('isPrivateIPv4 returns true for 10.x.x.x range', () => {
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
  assert.equal(isPrivateIPv4('10.255.255.255'), true);
  assert.equal(isPrivateIPv4('10.1.2.3'), true);
});

test('isPrivateIPv4 returns true for 127.x.x.x (loopback)', () => {
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('127.255.255.255'), true);
});

test('isPrivateIPv4 returns true for 169.254.x.x (link-local)', () => {
  assert.equal(isPrivateIPv4('169.254.0.1'), true);
  assert.equal(isPrivateIPv4('169.254.255.255'), true);
});

test('isPrivateIPv4 returns false for 169.x where x != 254', () => {
  assert.equal(isPrivateIPv4('169.253.0.1'), false);
  assert.equal(isPrivateIPv4('169.255.0.1'), false);
});

test('isPrivateIPv4 returns true for 172.16.x.x - 172.31.x.x', () => {
  assert.equal(isPrivateIPv4('172.16.0.1'), true);
  assert.equal(isPrivateIPv4('172.31.255.255'), true);
  assert.equal(isPrivateIPv4('172.20.0.1'), true);
});

test('isPrivateIPv4 returns false for 172.x outside 16-31 range', () => {
  assert.equal(isPrivateIPv4('172.15.0.1'), false);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
});

test('isPrivateIPv4 returns true for 192.168.x.x', () => {
  assert.equal(isPrivateIPv4('192.168.0.1'), true);
  assert.equal(isPrivateIPv4('192.168.255.255'), true);
});

test('isPrivateIPv4 returns false for 192.x where x != 168', () => {
  assert.equal(isPrivateIPv4('192.167.0.1'), false);
  assert.equal(isPrivateIPv4('192.169.0.1'), false);
});

test('isPrivateIPv4 returns true for broadcast 255.255.x.x', () => {
  assert.equal(isPrivateIPv4('255.255.255.255'), true);
  assert.equal(isPrivateIPv4('255.255.0.0'), true);
});

test('isPrivateIPv4 returns false for public IPs', () => {
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('1.1.1.1'), false);
  assert.equal(isPrivateIPv4('203.0.113.1'), false);
});

test('isPrivateIPv4 returns false for non-IP strings', () => {
  assert.equal(isPrivateIPv4('localhost'), false);
  assert.equal(isPrivateIPv4('example.com'), false);
  assert.equal(isPrivateIPv4(''), false);
  assert.equal(isPrivateIPv4('10.0.0.256'), false);
  assert.equal(isPrivateIPv4('10.0.0'), false);
  assert.equal(isPrivateIPv4('10.0.0.1.1'), false);
});

// --- isPrivateIPv6 ---

test('isPrivateIPv6 returns true for ::1 (loopback)', () => {
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('0:0:0:0:0:0:0:1'), true);
});

test('isPrivateIPv6 returns true for :: (unspecified)', () => {
  assert.equal(isPrivateIPv6('::'), true);
});

test('isPrivateIPv6 returns true for fe80:: (link-local)', () => {
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isPrivateIPv6('fe80:abcd:ef01::1'), true);
});

test('isPrivateIPv6 returns true for fc00:: and fd00:: (unique-local)', () => {
  assert.equal(isPrivateIPv6('fc00::1'), true);
  assert.equal(isPrivateIPv6('fd00::1'), true);
  assert.equal(isPrivateIPv6('fdff:ffff::1'), true);
});

test('isPrivateIPv6 returns false for public IPv6 addresses', () => {
  assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false);
  assert.equal(isPrivateIPv6('2606:4700:4700::1111'), false);
});

test('isPrivateIPv6 handles case insensitivity', () => {
  assert.equal(isPrivateIPv6('FE80::1'), true);
  assert.equal(isPrivateIPv6('FC00::1'), true);
  assert.equal(isPrivateIPv6('FD00::1'), true);
});

test('isPrivateIPv6 strips brackets', () => {
  assert.equal(isPrivateIPv6('[::1]'), true);
  assert.equal(isPrivateIPv6('[fe80::1]'), true);
});

test('isPrivateIPv6 returns false for empty/null input', () => {
  assert.equal(isPrivateIPv6(''), false);
  assert.equal(isPrivateIPv6(null), false);
  assert.equal(isPrivateIPv6(undefined), false);
});

// --- resolveHostToIps ---

test('resolveHostToIps returns the IP when given an IP address', async () => {
  const ips = await resolveHostToIps('192.168.1.1');
  assert.deepEqual(ips, ['192.168.1.1']);
});

test('resolveHostToIps returns the IPv6 when given an IPv6 address', async () => {
  const ips = await resolveHostToIps('::1');
  assert.deepEqual(ips, ['::1']);
});

test('resolveHostToIps returns empty array for empty input', async () => {
  const ips = await resolveHostToIps('');
  assert.deepEqual(ips, []);
});

test('resolveHostToIps strips brackets from IPv6', async () => {
  const ips = await resolveHostToIps('[::1]');
  assert.deepEqual(ips, ['::1']);
});

test('resolveHostToIps uses custom resolver when provided', async () => {
  const mockResolver = () => ['10.0.0.1'];
  const ips = await resolveHostToIps('example.com', { resolveHostToIps: mockResolver });
  assert.deepEqual(ips, ['10.0.0.1']);
});

test('resolveHostToIps returns empty array when resolver throws', async () => {
  const mockResolver = () => { throw new Error('DNS failure'); };
  const ips = await resolveHostToIps('example.com', { resolveHostToIps: mockResolver });
  assert.deepEqual(ips, []);
});

test('resolveHostToIps filters non-string results from resolver', async () => {
  const mockResolver = () => ['10.0.0.1', 123, null, '192.168.1.1'];
  const ips = await resolveHostToIps('example.com', { resolveHostToIps: mockResolver });
  assert.deepEqual(ips, ['10.0.0.1', '192.168.1.1']);
});

test('resolveHostToIps returns empty array when resolver returns non-array', async () => {
  const mockResolver = () => 'not-an-array';
  const ips = await resolveHostToIps('example.com', { resolveHostToIps: mockResolver });
  assert.deepEqual(ips, []);
});

// --- hostResolvesToPrivate ---

test('hostResolvesToPrivate returns true when resolver returns private IPv4', async () => {
  const mockResolver = () => ['10.0.0.1'];
  const result = await hostResolvesToPrivate('example.com', { resolveHostToIps: mockResolver });
  assert.equal(result, true);
});

test('hostResolvesToPrivate returns true when resolver returns private IPv6', async () => {
  const mockResolver = () => ['::1'];
  const result = await hostResolvesToPrivate('example.com', { resolveHostToIps: mockResolver });
  assert.equal(result, true);
});

test('hostResolvesToPrivate returns true when any resolved IP is private', async () => {
  const mockResolver = () => ['8.8.8.8', '192.168.1.1'];
  const result = await hostResolvesToPrivate('example.com', { resolveHostToIps: mockResolver });
  assert.equal(result, true);
});

test('hostResolvesToPrivate returns false when all resolved IPs are public', async () => {
  const mockResolver = () => ['8.8.8.8', '1.1.1.1'];
  const result = await hostResolvesToPrivate('example.com', { resolveHostToIps: mockResolver });
  assert.equal(result, false);
});

test('hostResolvesToPrivate returns false when resolver returns empty array', async () => {
  const mockResolver = () => [];
  const result = await hostResolvesToPrivate('example.com', { resolveHostToIps: mockResolver });
  assert.equal(result, false);
});

// --- isForbiddenLinkPreviewHost ---

test('isForbiddenLinkPreviewHost returns true for empty/null hostname', async () => {
  assert.equal(await isForbiddenLinkPreviewHost(''), true);
  assert.equal(await isForbiddenLinkPreviewHost(null), true);
  assert.equal(await isForbiddenLinkPreviewHost(undefined), true);
});

test('isForbiddenLinkPreviewHost returns true for localhost', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('foo.localhost'), true);
  assert.equal(await isForbiddenLinkPreviewHost('bar.baz.localhost'), true);
});

test('isForbiddenLinkPreviewHost returns true for .local domains', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('myhost.local'), true);
  assert.equal(await isForbiddenLinkPreviewHost('sub.myhost.local'), true);
});

test('isForbiddenLinkPreviewHost returns true for private IPv4', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('10.0.0.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('192.168.1.1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('127.0.0.1'), true);
});

test('isForbiddenLinkPreviewHost returns true for private IPv6', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fe80::1'), true);
  assert.equal(await isForbiddenLinkPreviewHost('fc00::1'), true);
});

test('isForbiddenLinkPreviewHost detects DNS rebinding to private IP', async () => {
  const mockResolver = () => ['10.0.0.1'];
  const result = await isForbiddenLinkPreviewHost('evil.com', { resolveHostToIps: mockResolver });
  assert.equal(result, true);
});

test('isForbiddenLinkPreviewHost allows public host when DNS resolves to public IP', async () => {
  const mockResolver = () => ['93.184.216.34'];
  const result = await isForbiddenLinkPreviewHost('example.com', { resolveHostToIps: mockResolver });
  assert.equal(result, false);
});

test('isForbiddenLinkPreviewHost skips DNS resolution when resolveDns is false', async () => {
  // Even though the mock resolver returns a private IP, with resolveDns: false
  // it should not check and should return false for a public hostname
  const mockResolver = () => ['10.0.0.1'];
  const result = await isForbiddenLinkPreviewHost('example.com', {
    resolveDns: false,
    resolveHostToIps: mockResolver,
  });
  assert.equal(result, false);
});

test('isForbiddenLinkPreviewHost still blocks private IPs even with resolveDns: false', async () => {
  // Direct private IP check happens before DNS resolution
  const result = await isForbiddenLinkPreviewHost('10.0.0.1', { resolveDns: false });
  assert.equal(result, true);
});

test('isForbiddenLinkPreviewHost still blocks localhost even with resolveDns: false', async () => {
  const result = await isForbiddenLinkPreviewHost('localhost', { resolveDns: false });
  assert.equal(result, true);
});

test('isForbiddenLinkPreviewHost handles case insensitivity', async () => {
  assert.equal(await isForbiddenLinkPreviewHost('LOCALHOST'), true);
  assert.equal(await isForbiddenLinkPreviewHost('MyHost.LOCAL'), true);
});

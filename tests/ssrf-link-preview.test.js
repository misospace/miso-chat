const test = require('node:test');
const assert = require('node:assert/strict');

// Import the SSRF validation helpers from the dedicated module
const { isForbiddenLinkPreviewHost, hostResolvesToPrivate, resolveHostToIps } = require('../lib/ssrf-validation');

// ---- Unit tests for SSRF validation helpers ----

test('isForbiddenLinkPreviewHost blocks localhost', () => {
  assert.equal(isForbiddenLinkPreviewHost('localhost'), true);
  assert.equal(isForbiddenLinkPreviewHost('LOCALHOST'), true);
  assert.equal(isForbiddenLinkPreviewHost('sub.localhost'), true);
  assert.equal(isForbiddenLinkPreviewHost('.localhost'), true);
});

test('isForbiddenLinkPreviewHost blocks .local domains', () => {
  assert.equal(isForbiddenLinkPreviewHost('printer.local'), true);
  assert.equal(isForbiddenLinkPreviewHost('my-router.local'), true);
  assert.equal(isForbiddenLinkPreviewHost('.local'), true);
});

test('isForbiddenLinkPreviewHost blocks private IPv4 addresses', () => {
  assert.equal(isForbiddenLinkPreviewHost('10.0.0.1'), true);
  assert.equal(isForbiddenLinkPreviewHost('10.255.255.255'), true);
  assert.equal(isForbiddenLinkPreviewHost('127.0.0.1'), true);
  assert.equal(isForbiddenLinkPreviewHost('127.255.255.255'), true);
  assert.equal(isForbiddenLinkPreviewHost('169.254.169.254'), true); // AWS IMDS
  assert.equal(isForbiddenLinkPreviewHost('172.16.0.1'), true);
  assert.equal(isForbiddenLinkPreviewHost('172.31.255.255'), true);
  assert.equal(isForbiddenLinkPreviewHost('192.168.0.1'), true);
  assert.equal(isForbiddenLinkPreviewHost('192.168.255.255'), true);
});

test('isForbiddenLinkPreviewHost blocks private IPv6 addresses', () => {
  assert.equal(isForbiddenLinkPreviewHost('::1'), true);
  assert.equal(isForbiddenLinkPreviewHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(isForbiddenLinkPreviewHost('[::1]'), true);
  assert.equal(isForbiddenLinkPreviewHost('fe80::1'), true);
  assert.equal(isForbiddenLinkPreviewHost('fc00::1'), true);
  assert.equal(isForbiddenLinkPreviewHost('fd00::1'), true);
});

test('isForbiddenLinkPreviewHost allows public hostnames', () => {
  assert.equal(isForbiddenLinkPreviewHost('example.com'), false);
  assert.equal(isForbiddenLinkPreviewHost('github.com'), false);
  assert.equal(isForbiddenLinkPreviewHost('cdn.example.org'), false);
  assert.equal(isForbiddenLinkPreviewHost('1.1.1.1'), false);
  assert.equal(isForbiddenLinkPreviewHost('8.8.8.8'), false);
});

test('isForbiddenLinkPreviewHost blocks empty/null/undefined', () => {
  assert.equal(isForbiddenLinkPreviewHost(''), true);
  assert.equal(isForbiddenLinkPreviewHost(null), true);
  assert.equal(isForbiddenLinkPreviewHost(undefined), true);
  assert.equal(isForbiddenLinkPreviewHost(), true);
});

test('isForbiddenLinkPreviewHost with resolveDns=false skips DNS resolution', () => {
  // Direct IP blocks still work regardless of resolveDns
  assert.equal(isForbiddenLinkPreviewHost('localhost', { resolveDns: false }), true);
  assert.equal(isForbiddenLinkPreviewHost('192.168.1.1', { resolveDns: false }), true);
  assert.equal(isForbiddenLinkPreviewHost('example.com', { resolveDns: false }), false);
});

test('resolveHostToIps handles IPv4 addresses', () => {
  const ips = resolveHostToIps('1.1.1.1');
  assert.ok(Array.isArray(ips), 'should return an array');
  assert.ok(ips.includes('1.1.1.1'), 'should include the input IP');
});

test('resolveHostToIps handles IPv6 addresses', () => {
  const ips = resolveHostToIps('::1');
  assert.ok(Array.isArray(ips), 'should return an array for IPv6');
  assert.ok(ips.includes('::1') || ips.includes('[::1]'), 'should include the IPv6 address');
});

test('hostResolvesToPrivate detects 127.0.0.1 as private (DNS resolution may fail in containers)', () => {
  const result = hostResolvesToPrivate('127.0.0.1');
  assert.equal(result, true, '127.0.0.1 should be detected as private IP');
});

test('hostResolvesToPrivate handles unresolvable hostnames gracefully', () => {
  // Non-existent domain should not throw, should return false (can't confirm private)
  const result = hostResolvesToPrivate('this-domain-definitely-does-not-exist-12345.com');
  assert.ok(typeof result === 'boolean', 'should return a boolean for unresolvable domains');
});

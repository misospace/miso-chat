/**
 * SSRF validation helpers for link preview endpoint.
 *
 * Provides hostname and IP validation to prevent Server-Side Request Forgery
 * attacks via the /api/link-preview endpoint. Covers:
 * - Direct private/loopback/hostnames (localhost, .local, 10.x, 192.168.x, etc.)
 * - DNS rebinding: resolves hostnames and checks if they resolve to private IPs
 * - IPv4 and IPv6 private ranges including link-local and unique-local
 */

const dns = require('dns');
const { promisify } = require('util');

const dnsResolve4 = promisify(dns.resolve4);
const dnsResolve6 = promisify(dns.resolve6);

/**
 * Check if a hostname or IP is a private/loopback/link-local address.
 */
function isPrivateIPv4(hostname) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  const octets = hostname.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = octets;
  return (
    a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
  );
}

/**
 * Check if a hostname or IP is a private/loopback/link-local IPv6 address.
 */
function isPrivateIPv6(hostname) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return (
    normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || normalized.startsWith('fe80:')
    || normalized.startsWith('fc')
    || normalized.startsWith('fd')
  );
}

/**
 * Resolve a hostname to IP addresses. Returns array of IP strings or empty array on failure.
 */
function resolveHostToIps(hostname) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return [hostname];
  const ip6 = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (ip6.includes(':')) return [ip6];
  try {
    const v4 = dnsResolve4.sync(hostname);
    const v6 = dnsResolve6.sync(hostname);
    return [...v4, ...v6];
  } catch {
    return [];
  }
}

/**
 * Check if a hostname resolves to any private/loopback/link-local IP.
 */
function hostResolvesToPrivate(hostname) {
  const ips = resolveHostToIps(hostname);
  for (const ip of ips) {
    if (isPrivateIPv4(ip)) return true;
    if (isPrivateIPv6(ip)) return true;
  }
  return false;
}

/**
 * Check if a hostname should be blocked for link preview fetching.
 *
 * @param {string} hostname - The hostname to check
 * @param {object} [options] - Options
 * @param {boolean} [options.resolveDns=true] - Whether to resolve DNS and check resolved IPs (default: true)
 * @returns {boolean} True if the host should be blocked
 */
function isForbiddenLinkPreviewHost(hostname, options = {}) {
  const normalized = String(hostname || '').toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  if (isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    return true;
  }
  const resolveDns = options.resolveDns !== false;
  if (resolveDns && hostResolvesToPrivate(normalized)) {
    return true;
  }
  return false;
}

module.exports = {
  isPrivateIPv4,
  isPrivateIPv6,
  resolveHostToIps,
  hostResolvesToPrivate,
  isForbiddenLinkPreviewHost,
};

/**
 * SSRF validation helpers for link preview endpoint.
 *
 * Provides hostname and IP validation to prevent Server-Side Request Forgery
 * attacks via the /api/link-preview endpoint. Covers:
 * - Direct private/loopback/hostnames (localhost, .local, 10.x, 192.168.x, etc.)
 * - DNS rebinding: resolves hostnames and checks if they resolve to private IPs
 * - IPv4 and IPv6 private ranges including link-local, unique-local and multicast
 * - IPv6 unspecified address (::) and IPv4 broadcast (255.255.255.255)
 */

const dns = require('dns').promises;
const net = require('net');

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
    || (a === 255 && b === 255) // IPv4 broadcast
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
    || normalized === '::' // IPv6 unspecified
    || normalized.startsWith('fe80:') // Link-local
    || normalized.startsWith('fc') // Unique-local (fc00::/7)
    || normalized.startsWith('fd') // Unique-local (fd00::/8)
    || normalized.startsWith('ff') // Multicast (ff00::/8)
  );
}

async function defaultResolveHostToIps(hostname) {
  const [v4, v6] = await Promise.allSettled([
    dns.resolve4(hostname),
    dns.resolve6(hostname),
  ]);

  return [v4, v6]
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value);
}

/**
 * Resolve a hostname to IP addresses. Returns array of IP strings or empty array on failure.
 */
async function resolveHostToIps(hostname, options = {}) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!normalized) return [];

  if (net.isIP(normalized)) return [normalized];

  const resolver = options.resolveHostToIps || defaultResolveHostToIps;
  try {
    const ips = await resolver(normalized);
    return Array.isArray(ips) ? ips.filter((ip) => typeof ip === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Check if a hostname resolves to any private/loopback/link-local IP.
 */
async function hostResolvesToPrivate(hostname, options = {}) {
  const ips = await resolveHostToIps(hostname, options);
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
 * @param {Function} [options.resolveHostToIps] - Optional resolver override for tests
 * @returns {Promise<boolean>} True if the host should be blocked
 */
async function isForbiddenLinkPreviewHost(hostname, options = {}) {
  const normalized = String(hostname || '').toLowerCase();
  if (!normalized) return true;
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    return true;
  }
  if (isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
    return true;
  }
  const resolveDns = options.resolveDns !== false;
  if (resolveDns && await hostResolvesToPrivate(normalized, options)) {
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

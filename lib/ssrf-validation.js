/**
 * SSRF validation helpers for link preview endpoint.
 *
 * Provides hostname and IP validation to prevent Server-Side Request Forgery
 * attacks via the /api/link-preview endpoint. Covers:
 * - Direct private/loopback/hostnames (localhost, .local, 10.x, 192.168.x, etc.)
 * - DNS rebinding: resolves hostnames and checks if they resolve to private IP
 * - IPv4 and IPv6 private ranges including link-local and unique-local
 * - IPv6 unspecified address (::) and IPv4 broadcast (255.255.255.255)
 */

const dns = require('dns');
const net = require('net');
const dnsPromises = dns.promises;

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
  );
}

async function defaultResolveHostToIps(hostname) {
  const [v4, v6] = await Promise.allSettled([
    dnsPromises.resolve4(hostname),
    dnsPromises.resolve6(hostname),
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
 * Resolve a hostname with `verbatim: true` and assert the answer is a single
 * non-private address that the caller can pin as the outbound socket target.
 *
 * Closing the DNS time-of-check/time-of-use race for SSRF-sensitive fetches
 * requires that the IP the SSRF checker validated be the IP the underlying
 * socket dials. `dns.promises.lookup(..., { verbatim: true })` resolves once
 * and returns the address that the OS would use; we then return it here so
 * the caller can pass it directly as the connection host (with the original
 * hostname preserved in the `Host` header for virtual hosting).
 *
 * @param {string} hostname
 * @param {object} [options]
 * @param {Function} [options.lookup] - Optional `dns.promises.lookup`-shaped
 *                                       override for tests. Receives
 *       `(hostname, opts)` where `opts` includes `verbatim: true` and must
 *       return `{ address, family }`. Returning a Promise is supported.
 * @returns {Promise<{hostname: string, address: string, family: 4 | 6}>}
 * @throws {Error} with `.code` of `PRIVATE_HOST`, `DNS_NO_ADDRESS`, or
 *                 `DNS_BAD_FAMILY` if the pin must not be used. The caller
 *                 must refuse to issue the outbound connection in that case.
 */
async function resolveAndPinHost(hostname, options = {}) {
  const normalized = String(hostname || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!normalized) {
    const err = new Error('Cannot pin an empty hostname');
    err.code = 'PRIVATE_HOST';
    throw err;
  }

  // Literal IP short-circuit: still validate it is public, otherwise the
  // caller would connect to a private address by hand.
  if (net.isIP(normalized)) {
    if (isPrivateIPv4(normalized) || isPrivateIPv6(normalized)) {
      const err = new Error('Refusing to fetch a private/loopback IP literal');
      err.code = 'PRIVATE_HOST';
      throw err;
    }
    return { hostname: normalized, address: normalized, family: net.isIPv4(normalized) ? 4 : 6 };
  }

  // Block obvious-forbidden hostnames before issuing a DNS lookup.
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) {
    const err = new Error('Refusing to fetch a local/private hostname');
    err.code = 'PRIVATE_HOST';
    throw err;
  }

  const lookup = typeof options.lookup === 'function'
    ? options.lookup
    : (host, _opts) => dnsPromises.lookup(host, { verbatim: true });

  const result = await lookup(normalized, { verbatim: true, all: false });

  // The IP the SSRF check just produced must itself be public; if it is
  // private, refuse to dial it.
  if (!result || !result.address) {
    const err = new Error('DNS lookup returned no address');
    err.code = 'DNS_NO_ADDRESS';
    throw err;
  }
  if (isPrivateIPv4(result.address) || isPrivateIPv6(result.address)) {
    const err = new Error('Resolved address is private/loopback/link-local');
    err.code = 'PRIVATE_HOST';
    throw err;
  }
  if (result.family !== 4 && result.family !== 6) {
    const err = new Error('DNS lookup returned an unsupported address family');
    err.code = 'DNS_BAD_FAMILY';
    throw err;
  }

  return { hostname: normalized, address: result.address, family: result.family };
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
  resolveAndPinHost,
  hostResolvesToPrivate,
  isForbiddenLinkPreviewHost,
};
'use strict';

/**
 * Trusted-proxy allowlist + safe client-IP extraction for rate limiting.
 *
 * The rate limiters in server.js used to key on `cf-connecting-ip` and
 * `x-forwarded-for` unconditionally. With the app reachable directly on
 * port 3000 (no proxy in front), any client could rotate those headers
 * per request and get an unlimited supply of rate-limit buckets. This
 * module gates those headers behind an operator-controlled allowlist and
 * a hardcoded Cloudflare edge list, falling back to the direct TCP peer
 * (req.socket.remoteAddress) whenever the peer is not trusted.
 *
 * Configuration:
 *   TRUSTED_PROXY_IPS  Comma-separated list of trusted proxy addresses.
 *                      Each entry may be a plain IPv4/IPv6 address, an
 *                      IPv4 or IPv6 CIDR block (e.g. `10.0.0.0/8`,
 *                      `2001:db8::/32`), or the special token `cloudflare`
 *                      which expands to the published Cloudflare edge
 *                      ranges. Defaults to empty (no forwarded headers
 *                      are honored).
 *
 * All configured entries are normalized (lower-cased, IPv4-mapped IPv6
 * `::ffff:` prefix stripped) so that an operator who writes
 * `::ffff:1.2.3.4` matches a peer reporting as `1.2.3.4`.
 */

const CLOUDFLARE_V4 = Object.freeze([
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
]);

const CLOUDFLARE_V6 = Object.freeze([
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
]);

/**
 * Normalize a textual IP address. Strips a leading `::ffff:` IPv4-mapped
 * IPv6 prefix and lowercases the result. Returns null for empty input.
 */
function normalizeIp(ip) {
  if (ip === null || ip === undefined) return null;
  const s = String(ip).trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('::ffff:')) {
    return s.slice(7);
  }
  return s;
}

function parseIpv4ToBigInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let acc = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    acc = (acc << 8n) | BigInt(n);
  }
  return acc;
}

function parseIpv6BigInt(ip) {
  // Handle IPv4-mapped (already stripped by normalizeIp in normal use).
  if (ip.includes('.')) {
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const a = ((Number(m[1]) << 8) | Number(m[2])).toString(16);
    const b = ((Number(m[3]) << 8) | Number(m[4])).toString(16);
    return BigInt('0x' + a + b + '0000000000000000000000000000');
  }
  // Strip zone id (link-local fe80::1%eth0) which Node may add.
  const zoneIdx = ip.indexOf('%');
  const stripped = zoneIdx === -1 ? ip : ip.slice(0, zoneIdx);
  // Handle :: shorthand. At most one ::.
  const doubleColon = stripped.indexOf('::');
  if (doubleColon !== -1 && stripped.indexOf('::', doubleColon + 1) !== -1) {
    return null;
  }
  let head;
  let tail;
  if (doubleColon === -1) {
    head = stripped;
    tail = '';
  } else {
    head = stripped.slice(0, doubleColon);
    tail = stripped.slice(doubleColon + 2);
  }
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === '' ? [] : tail.split(':');
  const totalParts = headParts.length + tailParts.length;
  if (totalParts > 8) return null;
  const fill = 8 - totalParts;
  const parts = [];
  for (const p of headParts) parts.push(p);
  for (let i = 0; i < fill; i += 1) parts.push('0');
  for (const p of tailParts) parts.push(p);
  let acc = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    acc = (acc << 16n) | BigInt('0x' + part);
  }
  return acc;
}

function maskBigInt(bits, prefixLen) {
  if (prefixLen === 0) return 0n;
  if (prefixLen >= bits) {
    return (1n << BigInt(bits)) - 1n;
  }
  const shift = BigInt(bits) - BigInt(prefixLen);
  return ((1n << BigInt(bits)) - 1n) ^ ((1n << shift) - 1n);
}

function cidrContains(cidr, ip) {
  if (!cidr.includes('/')) {
    return cidr === ip;
  }
  const [base, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  const isV6 = base.includes(':');
  if (isV6) {
    if (prefix > 128) return false;
    const baseN = parseIpv6BigInt(base);
    const ipN = parseIpv6BigInt(ip);
    if (baseN === null || ipN === null) return false;
    if (prefix === 0) return true;
    const mask = maskBigInt(128, prefix);
    return (baseN & mask) === (ipN & mask);
  }
  if (prefix > 32) return false;
  const baseN = parseIpv4ToBigInt(base);
  const ipN = parseIpv4ToBigInt(ip);
  if (baseN === null || ipN === null) return false;
  if (prefix === 0) return true;
  const mask = maskBigInt(32, prefix);
  return (baseN & mask) === (ipN & mask);
}

let cachedEntries = null;
let cachedEnvKey = null;

function envFingerprint(envValue) {
  return envValue === undefined || envValue === null
    ? '__UNSET__'
    : String(envValue);
}

/**
 * Parse the TRUSTED_PROXY_IPS env value into a list of normalized CIDR/IP
 * entries. Supports plain IPs, CIDR blocks, and the `cloudflare` keyword.
 */
function parseTrustedProxies(envValue) {
  const entries = [];
  if (envValue === undefined || envValue === null || envValue === '') {
    return entries;
  }
  const seen = new Set();
  const push = (entry) => {
    if (!entry) return;
    if (seen.has(entry)) return;
    seen.add(entry);
    entries.push(entry);
  };
  for (const raw of String(envValue).split(',')) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.toLowerCase() === 'cloudflare') {
      for (const cidr of CLOUDFLARE_V4) push(cidr);
      for (const cidr of CLOUDFLARE_V6) push(cidr);
      continue;
    }
    // Normalize plain IPs; preserve CIDR strings (base normalized, prefix kept).
    const slashIdx = trimmed.indexOf('/');
    if (slashIdx === -1) {
      const normalized = normalizeIp(trimmed);
      if (normalized) push(normalized);
    } else {
      const base = normalizeIp(trimmed.slice(0, slashIdx));
      const prefix = trimmed.slice(slashIdx + 1);
      if (base && /^\d{1,3}$/.test(prefix)) {
        const n = Number(prefix);
        if ((base.includes(':') && n >= 0 && n <= 128)
          || (!base.includes(':') && n >= 0 && n <= 32)) {
          push(`${base}/${prefix}`);
        }
      }
    }
  }
  return entries;
}

function loadEntries() {
  const envKey = envFingerprint(process.env.TRUSTED_PROXY_IPS);
  if (cachedEntries === null || cachedEnvKey !== envKey) {
    cachedEntries = parseTrustedProxies(process.env.TRUSTED_PROXY_IPS);
    cachedEnvKey = envKey;
  }
  return cachedEntries;
}

function resetTrustedProxiesCache() {
  cachedEntries = null;
  cachedEnvKey = null;
}

function getTrustedProxyEntries() {
  return loadEntries().slice();
}

function ipMatchesEntry(entry, ip) {
  if (!entry.includes('/')) {
    return entry === ip;
  }
  return cidrContains(entry, ip);
}

function isTrustedProxy(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  const entries = loadEntries();
  for (const entry of entries) {
    if (ipMatchesEntry(entry, normalized)) return true;
  }
  return false;
}

function isCloudflareEdge(ip) {
  const normalized = normalizeIp(ip);
  if (!normalized) return false;
  for (const cidr of CLOUDFLARE_V4) {
    if (cidrContains(cidr, normalized)) return true;
  }
  for (const cidr of CLOUDFLARE_V6) {
    if (cidrContains(cidr, normalized)) return true;
  }
  return false;
}

function peerIp(req) {
  if (!req) return null;
  // Use the raw TCP peer address; Express's req.ip is influenced by
  // app.set('trust proxy', ...) which is the very knob we are replacing
  // here.
  const sock = req.socket || (req.connection && req.connection.socket);
  if (sock && sock.remoteAddress) return normalizeIp(sock.remoteAddress);
  return null;
}

/**
 * Build the rate-limit bucket key for an incoming request.
 *
 * Rules:
 *   - If the TCP peer is NOT in the trusted-proxy allowlist, the key is
 *     always the direct socket address — forwarded headers are ignored,
 *     so a client cannot mint new buckets by rotating headers.
 *   - If the peer IS trusted AND matches a known Cloudflare edge range,
 *     `cf-connecting-ip` is honored (it's the Cloudflare-asserted
 *     visitor IP).
 *   - Otherwise, when the peer is trusted, the leftmost `X-Forwarded-For`
 *     entry is honored.
 *   - The returned value is always normalized (lowercase, IPv4-mapped
 *     IPv6 prefix stripped) so equivalent addresses share a bucket.
 */
function buildRateLimitKey(req) {
  const peer = peerIp(req) || normalizeIp(req && req.ip);
  if (!peer) return 'unknown';
  if (!isTrustedProxy(peer)) {
    return peer;
  }
  if (isCloudflareEdge(peer)) {
    const cf = normalizeIp(req.headers && req.headers['cf-connecting-ip']);
    if (cf) return cf;
  }
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) {
    const leftmost = normalizeIp(String(xff).split(',')[0]);
    if (leftmost) return leftmost;
  }
  return peer;
}

/**
 * Read the leftmost value of a comma-separated forwarded header.
 * Returns '' when the header is absent or empty.
 */
function leftmostForwarded(req, header) {
  const raw = req && req.headers ? req.headers[header] : undefined;
  if (raw === undefined || raw === null) return '';
  return String(raw).split(',')[0].trim();
}

/**
 * Determine the effective protocol for a request, honoring
 * `X-Forwarded-Proto` only when the TCP peer is on the trusted-proxy
 * allowlist. When the peer is not trusted (the default, direct-on-port-3000
 * deployment shape) the forwarded header is ignored and the value reported
 * by the socket (`req.protocol`, which with `trust proxy` disabled reflects
 * the actual TLS state of the connection) is used.
 *
 * @param {object} req - Express request object
 * @returns {string} 'http' or 'https'
 */
function safeProtocol(req) {
  const peer = peerIp(req);
  if (peer && isTrustedProxy(peer)) {
    const forwarded = leftmostForwarded(req, 'x-forwarded-proto').toLowerCase();
    if (forwarded === 'https' || forwarded === 'http') return forwarded;
  }
  const proto = req && typeof req.protocol === 'string' ? req.protocol.toLowerCase() : '';
  return proto === 'https' ? 'https' : 'http';
}

/**
 * Determine the effective host for a request, honoring `X-Forwarded-Host`
 * only when the TCP peer is on the trusted-proxy allowlist. When the peer is
 * not trusted the forwarded header is ignored and the `Host` header is used
 * (a direct client's `Host` header is the origin they actually reached, so
 * it cannot be used to mint a different origin for a trusted peer).
 *
 * @param {object} req - Express request object
 * @returns {string} host (may be empty when no Host header is present)
 */
function safeHost(req) {
  const peer = peerIp(req);
  if (peer && isTrustedProxy(peer)) {
    const forwarded = leftmostForwarded(req, 'x-forwarded-host');
    if (forwarded) return forwarded;
  }
  const host = req && typeof req.get === 'function' ? req.get('host') : '';
  return host || '';
}

module.exports = {
  normalizeIp,
  parseTrustedProxies,
  getTrustedProxyEntries,
  resetTrustedProxiesCache,
  isTrustedProxy,
  isCloudflareEdge,
  buildRateLimitKey,
  peerIp,
  safeProtocol,
  safeHost,
  // Exposed for tests / debugging.
  _CLOUDFLARE_V4: CLOUDFLARE_V4,
  _CLOUDFLARE_V6: CLOUDFLARE_V6,
};
'use strict';

/**
 * Bounded in-memory cache for link preview results with TTL and size limits.
 *
 * Usage:
 *   const { PreviewCache } = require('./lib/link-preview-cache');
 *   const cache = new PreviewCache({ maxSize: 256, ttlMs: 300_000 }); // 5 min default
 *   await cache.set(url, previewData);
 *   const entry = cache.get(url); // { data, expiresAt } or undefined
 *   cache.cleanup(); // remove expired entries (call periodically)
 */

const DEFAULT_MAX_SIZE = 256;
const DEFAULT_TTL_MS = 300_000; // 5 minutes

class PreviewCacheEntry {
  constructor(url, data, ttlMs) {
    this.url = url;
    this.data = data;
    this.createdAt = Date.now();
    this.ttlMs = ttlMs;
    this.expiresAt = this.createdAt + ttlMs;
  }

  get isExpired() {
    return Date.now() >= this.expiresAt;
  }
}

class PreviewCache {
  /**
   * @param {object} opts
   * @param {number} [opts.maxSize] - Maximum number of entries (default 256)
   * @param {number} [opts.ttlMs] - Time-to-live in ms per entry (default 300_000)
   */
  constructor(opts = {}) {
    this.maxSize = Number.isFinite(opts.maxSize) && opts.maxSize > 0 ? opts.maxSize : DEFAULT_MAX_SIZE;
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : DEFAULT_TTL_MS;
    /** @type {Map<string, PreviewCacheEntry>} */
    this.store = new Map();
  }

  /**
   * Get a cached entry (returns undefined if miss or expired).
   * @param {string} url
   * @returns {PreviewCacheEntry | undefined}
   */
  get(url) {
    const key = this._normalizeKey(url);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.isExpired) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  /**
   * Set a cached entry, evicting LRU if at capacity.
   * @param {string} url
   * @param {*} data
   */
  set(url, data) {
    const key = this._normalizeKey(url);
    // If key already exists, update it in place (no eviction needed)
    if (this.store.has(key)) {
      this.store.set(key, new PreviewCacheEntry(url, data, this.ttlMs));
      return;
    }
    // Evict LRU entries until under capacity
    while (this.store.size >= this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      this.store.delete(oldestKey);
    }
    this.store.set(key, new PreviewCacheEntry(url, data, this.ttlMs));
  }

  /**
   * Remove expired entries. Returns count of removed entries.
   */
  cleanup() {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.isExpired) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Return cache stats for observability.
   */
  stats() {
    const now = Date.now();
    let expiredCount = 0;
    for (const entry of this.store.values()) {
      if (entry.isExpired) expiredCount++;
    }
    return {
      size: this.store.size,
      maxSize: this.maxSize,
      ttlMs: this.ttlMs,
      expiredCount,
      activeCount: this.store.size - expiredCount,
    };
  }

  /**
   * Clear all entries.
   */
  clear() {
    this.store.clear();
  }

  _normalizeKey(url) {
    // Lowercase URL for case-insensitive caching (URLs are case-sensitive in query strings)
    return url.toLowerCase();
  }
}

/**
 * Coalescing wrapper: if multiple requests arrive for the same URL while one is pending,
 * they share the result of the first request instead of each doing their own fetch.
 *
 * Usage:
 *   const coalescer = new PreviewCoalescer();
 *   const result = await coalescer.run(url, () => fetchPreview(url));
 */
class PreviewCoalescer {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this.pending = new Map();
  }

  /**
   * Run a function for the given key, coalescing concurrent calls.
   * @param {string} key
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  async run(key, fn) {
    const existing = this.pending.get(key);
    if (existing) {
      return existing;
    }
    const promise = fn().finally(() => {
      this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Cancel all pending coalescing promises.
   */
  cancelAll() {
    this.pending.clear();
  }
}

module.exports = { PreviewCache, PreviewCoalescer, DEFAULT_MAX_SIZE, DEFAULT_TTL_MS };

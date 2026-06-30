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


/**
 * Per-host concurrency limiter: caps the number of concurrent fetches per hostname.
 * Prevents a burst of different URLs on the same host from overwhelming DNS/network.
 *
 * Usage:
 *   const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 2 });
 *   await limiter.run('example.com', async () => { ... fetch ... });
 */
class HostConcurrencyLimiter {
  /**
   * @param {object} opts
   * @param {number} [opts.maxConcurrentPerHost] - Max concurrent fetches per host (default 2)
   */
  constructor(opts = {}) {
    this.maxConcurrentPerHost = Number.isFinite(opts.maxConcurrentPerHost) && opts.maxConcurrentPerHost > 0
      ? opts.maxConcurrentPerHost
      : 2;

    /** @type {Map<string, number>} active counts per host */
    this.active = new Map();
    /** @type {Map<string, Array<{resolve: function}>>} wait queues per host */
    this.waiters = new Map();
  }

  /**
   * Run a function with per-host concurrency limiting.
   * @param {string} host - The hostname to limit
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  async run(host, fn) {
    const current = this.active.get(host) || 0;

    if (current < this.maxConcurrentPerHost) {
      // Under limit: run immediately
      this.active.set(host, current + 1);
      try {
        return await fn();
      } finally {
        this._release(host);
      }
    }

    // At limit: wait for a slot to free up
    return new Promise((resolve) => {
      if (!this.waiters.has(host)) {
        this.waiters.set(host, []);
      }
      this.waiters.get(host).push(resolve);
    }).then(async () => {
      this.active.set(host, (this.active.get(host) || 0) + 1);
      try {
        return await fn();
      } finally {
        this._release(host);
      }
    });
  }

  /**
   * Release a slot for the given host, waking a waiter if any.
   */
  _release(host) {
    const current = (this.active.get(host) || 1) - 1;
    this.active.set(host, current);

    if (current === 0) {
      this.active.delete(host);
    }

    // Wake one waiter
    const waiters = this.waiters.get(host);
    if (waiters && waiters.length > 0) {
      const next = waiters.shift();
      next();
      if (waiters.length === 0) {
        this.waiters.delete(host);
      }
    }
  }

  /**
   * Return current active counts for observability.
   */
  stats() {
    return {
      maxConcurrentPerHost: this.maxConcurrentPerHost,
      activeHosts: this.active.size,
      waitingQueues: this.waiters.size,
    };
  }
}

module.exports = { PreviewCache, PreviewCoalescer, HostConcurrencyLimiter, DEFAULT_MAX_SIZE, DEFAULT_TTL_MS };

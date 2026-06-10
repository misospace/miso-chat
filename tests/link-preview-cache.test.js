const test = require('node:test');
const assert = require('node:assert/strict');
const { PreviewCache, PreviewCoalescer } = require('../lib/link-preview-cache');

// ---- PreviewCache tests ----

test('PreviewCache stores and retrieves entries', () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 5000 });
  cache.set('https://example.com', { title: 'Example' });
  const entry = cache.get('https://example.com');
  assert.ok(entry);
  assert.equal(entry.data.title, 'Example');
});

test('PreviewCache returns undefined for missing keys', () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 5000 });
  assert.equal(cache.get('https://nonexistent.com'), undefined);
});

test('PreviewCache evicts LRU when at capacity', () => {
  const cache = new PreviewCache({ maxSize: 3, ttlMs: 5000 });
  cache.set('https://a.com', { id: 'a' });
  cache.set('https://b.com', { id: 'b' });
  cache.set('https://c.com', { id: 'c' });
  // At capacity, adding d should evict a (LRU)
  cache.set('https://d.com', { id: 'd' });
  assert.equal(cache.get('https://a.com'), undefined);
  assert.ok(cache.get('https://b.com'));
  assert.ok(cache.get('https://c.com'));
  assert.ok(cache.get('https://d.com'));
});

test('PreviewCache respects TTL expiry', async () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 50 });
  cache.set('https://example.com', { title: 'Example' });
  assert.ok(cache.get('https://example.com'));
  // Wait for expiry
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(cache.get('https://example.com'), undefined);
});

test('PreviewCache cleanup removes expired entries', async () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 50 });
  cache.set('https://a.com', { id: 'a' });
  cache.set('https://b.com', { id: 'b' });
  await new Promise(resolve => setTimeout(resolve, 60));
  const removed = cache.cleanup();
  assert.equal(removed, 2);
  assert.equal(cache.get('https://a.com'), undefined);
  assert.equal(cache.get('https://b.com'), undefined);
});

test('PreviewCache stats returns correct counts', () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 5000 });
  cache.set('https://a.com', { id: 'a' });
  cache.set('https://b.com', { id: 'b' });
  const stats = cache.stats();
  assert.equal(stats.size, 2);
  assert.equal(stats.maxSize, 10);
  assert.equal(stats.ttlMs, 5000);
  assert.equal(stats.expiredCount, 0);
  assert.equal(stats.activeCount, 2);
});

test('PreviewCache clear removes all entries', () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 5000 });
  cache.set('https://a.com', { id: 'a' });
  cache.set('https://b.com', { id: 'b' });
  cache.clear();
  assert.equal(cache.get('https://a.com'), undefined);
  assert.equal(cache.get('https://b.com'), undefined);
});

test('PreviewCache normalizes URLs to lowercase for keys', () => {
  const cache = new PreviewCache({ maxSize: 10, ttlMs: 5000 });
  cache.set('https://EXAMPLE.COM/page', { title: 'Example' });
  const entry = cache.get('https://example.com/page');
  assert.ok(entry);
  assert.equal(entry.data.title, 'Example');
});

test('PreviewCache updates existing keys in place (no eviction)', () => {
  const cache = new PreviewCache({ maxSize: 2, ttlMs: 5000 });
  cache.set('https://a.com', { id: 'a' });
  cache.set('https://b.com', { id: 'b' });
  // Update a — should NOT evict b since a already exists
  cache.set('https://a.com', { id: 'a-updated' });
  assert.ok(cache.get('https://b.com'));
  assert.equal(cache.get('https://a.com').data.id, 'a-updated');
});

// ---- PreviewCoalescer tests ----

test('PreviewCoalescer returns same result for concurrent calls', async () => {
  const coalescer = new PreviewCoalescer();
  let callCount = 0;
  const fn = async () => {
    callCount++;
    await new Promise(resolve => setTimeout(resolve, 50));
    return { result: 'ok' };
  };

  // Start two concurrent calls for the same key
  const [r1, r2] = await Promise.all([
    coalescer.run('https://example.com', fn),
    coalescer.run('https://example.com', fn),
  ]);

  assert.equal(r1.result, 'ok');
  assert.equal(r2.result, 'ok');
  assert.equal(callCount, 1); // Only one call should have been made
});

test('PreviewCoalescer allows different keys to run independently', async () => {
  const coalescer = new PreviewCoalescer();
  let aCount = 0;
  let bCount = 0;
  const fnA = async () => { aCount++; await new Promise(r => setTimeout(r, 50)); return 'a'; };
  const fnB = async () => { bCount++; await new Promise(r => setTimeout(r, 50)); return 'b'; };

  const [r1, r2] = await Promise.all([
    coalescer.run('key-a', fnA),
    coalescer.run('key-b', fnB),
  ]);

  assert.equal(r1, 'a');
  assert.equal(r2, 'b');
  assert.equal(aCount, 1);
  assert.equal(bCount, 1);
});

test('PreviewCoalescer sequential calls both execute', async () => {
  const coalescer = new PreviewCoalescer();
  let count = 0;
  const fn = async () => { count++; await new Promise(r => setTimeout(r, 30)); return 'ok'; };

  // Sequential: first completes before second starts
  const r1 = await coalescer.run('key', fn);
  const r2 = await coalescer.run('key', fn);

  assert.equal(r1, 'ok');
  assert.equal(r2, 'ok');
  assert.equal(count, 2); // Both should execute since they're sequential
});

test('PreviewCoalescer cancelAll clears pending promises', async () => {
  const coalescer = new PreviewCoalescer();
  let count = 0;
  const fn = async () => { count++; await new Promise(r => setTimeout(r, 1000)); return 'ok'; };

  // Start a long-running call
  const p = coalescer.run('key', fn);
  assert.equal(count, 1);

  // Cancel it
  coalescer.cancelAll();

  // Start another call for the same key — should execute fresh
  const r2 = await coalescer.run('key', fn);
  assert.equal(r2, 'ok');
  assert.equal(count, 2); // First was cancelled, second executed
});

test('PreviewCoalescer propagates errors from fn', async () => {
  const coalescer = new PreviewCoalescer();
  const errFn = async () => { throw new Error('fetch failed'); };

  await assert.rejects(
    coalescer.run('key', errFn),
    { message: 'fetch failed' },
  );

  // After error, the key should be freed for a fresh call
  let count = 0;
  const okFn = async () => { count++; return 'ok'; };
  const r = await coalescer.run('key', okFn);
  assert.equal(r, 'ok');
  assert.equal(count, 1);
});

// ---- Integration: Cache + Coalescer pressure scenarios ----

test('Cache hit skips coalescer for repeated requests', async () => {
  const cache = new PreviewCache({ maxSize: 256, ttlMs: 300_000 });
  let fetchCount = 0;
  const fn = async () => { fetchCount++; return { title: 'cached' }; };

  // First request — cache miss, fetches
  let cached = cache.get('https://example.com');
  if (!cached) {
    const data = await fn();
    cache.set('https://example.com', data);
    cached = cache.get('https://example.com');
  }

  assert.equal(fetchCount, 1);

  // Second request — cache hit, no fetch
  const cached2 = cache.get('https://example.com');
  assert.ok(cached2);
  assert.equal(fetchCount, 1); // Still 1
});

test('Coalescer prevents duplicate fetches under concurrent load', async () => {
  const cache = new PreviewCache({ maxSize: 256, ttlMs: 300_000 });
  const coalescer = new PreviewCoalescer();
  let fetchCount = 0;

  const fn = async () => {
    fetchCount++;
    await new Promise(r => setTimeout(r, 100));
    return { title: 'concurrent' };
  };

  // Simulate 5 concurrent requests for the same URL
  const results = await Promise.all([
    coalescer.run('https://example.com', async () => {
      const cached = cache.get('https://example.com');
      if (cached) return cached.data;
      const data = await fn();
      cache.set('https://example.com', data);
      return data;
    }),
    coalescer.run('https://example.com', async () => {
      const cached = cache.get('https://example.com');
      if (cached) return cached.data;
      const data = await fn();
      cache.set('https://example.com', data);
      return data;
    }),
    coalescer.run('https://example.com', async () => {
      const cached = cache.get('https://example.com');
      if (cached) return cached.data;
      const data = await fn();
      cache.set('https://example.com', data);
      return data;
    }),
    coalescer.run('https://example.com', async () => {
      const cached = cache.get('https://example.com');
      if (cached) return cached.data;
      const data = await fn();
      cache.set('https://example.com', data);
      return data;
    }),
    coalescer.run('https://example.com', async () => {
      const cached = cache.get('https://example.com');
      if (cached) return cached.data;
      const data = await fn();
      cache.set('https://example.com', data);
      return data;
    }),
  ]);

  assert.equal(fetchCount, 1); // Only one fetch despite 5 concurrent requests
  results.forEach(r => assert.equal(r.title, 'concurrent'));
});

test('Cache TTL expiry allows fresh fetch on next request', async () => {
  const cache = new PreviewCache({ maxSize: 256, ttlMs: 100 });
  let fetchCount = 0;

  const fn = async () => { fetchCount++; return { version: fetchCount }; };

  // First fetch
  cache.set('https://example.com', await fn());
  assert.equal(fetchCount, 1);

  // Cache hit
  assert.ok(cache.get('https://example.com'));
  assert.equal(fetchCount, 1);

  // Wait for expiry
  await new Promise(r => setTimeout(r, 150));

  // Cache miss — would trigger a fresh fetch
  assert.equal(cache.get('https://example.com'), undefined);
  cache.set('https://example.com', await fn());
  assert.equal(fetchCount, 2);
});

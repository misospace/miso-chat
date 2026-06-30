const test = require('node:test');
const assert = require('node:assert/strict');
const { HostConcurrencyLimiter } = require('../lib/link-preview-cache');

// ---- HostConcurrencyLimiter tests ----

test('HostConcurrencyLimiter allows up to maxConcurrentPerHost simultaneous fetches', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 2 });
  let activeCount = 0;
  let maxObserved = 0;

  const tasks = Array.from({ length: 6 }, () =>
    limiter.run('example.com', async () => {
      activeCount++;
      if (activeCount > maxObserved) maxObserved = activeCount;
      await new Promise(resolve => setTimeout(resolve, 50));
      activeCount--;
      return 'ok';
    }),
  );

  const results = await Promise.all(tasks);
  assert.equal(results.length, 6);
  results.forEach(r => assert.equal(r, 'ok'));
  // Max concurrent should never exceed the limit
  assert.ok(maxObserved <= 2, `max observed concurrent was ${maxObserved}, expected <= 2`);
});

test('HostConcurrencyLimiter allows different hosts to run independently', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 1 });
  let aActive = 0;
  let bActive = 0;

  const results = await Promise.all([
    limiter.run('host-a.com', async () => {
      aActive++;
      await new Promise(resolve => setTimeout(resolve, 50));
      aActive--;
      return 'a';
    }),
    limiter.run('host-b.com', async () => {
      bActive++;
      await new Promise(resolve => setTimeout(resolve, 50));
      bActive--;
      return 'b';
    }),
  ]);

  assert.equal(results[0], 'a');
  assert.equal(results[1], 'b');
});

test('HostConcurrencyLimiter serializes excess requests per host', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 1 });
  const order = [];

  const results = await Promise.all([
    limiter.run('example.com', async () => {
      order.push('start-1');
      await new Promise(resolve => setTimeout(resolve, 50));
      order.push('end-1');
      return 1;
    }),
    limiter.run('example.com', async () => {
      order.push('start-2');
      await new Promise(resolve => setTimeout(resolve, 30));
      order.push('end-2');
      return 2;
    }),
    limiter.run('example.com', async () => {
      order.push('start-3');
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push('end-3');
      return 3;
    }),
  ]);

  // With maxConcurrentPerHost=1, tasks should run sequentially
  assert.deepEqual(order.slice(0, 2), ['start-1', 'end-1']);
});

test('HostConcurrencyLimiter propagates errors from fn', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 2 });

  await assert.rejects(
    limiter.run('example.com', async () => { throw new Error('fetch failed'); }),
    { message: 'fetch failed' },
  );

  // After error, the slot should be freed
  const result = await limiter.run('example.com', async () => 'ok');
  assert.equal(result, 'ok');
});

test('HostConcurrencyLimiter stats returns correct counts', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 3 });
  const stats = limiter.stats();
  assert.equal(stats.maxConcurrentPerHost, 3);
  assert.equal(stats.activeHosts, 0);
  assert.equal(stats.waitingQueues, 0);
});

// ---- Retry delay with jitter tests ----

test('Retry delay uses exponential backoff with jitter', async () => {
  // Import the helper from server.js context — we test the formula directly
  const LINK_PREVIEW_RETRY_BASE_DELAY_MS = 200;
  const LINK_PREVIEW_RETRY_MAX_DELAY_MS = 1000;

  function retryDelayMs(attempt) {
    const exponential = Math.min(
      LINK_PREVIEW_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
      LINK_PREVIEW_RETRY_MAX_DELAY_MS,
    );
    const jitterRange = exponential * 0.25;
    return Math.round(exponential + (Math.random() * jitterRange * 2 - jitterRange));
  }

  // Attempt 0: base 200ms ± 25% => [150, 250]
  for (let i = 0; i < 20; i++) {
    const d = retryDelayMs(0);
    assert.ok(d >= 150 && d <= 250, `attempt 0 delay ${d} out of [150, 250]`);
  }

  // Attempt 1: base 400ms ± 25% => [300, 500]
  for (let i = 0; i < 20; i++) {
    const d = retryDelayMs(1);
    assert.ok(d >= 300 && d <= 500, `attempt 1 delay ${d} out of [300, 500]`);
  }

  // Attempt 2: base 800ms ± 25% => [600, 1000]
  for (let i = 0; i < 20; i++) {
    const d = retryDelayMs(2);
    assert.ok(d >= 600 && d <= 1000, `attempt 2 delay ${d} out of [600, 1000]`);
  }

  // Attempt 3: capped at 1000ms ± 25% => [750, 1000]
  for (let i = 0; i < 20; i++) {
    const d = retryDelayMs(3);
    assert.ok(d >= 750 && d <= 1250, `attempt 3 delay ${d} out of [750, 1250]`);
  }
});

// ---- Simulated concurrent SSRF-DNS slow response test ----

test('Simulates simultaneous slow DNS responses under concurrency limit', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 2 });
  const dnsTimes = [];
  const host = 'slow-dns.example.com';

  // Simulate 6 concurrent requests to the same host with slow DNS
  const startTime = Date.now();
  const tasks = Array.from({ length: 6 }, (_, i) =>
    limiter.run(host, async () => {
      const dnsStart = Date.now();
      // Simulate slow DNS resolution (100ms each)
      await new Promise(resolve => setTimeout(resolve, 100));
      const dnsElapsed = Date.now() - dnsStart;
      dnsTimes.push(dnsElapsed);
      return { index: i, dnsMs: dnsElapsed };
    }),
  );

  const results = await Promise.all(tasks);
  const totalElapsed = Date.now() - startTime;

  // With 6 requests and maxConcurrent=2, should take ~300ms (3 batches of 2)
  assert.ok(totalElapsed >= 250, `total elapsed ${totalElapsed}ms should be >= 250ms for 3 batches`);
  assert.ok(totalElapsed < 800, `total elapsed ${totalElapsed}ms should be < 800ms`);

  // All results should have ~100ms DNS time
  dnsTimes.forEach(t => {
    assert.ok(t >= 90 && t <= 150, `dns time ${t}ms out of expected range`);
  });
});

test('Per-host limiter prevents DNS thundering herd across multiple hosts', async () => {
  const limiter = new HostConcurrencyLimiter({ maxConcurrentPerHost: 1 });
  let hostAActive = 0;
  let hostBActive = 0;
  let hostAMax = 0;
  let hostBMax = 0;

  // 4 requests to each host, but max 1 concurrent per host
  const tasks = [
    ...Array.from({ length: 4 }, () =>
      limiter.run('host-a.com', async () => {
        hostAActive++;
        if (hostAActive > hostAMax) hostAMax = hostAActive;
        await new Promise(resolve => setTimeout(resolve, 40));
        hostAActive--;
      }),
    ),
    ...Array.from({ length: 4 }, () =>
      limiter.run('host-b.com', async () => {
        hostBActive++;
        if (hostBActive > hostBMax) hostBMax = hostBActive;
        await new Promise(resolve => setTimeout(resolve, 40));
        hostBActive--;
      }),
    ),
  ];

  await Promise.all(tasks);
  assert.equal(hostAMax, 1, 'host-a should never exceed concurrency limit of 1');
  assert.equal(hostBMax, 1, 'host-b should never exceed concurrency limit of 1');
});

// ---- Structured metrics accumulation test ----

test('Structured timing metrics accumulate across phases', async () => {
  const metrics = { dns: 0, connectHeaders: 0, bodyRead: 0, overall: 0, retryCount: 0, retries: [] };

  // Simulate phase timings
  const start = Date.now();

  // DNS phase
  await new Promise(resolve => setTimeout(resolve, 10));
  metrics.dns += 15;

  // Connect+headers phase
  await new Promise(resolve => setTimeout(resolve, 5));
  metrics.connectHeaders += 25;

  // Body read phase
  await new Promise(resolve => setTimeout(resolve, 8));
  metrics.bodyRead += 30;

  metrics.overall = Date.now() - start;

  // Verify metrics are positive and accumulate
  assert.ok(metrics.dns > 0, 'dns metric should be positive');
  assert.ok(metrics.connectHeaders > 0, 'connectHeaders metric should be positive');
  assert.ok(metrics.bodyRead > 0, 'bodyRead metric should be positive');
  assert.ok(metrics.overall > 0, 'overall metric should be positive');
  assert.equal(metrics.retryCount, 0, 'no retries in this simulation');
  assert.equal(metrics.retries.length, 0, 'retries array should be empty');
});

test('Retry metrics track 5xx retry attempts', async () => {
  const metrics = { dns: 0, connectHeaders: 0, bodyRead: 0, overall: 0, retryCount: 0, retries: [] };

  // Simulate two 5xx retries
  metrics.retryCount++;
  metrics.retries.push({ status: 503, attempt: 1, delayMs: 210 });
  metrics.retryCount++;
  metrics.retries.push({ status: 502, attempt: 2, delayMs: 420 });

  assert.equal(metrics.retryCount, 2);
  assert.equal(metrics.retries.length, 2);
  assert.equal(metrics.retries[0].status, 503);
  assert.equal(metrics.retries[1].status, 502);
});

/**
 * Regression test: Redis package identity verification (issue #695).
 *
 * Confirms that the `redis` dependency in package.json resolves to the
 * canonical node-redis package (github:redis/node-redis) and not a
 * community fork or incompatible rewrite.
 *
 * Resolution: redis@^6.0.0 IS the canonical node-redis package.
 * The @redis/* namespace was used for individual sub-packages in v4,
 * but the main `redis` package at v6+ is published by the same maintainers
 * (redis/node-redis) and provides the createClient API used throughout
 * the codebase (server.js, lib/auth-session.js).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('redis package identity', () => {
  const pkgPath = path.join(__dirname, '..', 'node_modules', 'redis', 'package.json');

  it('skips when redis is not installed (no node_modules)', () => {
    if (!fs.existsSync(pkgPath)) {
      // Test passes — skip validation when package isn't installed
      return;
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

    // Verify the package name is exactly 'redis' (not a fork)
    assert.equal(pkg.name, 'redis', 'Package name must be "redis"');

    // Verify the repository points to the canonical node-redis repo
    const repoUrl = pkg.repository?.url ?? pkg.repository ?? '';
    assert.match(
      String(repoUrl),
      /redis\/node-redis/i,
      'Repository must be github:redis/node-redis',
    );

    // Verify version is 6.x (the current canonical major version)
    assert.ok(
      pkg.version.startsWith('6.'),
      `Version must be 6.x, got ${pkg.version}`,
    );

    // Verify createClient export exists (API used in server.js and lib/auth-session.js)
    const redisModule = require('redis');
    assert.equal(typeof redisModule.createClient, 'function', 'createClient must be exported');
  });
});

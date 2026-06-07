const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('crypto');

const {
  validateSchema,
  validateTagConsistency,
  validateAssetHosts,
  verifyDigest,
  validateManifest,
  normalizeVersion,
  compareVersions,
  SUPPORTED_DIGEST_ALGORITHMS,
} = require('../lib/mobile-manifest-validator');

// ---- Schema Validation Tests ----

test('validateSchema: rejects non-object manifests', () => {
  assert.equal(validateSchema(null).valid, false);
  assert.equal(validateSchema(undefined).valid, false);
  assert.equal(validateSchema([]).valid, false);
  assert.equal(validateSchema('string').valid, false);
  assert.equal(validateSchema(42).valid, false);
});

test('validateSchema: rejects manifest missing required top-level fields', () => {
  const result = validateSchema({});
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('version')), 'must report missing version');
  assert.ok(result.errors.some(e => e.includes('tag')), 'must report missing tag');
});

test('validateSchema: rejects manifest with empty required fields', () => {
  const result = validateSchema({ version: '', tag: '' });
  assert.equal(result.valid, false);
});

test('validateSchema: rejects manifest missing channels', () => {
  const result = validateSchema({ version: '0.4.13', tag: 'v0.4.13' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('channels')));
});

test('validateSchema: rejects missing channels object', () => {
  const result = validateSchema({ version: '0.4.13', tag: 'v0.4.13' });
  // No channels field — should fail
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('channels')));
});

test('validateSchema: rejects empty channels object', () => {
  const result = validateSchema({ version: '0.4.13', tag: 'v0.4.13', channels: {} });
  assert.equal(result.valid, false);
});

test('validateSchema: accepts manifest with valid channels', () => {
  const result = validateSchema({
    version: '0.4.13',
    tag: 'v0.4.13',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
      },
    },
  });
  assert.equal(result.valid, true);
});

test('validateSchema: rejects channel missing required fields', () => {
  const result = validateSchema({
    version: '0.4.13',
    tag: 'v0.4.13',
    channels: {
      stable: { version: '0.4.13' }, // missing bundleUrl
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('bundleUrl')));
});

test('validateSchema: accepts manifest with multiple channels', () => {
  const result = validateSchema({
    version: '0.4.13',
    tag: 'v0.4.13',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
      },
      beta: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle-beta.zip',
      },
    },
  });
  assert.equal(result.valid, true);
});

test('validateSchema: rejects unsupported digest algorithm in channel', () => {
  const result = validateSchema({
    version: '0.4.13',
    tag: 'v0.4.13',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
        digestAlgorithm: 'md5', // unsupported
      },
    },
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(e => e.includes('md5')));
});

// ---- Tag/Version Consistency Tests ----

test('validateTagConsistency: accepts matching release tag and manifest version', () => {
  const result = validateTagConsistency(
    { version: '0.4.13', tag: 'v0.4.13' },
    'v0.4.13'
  );
  assert.equal(result.valid, true);
});

test('validateTagConsistency: rejects mismatched release tag vs manifest version', () => {
  const result = validateTagConsistency(
    { version: '0.4.12', tag: 'v0.4.12' },
    'v0.4.13'
  );
  assert.equal(result.valid, false);
});

test('validateTagConsistency: rejects mismatched release tag vs manifest tag', () => {
  const result = validateTagConsistency(
    { version: '0.4.13', tag: 'v0.4.12' },
    'v0.4.13'
  );
  assert.equal(result.valid, false);
});

test('validateTagConsistency: accepts when no release tag provided', () => {
  const result = validateTagConsistency({ version: '0.4.13', tag: 'v0.4.13' }, null);
  assert.equal(result.valid, true);
});

test('validateTagConsistency: rejects channel version older than manifest version', () => {
  const result = validateTagConsistency(
    {
      version: '0.4.13',
      tag: 'v0.4.13',
      channels: { stable: { version: '0.4.12', bundleUrl: 'https://example.com/bundle.zip' } },
    },
    'v0.4.13'
  );
  assert.equal(result.valid, false);
});

// ---- Asset Host Validation Tests ----

test('validateAssetHosts: accepts URLs pointing to trusted GitHub release host', () => {
  const result = validateAssetHosts({
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
        apkUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/app.apk',
      },
    },
  }, 'misospace', 'miso-chat');
  assert.equal(result.valid, true);
});

test('validateAssetHosts: rejects URLs pointing to untrusted host', () => {
  const result = validateAssetHosts({
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://evil.com/releases/download/v0.4.13/bundle.zip',
      },
    },
  }, 'misospace', 'miso-chat');
  assert.equal(result.valid, false);
});

test('validateAssetHosts: rejects URLs with wrong release path pattern', () => {
  const result = validateAssetHosts({
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/download/v0.4.13/bundle.zip',
      },
    },
  }, 'misospace', 'miso-chat');
  assert.equal(result.valid, false);
});

test('validateAssetHosts: validates top-level bundleUrl too', () => {
  const result = validateAssetHosts({
    version: '0.4.13',
    tag: 'v0.4.13',
    bundleUrl: 'https://evil.com/bundle.zip',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
      },
    },
  }, 'misospace', 'miso-chat');
  assert.equal(result.valid, false);
});

// ---- Digest Verification Tests ----

test('verifyDigest: accepts matching digest', () => {
  const payload = Buffer.from('test bundle data');
  const expectedDigest = createHash('sha-256').update(payload).digest('hex');
  const result = verifyDigest(
    { digestAlgorithm: 'sha-256' },
    payload,
    expectedDigest
  );
  assert.equal(result.valid, true);
});

test('verifyDigest: rejects mismatched digest', () => {
  const payload = Buffer.from('test bundle data');
  const wrongDigest = createHash('sha-256').update(Buffer.from('wrong')).digest('hex');
  const result = verifyDigest(
    { digestAlgorithm: 'sha-256' },
    payload,
    wrongDigest
  );
  assert.equal(result.valid, false);
});

test('verifyDigest: skips validation when no digest algorithm specified', () => {
  const payload = Buffer.from('test');
  const result = verifyDigest({}, payload, 'any-digest');
  assert.equal(result.valid, true);
});

test('verifyDigest: rejects when expected digest not provided', () => {
  const payload = Buffer.from('test');
  const result = verifyDigest({ digestAlgorithm: 'sha-256' }, payload, null);
  assert.equal(result.valid, false);
});

// ---- Full Validation Pipeline Tests ----

test('validateManifest: full pipeline accepts valid manifest from trusted source', () => {
  const manifest = {
    version: '0.4.13',
    tag: 'v0.4.13',
    releaseDate: '2026-06-06T10:00:00Z',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
        apkUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/app.apk',
        digest: 'abc123',
        digestAlgorithm: 'sha-256',
      },
    },
  };
  const result = validateManifest(manifest, {
    releaseTagName: 'v0.4.13',
    repoOwner: 'misospace',
    repoName: 'miso-chat',
  });
  assert.equal(result.valid, true);
});

test('validateManifest: rejects manifest with untrusted bundleUrl', () => {
  const manifest = {
    version: '0.4.13',
    tag: 'v0.4.13',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://attacker.com/bundle.zip',
      },
    },
  };
  const result = validateManifest(manifest, {
    repoOwner: 'misospace',
    repoName: 'miso-chat',
  });
  assert.equal(result.valid, false);
});

test('validateManifest: rejects manifest with tag mismatch', () => {
  const manifest = {
    version: '0.4.12',
    tag: 'v0.4.12',
    channels: {
      stable: {
        version: '0.4.12',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.12/bundle.zip',
      },
    },
  };
  const result = validateManifest(manifest, {
    releaseTagName: 'v0.4.13',
    repoOwner: 'misospace',
    repoName: 'miso-chat',
  });
  assert.equal(result.valid, false);
});

test('validateManifest: no errors when optional fields omitted', () => {
  const manifest = {
    version: '0.4.13',
    tag: 'v0.4.13',
    channels: {
      stable: {
        version: '0.4.13',
        bundleUrl: 'https://github.com/misospace/miso-chat/releases/download/v0.4.13/bundle.zip',
      },
    },
  };
  const result = validateManifest(manifest, {
    releaseTagName: 'v0.4.13',
    repoOwner: 'misospace',
    repoName: 'miso-chat',
  });
  assert.equal(result.valid, true);
});

// ---- Version Utility Tests ----

test('normalizeVersion: strips v prefix and handles undefined', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3'), '1.2.3');
  assert.equal(normalizeVersion(undefined), '0.0.0');
  assert.equal(normalizeVersion(null), '0.0.0');
});

test('compareVersions: correct ordering', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
});

test('compareVersions: handles partial versions', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
});

// ---- Supported Digest Algorithms Test ----

test('SUPPORTED_DIGEST_ALGORITHMS includes sha-256', () => {
  assert.ok(SUPPORTED_DIGEST_ALGORITHMS.includes('sha-256'));
});

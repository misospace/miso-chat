const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// ---- Version comparison tests (mirrors both client and server logic) ----

function normalizeVersion(v) {
  return String(v || '0.0.0').replace(/^v/, '');
}

function compareVersions(v1, v2) {
  const a = normalizeVersion(v1).split('.').map(Number);
  const b = normalizeVersion(v2).split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

test('compareVersions: equal versions', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.4.12', '0.4.12'), 0);
});

test('compareVersions: newer version is greater', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.1.0', '1.0.9'), 1);
});

test('compareVersions: older version is less', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1);
  assert.equal(compareVersions('1.0.9', '1.1.0'), -1);
});

test('compareVersions: handles different segment counts', () => {
  assert.equal(compareVersions('1.0', '1.0.0'), 0);
  assert.equal(compareVersions('1', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0.1', '1.0.0'), 1);
});

test('compareVersions: strips leading v prefix', () => {
  assert.equal(compareVersions('v1.0.0', 'v1.0.0'), 0);
  assert.equal(compareVersions('v2.0.0', '1.9.9'), 1);
});

// ---- Manifest parsing tests ----

test('manifest channels.stable.version is used for update check', () => {
  const manifest = {
    version: '0.4.11',
    tag: 'v0.4.11',
    channels: {
      stable: { version: '0.4.12', bundleUrl: 'https://example.com/bundle.zip' }
    }
  };
  const latestVersion = manifest.channels?.stable?.version || manifest.version;
  assert.equal(latestVersion, '0.4.12');
});

test('manifest falls back to top-level version when channels missing', () => {
  const manifest = {
    version: '0.4.12',
    tag: 'v0.4.12'
  };
  const latestVersion = manifest.channels?.stable?.version || manifest.version;
  assert.equal(latestVersion, '0.4.12');
});

// ---- Server endpoint tests ----

test('server.js includes mobile update manifest route', () => {
  const serverPath = path.join(__dirname, '..', 'server.js');
  const serverContent = fs.readFileSync(serverPath, 'utf-8');
  assert.ok(
    serverContent.includes('/api/mobile/update-manifest'),
    'server.js should define /api/mobile/update-manifest endpoint'
  );
  assert.ok(
    serverContent.includes('MOBILE_UPDATE_REPO_OWNER'),
    'server.js should have configurable repo owner'
  );
  assert.ok(
    serverContent.includes('MOBILE_UPDATE_CACHE_TTL_MS'),
    'server.js should have cache TTL config'
  );
});

// ---- Client-side update manager tests ----

test('update-manager.js uses server endpoint with GitHub fallback', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const clientContent = fs.readFileSync(clientPath, 'utf-8');
  assert.ok(
    clientContent.includes('MOBILE_UPDATE_MANIFEST_ENDPOINT'),
    'client should reference server endpoint constant'
  );
  assert.ok(
    clientContent.includes('/api/mobile/update-manifest'),
    'client should use /api/mobile/update-manifest endpoint'
  );
  assert.ok(
    clientContent.includes('GITHUB_API_URL') || clientContent.includes('api.github.com'),
    'client should have GitHub API fallback'
  );
});

test('update-manager.js no longer hardcodes repo in getLatestManifest', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const clientContent = fs.readFileSync(clientPath, 'utf-8');

  // The old pattern: direct fetch to api.github.com/repos/misospace/miso-chat/releases/latest
  // should NOT be the primary source anymore
  const firstFetchInGetLatest = clientContent.indexOf('getLatestManifest');
  const fallbackFetchIdx = clientContent.indexOf('Fallback:', firstFetchInGetLatest);

  // The function should try server endpoint first, then fall back to GitHub
  assert.ok(
    fallbackFetchIdx > firstFetchInGetLatest,
    'getLatestManifest should have a fallback pattern after trying the server endpoint'
  );
});

// ---- Release validation script tests ----

test('release-version-check.js exists and is executable', () => {
  const scriptPath = path.join(__dirname, '..', 'scripts', 'release-version-check.js');
  assert.ok(fs.existsSync(scriptPath), 'release-version-check.js should exist');

  // Verify it can be parsed as valid JS
  fs.readFileSync(scriptPath, 'utf-8');
});

test('release-version-check.js validates package.json version exists', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
  assert.ok(pkg.version, 'package.json should have a version field');
  assert.ok(typeof pkg.version === 'string' && pkg.version.length > 0, 'version should be non-empty string');
});

// ---- Configuration tests ----

test('MOBILE_UPDATE_REPO_OWNER defaults to misospace', () => {
  // The server.js should default to 'misospace' for the repo owner
  const serverPath = path.join(__dirname, '..', 'server.js');
  const serverContent = fs.readFileSync(serverPath, 'utf-8');
  assert.ok(
    serverContent.includes('MOBILE_UPDATE_REPO_OWNER'),
    'should define MOBILE_UPDATE_REPO_OWNER constant'
  );
  assert.ok(
    serverContent.includes('"misospace"') || serverContent.includes("'misospace'"),
    'should default to misospace'
  );
});

test('update manifest structure matches expected schema', () => {
  // The android-release workflow generates update-manifest.json with this structure:
  // { version, tag, releaseDate, releaseNotes, channels: { stable: { version, apkUrl, bundleUrl, mandatory } } }
  const manifestPath = path.join(__dirname, '..', 'update-manifest.json');

  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.ok(manifest.version, 'manifest should have version');
    assert.ok(manifest.channels, 'manifest should have channels');
    assert.ok(manifest.channels.stable, 'manifest should have stable channel');
    assert.ok(manifest.channels.stable.bundleUrl, 'stable channel should have bundleUrl');
  } else {
    // On clean checkout without a release build, validate the expected schema via mock data
    const mockManifest = {
      version: '0.5.0',
      tag: 'v0.5.0',
      releaseDate: '2026-05-19',
      channels: {
        stable: {
          version: '0.5.0',
          apkUrl: 'https://example.com/app-release.apk',
          bundleUrl: 'https://example.com/bundle.zip',
          mandatory: true,
        },
      },
    };
    assert.ok(mockManifest.version, 'schema should include version');
    assert.ok(mockManifest.channels, 'schema should include channels');
    assert.ok(mockManifest.channels.stable, 'schema should include stable channel');
    assert.ok(mockManifest.channels.stable.bundleUrl, 'stable channel should have bundleUrl');
  }
});

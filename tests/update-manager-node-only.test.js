const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Tests for lib/update-manager.js (server-side, Node-only).
 *
 * Validates that the server-side update manager:
 * - Imports cleanly in Node without @capacitor/core
 * - Exposes expected exports
 * - Always reports isMobilePlatform() === false
 */

test('lib/update-manager.js imports without @capacitor/core', () => {
  // Simulate a require environment where @capacitor/core is not installed.
  // We use a vm sandbox with a custom require that throws for @capacitor/core.
  const modulePath = path.join(__dirname, '..', 'lib', 'update-manager.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');

  const exportsObj = {};
  const sandbox = {
    module: { exports: exportsObj },
    exports: exportsObj,
    require: (id) => {
      if (id === '@capacitor/core') {
        throw new Error("Cannot find module '@capacitor/core'");
      }
      // Forward known builtins
      return Reflect.get(require, id, {});
    },
    console,
    process,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Buffer,
    URL,
    fetch,
    Error,
    TypeError,
    ReferenceError,
    String,
    Number,
    Boolean,
    Object,
    Array,
    Math,
    JSON,
    Promise,
    isNaN,
    parseFloat,
    parseInt,
    undefined,
    // Node.js module system globals
    __filename: modulePath,
    __dirname: path.dirname(modulePath),
  };

  // This must not throw — the module should not require @capacitor/core.
  vm.runInNewContext(moduleSource, {
    ...sandbox,
    module: sandbox.module,
    exports: sandbox.exports,
  });

  assert.ok(exportsObj, 'Module exports should be defined');
});

test('lib/update-manager.js exposes expected exports', () => {
  // Direct import in Node (where @capacitor/core may or may not exist).
  // Since we removed the require('@capacitor/core'), this always works.
  const updateManager = require('../lib/update-manager');

  assert.equal(typeof updateManager.isMobilePlatform, 'function', 'isMobilePlatform should be a function');
  assert.equal(typeof updateManager.getLatestRelease, 'function', 'getLatestRelease should be a function');
  assert.equal(typeof updateManager.getManifestUrlFromRelease, 'function', 'getManifestUrlFromRelease should be a function');
  assert.equal(typeof updateManager.compareVersions, 'function', 'compareVersions should be a function');
  assert.equal(typeof updateManager.checkForUpdate, 'function', 'checkForUpdate should be a function');
  assert.equal(typeof updateManager.initialize, 'function', 'initialize should be a function');
});

test('isMobilePlatform() returns false on server-side Node', () => {
  const { isMobilePlatform } = require('../lib/update-manager');
  assert.equal(isMobilePlatform(), false, 'Server-side module must always report non-mobile');
});

test('compareVersions handles edge cases', () => {
  const { compareVersions } = require('../lib/update-manager');

  assert.equal(compareVersions('1.0.0', '1.0.0'), 0, 'equal versions');
  assert.equal(compareVersions('1.0.0', '2.0.0'), -1, 'v1 < v2');
  assert.equal(compareVersions('2.0.0', '1.0.0'), 1, 'v1 > v2');
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1, 'patch difference');
  assert.equal(compareVersions('0.4.19', '0.4.19'), 0, 'real version equality');
});

test('getManifestUrlFromRelease handles missing assets', () => {
  const { getManifestUrlFromRelease } = require('../lib/update-manager');

  assert.equal(getManifestUrlFromRelease(null), null, 'null release');
  assert.equal(getManifestUrlFromRelease({}), null, 'no assets');
  assert.equal(getManifestUrlFromRelease({ assets: [] }), null, 'empty assets');
});

test('getManifestUrlFromRelease finds manifest asset', () => {
  const { getManifestUrlFromRelease } = require('../lib/update-manager');

  const release = {
    assets: [
      { name: 'app.apk', browser_download_url: 'https://example.com/app.apk' },
      { name: 'update-manifest.json', browser_download_url: 'https://example.com/manifest.json' },
    ],
  };

  const url = getManifestUrlFromRelease(release);
  assert.equal(url, 'https://example.com/manifest.json');
});

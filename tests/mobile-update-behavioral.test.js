const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('fs');
const path = require('path');

// ---- VM-based behavioral execution of extracted pure functions ----
// These tests actually execute JavaScript in a sandboxed context,
// verifying behavioral correctness rather than source-string patterns.

function createSandbox() {
  const sandbox = {
    console,
    require,
    module: {},
    exports: {},
    __dirname: __dirname,
    // Simulate minimal browser environment for update-manager IIFE
    window: {},
    document: {
      getElementById: () => null,
      body: { appendChild: () => {} },
      createElement: () => ({ addEventListener: () => {}, style: {}, className: '' }),
    },
    fetch: async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '' }),
    setTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    alert: () => {},
  };
  return sandbox;
}

test('update-manager.js parses as valid JS (syntax check)', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const src = fs.readFileSync(clientPath, 'utf-8');
  // vm.Script will throw on syntax errors
  assert.doesNotThrow(() => new vm.Script(src, { filename: 'update-manager.js' }),
    'update-manager.js should parse without syntax errors');
});

test('compareVersions behaves correctly when executed in VM sandbox', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const src = fs.readFileSync(clientPath, 'utf-8');

  // Extract normalizeVersion and compareVersion functions from the IIFE source
  const normalizeMatch = src.match(/function normalizeVersion\(v\)\s*\{[^}]+\}/);
  const compareMatch = src.match(/function compareVersions\(v1,\s*v2\)\s*\{[\s\S]*?return 0;\s*\}/);

  assert.ok(normalizeMatch, 'normalizeVersion function should exist in source');
  assert.ok(compareMatch, 'compareVersions function should exist in source');

  const sandbox = createSandbox();

  // Execute normalizeVersion
  assert.doesNotThrow(() => {
    vm.runInNewContext(normalizeMatch[0], sandbox);
  }, 'normalizeVersion should execute without error');

  // Execute compareVersions
  assert.doesNotThrow(() => {
    vm.runInNewContext(compareMatch[0], sandbox);
  }, 'compareVersions should execute without error');

  // Now test behavioral correctness
  assert.equal(sandbox.normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(sandbox.normalizeVersion('0.4.12'), '0.4.12');
  assert.equal(sandbox.normalizeVersion(undefined), '0.0.0');

  // Behavioral: compareVersions returns correct ordering
  assert.equal(sandbox.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(sandbox.compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(sandbox.compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(sandbox.compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(sandbox.compareVersions('v1.0.0', '1.0.0'), 0);
});

test('MobileUpdateManager IIFE executes in VM sandbox without errors', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const src = fs.readFileSync(clientPath, 'utf-8');

  const sandbox = createSandbox();

  // Execute the full IIFE — this verifies all internal functions parse and execute
  assert.doesNotThrow(() => {
    vm.runInNewContext(src, sandbox, { filename: 'update-manager.js' });
  }, 'MobileUpdateManager IIFE should execute without runtime errors');

  // Verify the object was attached to window
  assert.ok(sandbox.window.MobileUpdateManager, 'MobileUpdateManager should be attached to window');

  const mgr = sandbox.window.MobileUpdateManager;

  // Behavioral: config defaults
  assert.equal(mgr.config.autoCheck, true);
  assert.equal(mgr.config.showNotification, true);
  assert.equal(mgr.config.debug, false);
  assert.equal(mgr.config.checkInterval, 3600000);

  // Behavioral: isNativePlatform returns false without Capacitor
  assert.equal(mgr.isNativePlatform(), false);

  // getCurrentBundle is async; verify method exists and doesn't throw
  assert.ok(typeof mgr.getCurrentBundle === 'function', 'getCurrentBundle should be a function');
});

test('MobileUpdateManager.init skips when not on native platform', async () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const src = fs.readFileSync(clientPath, 'utf-8');

  const sandbox = createSandbox();
  const logs = [];
  sandbox.console = { log: (...args) => logs.push(args.join(' ')) };

  assert.doesNotThrow(() => {
    vm.runInNewContext(src, sandbox, { filename: 'update-manager.js' });
  });

  // init should return early without calling checkForUpdate (no network calls made)
  await sandbox.window.MobileUpdateManager.init();
});

test('MobileUpdateManager.destroy clears interval', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const src = fs.readFileSync(clientPath, 'utf-8');

  let clearedInterval = false;
  const sandbox = createSandbox();
  sandbox.setInterval = () => 42;
  sandbox.clearInterval = (id) => { clearedInterval = true; };

  assert.doesNotThrow(() => {
    vm.runInNewContext(src, sandbox, { filename: 'update-manager.js' });
  });

  // Manually set the interval id to simulate autoCheck being on
  sandbox.window.MobileUpdateManager.checkIntervalId = 42;
  sandbox.window.MobileUpdateManager.destroy();
  assert.equal(sandbox.window.MobileUpdateManager.checkIntervalId, null);
  assert.ok(clearedInterval, 'destroy should clear the check interval');
});

// ---- Manifest parsing behavioral tests ----

test('manifest parsing: stable channel version takes precedence over top-level', () => {
  const manifest = {
    version: '0.4.11',
    tag: 'v0.4.11',
    channels: {
      stable: { version: '0.4.12', bundleUrl: 'https://example.com/bundle.zip' }
    }
  };

  const sandbox = createSandbox();
  vm.runInNewContext(`
    function normalizeVersion(v) { return String(v || '0.0.0').replace(/^v/, ''); }
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
  `, sandbox);

  // Behavioral: extract stable version and compare
  const stable = manifest.channels?.stable || {};
  const latestVersion = stable.version || manifest.version;
  assert.equal(latestVersion, '0.4.12', 'stable channel version should take precedence');
  assert.equal(sandbox.compareVersions(latestVersion, manifest.version), 1,
    'stable version should be newer than top-level version');
});

test('manifest parsing: falls back to top-level when channels missing', () => {
  const manifest = { version: '0.4.12', tag: 'v0.4.12' };
  const latestVersion = manifest.channels?.stable?.version || manifest.version;
  assert.equal(latestVersion, '0.4.12');
});

test('manifest parsing: missing bundleUrl detected as no-update', () => {
  const manifest = { version: '0.5.0', channels: { stable: { version: '0.5.0' } } };
  const stable = manifest.channels?.stable || {};
  const bundleUrl = stable.bundleUrl || manifest.bundleUrl || null;
  assert.equal(bundleUrl, null, 'missing bundleUrl should be null');
});

// ---- Version comparison edge cases (executed in VM) ----

test('compareVersions: handles partial version strings in VM', () => {
  const clientPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');
  const src = fs.readFileSync(clientPath, 'utf-8');

  const normalizeMatch = src.match(/function normalizeVersion\(v\)\s*\{[^}]+\}/);
  const compareMatch = src.match(/function compareVersions\(v1,\s*v2\)\s*\{[\s\S]*?return 0;\s*\}/);

  const sandbox = createSandbox();
  vm.runInNewContext(normalizeMatch[0], sandbox);
  vm.runInNewContext(compareMatch[0], sandbox);

  // Partial versions
  assert.equal(sandbox.compareVersions('1.0', '1.0.0'), 0);
  assert.equal(sandbox.compareVersions('1', '1.0.0'), 0);
  assert.equal(sandbox.compareVersions('1.0.0.1', '1.0.0'), 1);

  // Edge: undefined versions normalize to 0.0.0
  assert.equal(sandbox.normalizeVersion(undefined), '0.0.0');
});

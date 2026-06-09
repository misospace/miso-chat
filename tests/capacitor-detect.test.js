const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Tests for lib/capacitor-detect.js
 *
 * Validates that isNativeCapacitor() correctly detects Capacitor native
 * platform and handles edge cases (no window, no Capacitor, etc.).
 */

function createBrowserSandbox() {
  const sandbox = {
    globalThis: {},
    self: {},
    console,
    String,
    Number,
    Boolean,
    Object,
    Array,
    RegExp,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    undefined,
    null: null,
  };

  sandbox.self.globalThis = sandbox.globalThis;
  sandbox.globalThis.self = sandbox.self;

  return sandbox;
}

test('isNativeCapacitor returns false when window is undefined', () => {
  const sandbox = createBrowserSandbox();
  // Remove window from sandbox entirely
  delete sandbox.globalThis.window;

  const modulePath = path.join(__dirname, '..', 'lib', 'capacitor-detect.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  vm.runInNewContext(moduleSource, sandbox);

  assert.equal(sandbox.globalThis.isNativeCapacitor(), false);
});

test('isNativeCapacitor returns false when window.Capacitor is undefined', () => {
  const sandbox = createBrowserSandbox();
  sandbox.globalThis.window = {};

  const modulePath = path.join(__dirname, '..', 'lib', 'capacitor-detect.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  vm.runInNewContext(moduleSource, sandbox);

  assert.equal(sandbox.globalThis.isNativeCapacitor(), false);
});

test('isNativeCapacitor returns false when Capacitor.isNativePlatform is not a function', () => {
  const sandbox = createBrowserSandbox();
  sandbox.globalThis.window = {
    Capacitor: { isNativePlatform: 'not-a-function' },
  };

  const modulePath = path.join(__dirname, '..', 'lib', 'capacitor-detect.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  vm.runInNewContext(moduleSource, sandbox);

  assert.equal(sandbox.globalThis.isNativeCapacitor(), false);
});

test('isNativeCapacitor returns true when Capacitor.isNativePlatform() returns true', () => {
  const sandbox = createBrowserSandbox();
  sandbox.globalThis.window = {
    Capacitor: {
      isNativePlatform: () => true,
    },
  };

  const modulePath = path.join(__dirname, '..', 'lib', 'capacitor-detect.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  vm.runInNewContext(moduleSource, sandbox);

  assert.equal(sandbox.globalThis.isNativeCapacitor(), true);
});

test('isNativeCapacitor returns false when Capacitor.isNativePlatform() returns false', () => {
  const sandbox = createBrowserSandbox();
  sandbox.globalThis.window = {
    Capacitor: {
      isNativePlatform: () => false,
    },
  };

  const modulePath = path.join(__dirname, '..', 'lib', 'capacitor-detect.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  vm.runInNewContext(moduleSource, sandbox);

  assert.equal(sandbox.globalThis.isNativeCapacitor(), false);
});

test('isNativeCapacitor is globally available after loading', () => {
  const sandbox = createBrowserSandbox();

  const modulePath = path.join(__dirname, '..', 'lib', 'capacitor-detect.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');
  vm.runInNewContext(moduleSource, sandbox);

  assert.ok(typeof sandbox.globalThis.isNativeCapacitor === 'function');
});

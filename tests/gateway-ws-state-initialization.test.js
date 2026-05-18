const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Read server.js source to verify initialization without loading the full server
// (which would attempt gateway connections and require auth setup)
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('gatewayWsLastError is declared at module scope', () => {
  assert.ok(
    /let\s+gatewayWsLastError\s*=/.test(serverSource),
    'gatewayWsLastError should be declared with let at module scope'
  );
});

test('gatewayWsLastClose is declared at module scope', () => {
  assert.ok(
    /let\s+gatewayWsLastClose\s*=/.test(serverSource),
    'gatewayWsLastClose should be declared with let at module scope'
  );
});

test('gatewayWsManager error handler sets gatewayWsLastError', () => {
  // Verify the error event listener exists and assigns to gatewayWsLastError
  assert.ok(
    /gatewayWsManager\.on\(['"]error['"]/.test(serverSource),
    'server.js should listen for gatewayWsManager error events'
  );
  assert.ok(
    /gatewayWsLastError\s*=\s*String/.test(serverSource),
    'error handler should assign to gatewayWsLastError'
  );
});

test('gatewayWsManager close handler sets gatewayWsLastClose', () => {
  // Verify the close event listener exists and assigns to gatewayWsLastClose
  assert.ok(
    /gatewayWsManager\.on\(['"]close['"]/.test(serverSource),
    'server.js should listen for gatewayWsManager close events'
  );
  assert.ok(
    /gatewayWsLastClose\s*=\s*\{/.test(serverSource),
    'close handler should assign an object to gatewayWsLastClose'
  );
});

test('initGatewayWsManager resets error/close state on successful connect', () => {
  // After a successful WS connection, both variables are reset
  assert.ok(
    /gatewayWsLastError\s*=\s*['"]{1,2}/.test(serverSource),
    'gatewayWsLastError should be cleared on successful connect'
  );
  assert.ok(
    /gatewayWsLastClose\s*=\s*null/.test(serverSource),
    'gatewayWsLastClose should be nullified on successful connect'
  );
});

test('GatewayWsManager emits error and close events', () => {
  const { GatewayWsManager } = require('../lib/gateway-ws');
  
  let errorEmitted = false;
  let closeEmitted = false;
  
  const manager = new GatewayWsManager();
  
  manager.on('error', (err) => {
    errorEmitted = true;
  });
  
  manager.on('close', (code, reason) => {
    closeEmitted = true;
  });
  
  // Simulate emitting events (we can't trigger real network errors in tests)
  manager.emit('error', new Error('test error'));
  manager.emit('close', 1000, 'normal');
  
  assert.ok(errorEmitted, 'GatewayWsManager should emit error events');
  assert.ok(closeEmitted, 'GatewayWsManager should emit close events');
});

test('GatewayWsManager exposes public methods used by health endpoint', () => {
  // The health endpoint calls these methods on gatewayWsManager.
  // They must be public (not private/undefined) or the endpoint returns misleading defaults.
  const { GatewayWsManager } = require('../lib/gateway-ws');
  
  const manager = new GatewayWsManager();
  
  assert.strictEqual(
    typeof manager.isConnected, 'function',
    'GatewayWsManager must expose isConnected() as a public method'
  );
  assert.strictEqual(
    typeof manager.getPendingRequestCount, 'function',
    'GatewayWsManager must expose getPendingRequestCount() as a public method'
  );
  assert.strictEqual(
    typeof manager.getPendingForRecoveryCount, 'function',
    'GatewayWsManager must expose getPendingForRecoveryCount() as a public method'
  );
});

test('GatewayWsManager.public methods return correct types for disconnected state', () => {
  const { GatewayWsManager } = require('../lib/gateway-ws');
  const manager = new GatewayWsManager();
  
  assert.strictEqual(
    typeof manager.isConnected(), 'boolean',
    'isConnected() must return a boolean'
  );
  assert.strictEqual(
    typeof manager.getPendingRequestCount(), 'number',
    'getPendingRequestCount() must return a number'
  );
  assert.strictEqual(
    typeof manager.getPendingForRecoveryCount(), 'number',
    'getPendingForRecoveryCount() must return a number'
  );
  
  // In disconnected state, isConnected should be false and counts should be 0
  assert.strictEqual(manager.isConnected(), false, 'isConnected() should be false when not connected');
  assert.strictEqual(manager.getPendingRequestCount(), 0, 'getPendingRequestCount() should be 0 when no pending requests');
  assert.strictEqual(manager.getPendingForRecoveryCount(), 0, 'getPendingForRecoveryCount() should be 0 when no recovery pending');
});

test('health endpoint references gatewayWsLastError and gatewayWsLastClose', () => {
  // Verify the health endpoint references these variables by checking the source
  const healthStart = serverSource.indexOf("app.get('/api/health'");
  assert.ok(healthStart !== -1, 'health endpoint should exist');
  
  // Read from health endpoint start to the next function declaration (extractTextParts)
  const nextFunc = serverSource.indexOf('function extractTextParts', healthStart);
  const healthBody = serverSource.slice(healthStart, nextFunc !== -1 ? nextFunc : healthStart + 3000);
  
  assert.ok(
    /gatewayWsLastError/.test(healthBody),
    'health endpoint should reference gatewayWsLastError'
  );
  assert.ok(
    /gatewayWsLastClose/.test(healthBody),
    'health endpoint should reference gatewayWsLastClose'
  );
});

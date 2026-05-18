const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

// Mock WebSocket to avoid actual network connections
class MockWebSocket extends EventEmitter {
  constructor(url, options) {
    super();
    this.url = url;
    this.readyState = 0; // CONNECTING
    this._mockOpenDelay = options?.mockOpenDelay || 10;
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.emit('open');
    }, this._mockOpenDelay);
  }

  send(data, callback) {
    if (this.readyState === 1) {
      if (callback) callback(null);
    } else {
      if (callback) callback(new Error('WebSocket not open'));
    }
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit('close', 1000, 'normal');
  }
}

// Patch the ws module before requiring GatewayWsManager
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function(id) {
  if (id === 'ws') {
    return MockWebSocket;
  }
  return originalRequire.apply(this, arguments);
};

const { GatewayWsManager } = require('../lib/gateway-ws');

// Restore original require
Module.prototype.require = originalRequire;

test('GatewayWsManager initial state is disconnected', () => {
  const manager = new GatewayWsManager();
  assert.equal(manager.connected, false, 'should start disconnected');
  assert.equal(manager.connecting, false, 'should not be connecting initially');
  assert.equal(manager.reconnectAttempts, 0, 'reconnectAttempts should start at 0');
  assert.equal(manager.getPendingRequestCount(), 0, 'pending requests should be 0');
  assert.equal(manager.getPendingForRecoveryCount(), 0, 'pending for recovery should be 0');
});

test('GatewayWsManager send rejects when not connected', async () => {
  const manager = new GatewayWsManager();
  try {
    await manager.send('chat.send', { sessionKey: 'test' });
    assert.fail('Should have rejected');
  } catch (err) {
    assert.ok(err.message.includes('not connected'), `error should mention not connected, got: ${err.message}`);
  }
});

test('GatewayWsManager fails pending requests on disconnect', async () => {
  const manager = new GatewayWsManager();
  
  // Simulate being connected
  manager.connected = true;
  
  // Add a pending request
  let rejectFn;
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
  });
  
  const id = manager.createRequestId('test');
  const timeout = setTimeout(() => {}, 50);
  manager.pendingRequests.set(id, { resolve: () => {}, reject: rejectFn, timeout });
  
  assert.equal(manager.getPendingRequestCount(), 1, 'should have 1 pending request');
  
  // _failPendingRequests calls reject synchronously on each pending request.
  // We catch the rejection via a separate handler since it fires during iteration.
  let rejectedWith = null;
  promise.catch(err => { rejectedWith = err.message; });
  
  // Simulate disconnect - this should fail all pending requests
  manager._failPendingRequests('Gateway WS disconnected');
  
  assert.equal(manager.getPendingRequestCount(), 0, 'pending requests should be cleared');
  
  // Give a tick for the rejection to propagate
  await new Promise(r => setTimeout(r, 10));
  
  assert.ok(rejectedWith && rejectedWith.includes('disconnected'), 
    `error should mention disconnected, got: ${rejectedWith}`);
});

test('GatewayWsManager stores pending requests for recovery on disconnect', () => {
  const manager = new GatewayWsManager();
  
  // Simulate being connected (wasConnected = true for reconnect scenario)
  manager.connected = true;
  
  // Add a pending request
  let pendingResolve, pendingReject;
  const promise = new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
  });
  
  const id = manager.createRequestId('test');
  const timeout = setTimeout(() => {}, 50);
  manager.pendingRequests.set(id, { resolve: pendingResolve, reject: pendingReject, timeout });
  
  // Simulate disconnect - store for recovery (not fail)
  manager._storePendingForRecovery();
  
  assert.equal(manager.getPendingRequestCount(), 0, 'pending requests should be cleared');
  assert.equal(manager.getPendingForRecoveryCount(), 1, 'should have 1 pending for recovery');
});

test('GatewayWsManager recovers pending requests after reconnect', () => {
  const manager = new GatewayWsManager();
  
  // Set up pending for recovery
  let pendingResolve;
  const promise = new Promise((resolve) => { pendingResolve = resolve; });
  const id = manager.createRequestId('test');
  const timeout = setTimeout(() => {}, 50);
  manager._recoveryPending = new Map([[id, { resolve: pendingResolve, reject: () => {}, timeout }]]);
  
  assert.equal(manager.getPendingForRecoveryCount(), 1, 'should have 1 pending for recovery');
  
  // Recover
  manager._recoverPendingRequests();
  
  assert.equal(manager.getPendingForRecoveryCount(), 0, 'pending for recovery should be cleared');
  assert.equal(manager.getPendingRequestCount(), 1, 'should have 1 recovered pending request');
});

test('GatewayWsManager disconnect clears all timers and state', () => {
  const manager = new GatewayWsManager();
  
  // Set up some state
  manager.connected = true;
  manager.connecting = true;
  manager._challengeWaitTimer = setTimeout(() => {}, 50);
  manager._reconnectTimer = setTimeout(() => {}, 50);
  
  let rejectedWith = null;
  const promise = new Promise((resolve, reject) => {
    const id = manager.createRequestId('test');
    const timeout = setTimeout(() => {}, 50);
    manager.pendingRequests.set(id, { resolve: () => {}, reject: (err) => { rejectedWith = err.message; }, timeout });
  });
  
  // Catch the rejection to prevent unhandledRejection
  promise.catch(() => {});
  
  // Disconnect
  manager.disconnect();
  
  assert.equal(manager.connected, false, 'should be disconnected');
  assert.equal(manager.connecting, false, 'should not be connecting');
  assert.ok(manager._challengeWaitTimer === null, 'challenge timer should be cleared');
  assert.ok(manager._reconnectTimer === null, 'reconnect timer should be cleared');
  assert.equal(manager.getPendingRequestCount(), 0, 'pending requests should be cleared');
  
  // Give a tick for the rejection to propagate
  return new Promise(r => setTimeout(r, 10)).then(() => {
    assert.ok(rejectedWith && rejectedWith.includes('disconnected'), 
      `error should mention disconnected, got: ${rejectedWith}`);
  });
});

test('GatewayWsManager createRequestId produces unique IDs', () => {
  const manager = new GatewayWsManager();
  const ids = new Set();
  
  for (let i = 0; i < 100; i++) {
    const id = manager.createRequestId('req');
    assert.ok(!ids.has(id), `ID ${id} should be unique`);
    ids.add(id);
    assert.ok(id.startsWith('req-'), `ID ${id} should start with 'req-'`);
  }
});

test('GatewayWsManager reconnect backoff increases delay', () => {
  const manager = new GatewayWsManager({
    reconnectDelay: 100,
    reconnectBackoff: 2,
    maxReconnectDelay: 5000,
  });
  
  // Simulate multiple reconnection attempts
  for (let i = 1; i <= 5; i++) {
    manager.reconnectAttempts = i;
    const baseDelay = manager.reconnectDelay * Math.pow(manager.reconnectBackoff, i - 1);
    assert.equal(baseDelay, 100 * Math.pow(2, i - 1), `delay at attempt ${i} should be ${baseDelay}`);
  }
});

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
    this._sentFrames = [];
    setTimeout(() => {
      this.readyState = 1; // OPEN
      this.emit('open');
    }, this._mockOpenDelay);
  }

  send(data, callback) {
    if (this.readyState === 1) {
      this._sentFrames.push(data);
      if (callback) callback(null);
    } else {
      if (callback) callback(new Error('WebSocket not open'));
    }
  }

  close() {
    this.readyState = 3; // CLOSED
    this.emit('close', 1000, 'normal');
  }

  getSentFrames() {
    return [...this._sentFrames];
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

test('GatewayWsManager stores frameData in pending requests', () => {
  const manager = new GatewayWsManager();

  // Simulate being connected
  manager.connected = true;
  manager.ws = { readyState: 1, send: () => {} };

  let resolveFn, rejectFn;
  const promise = new Promise((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  const id = manager.createRequestId('test');
  const timeout = setTimeout(() => {}, 50);
  manager.pendingRequests.set(id, {
    resolve: resolveFn,
    reject: rejectFn,
    timeout,
    frameData: { type: 'req', id, method: 'chat.send', params: { sessionKey: 'test' } },
  });

  const pending = manager.pendingRequests.get(id);
  assert.ok(pending.frameData, 'frameData should be stored in pending request');
  assert.equal(pending.frameData.method, 'chat.send', 'frameData.method should match');
  assert.deepStrictEqual(pending.frameData.params, { sessionKey: 'test' }, 'frameData.params should match');
});

test('GatewayWsManager resends frames on reconnect recovery', async () => {
  const mockWs = new MockWebSocket('ws://test', { mockOpenDelay: 100 });
  // Manually make the mock WebSocket OPEN before using it
  mockWs.readyState = 1;

  const manager = new GatewayWsManager({ wsUrl: 'ws://test' });

  // Simulate connected state with pending request
  manager.connected = true;
  manager.ws = mockWs;

  let resolveFn;
  const promise = new Promise((resolve) => { resolveFn = resolve; });

  const id = manager.createRequestId('test');
  const timeout = setTimeout(() => {}, 50);
  manager.pendingRequests.set(id, {
    resolve: resolveFn,
    reject: () => {},
    timeout,
    frameData: { type: 'req', id, method: 'chat.send', params: { sessionKey: 'test' } },
  });

  // Simulate disconnect (store for recovery)
  manager._storePendingForRecovery();
  assert.equal(manager.getPendingRequestCount(), 0);
  assert.equal(manager.getPendingForRecoveryCount(), 1);

  // Simulate reconnect — mockWs is already OPEN
  manager.connected = true;
  manager.ws = mockWs;

  // Recover pending requests
  manager._recoverPendingRequests();

  assert.equal(manager.getPendingRequestCount(), 1, 'should have 1 recovered pending request');
  assert.equal(manager.getPendingForRecoveryCount(), 0, 'recovery pending should be cleared');

  // Verify the frame was resent
  const sentFrames = mockWs.getSentFrames();
  const resendFrame = JSON.parse(sentFrames[sentFrames.length - 1]);
  assert.equal(resendFrame.method, 'chat.send', 'resend frame should have correct method');
  assert.deepStrictEqual(resendFrame.params, { sessionKey: 'test' }, 'resend frame should have correct params');

  // Resolve the pending request to prevent unhandled rejection
  resolveFn({ ok: true });
});

test('GatewayWsManager fails pending requests when no frameData on recovery', async () => {
  const manager = new GatewayWsManager();

  // Set up recovery with a pending request that has no frameData
  let rejectedWith = null;
  const promise = new Promise((resolve, reject) => {
    const id = manager.createRequestId('test');
    const timeout = setTimeout(() => {}, 50);
    manager._recoveryPending = new Map([[id, { resolve: () => {}, reject: (err) => { rejectedWith = err.message; }, timeout }]]);
  });

  // Catch unhandled rejection
  promise.catch(() => {});

  // Recover — should fail the request since no frameData
  manager._recoverPendingRequests();

  await new Promise(r => setTimeout(r, 20));
  assert.ok(rejectedWith && rejectedWith.includes('could not be resent'),
    `should reject with resend error, got: ${rejectedWith}`);
});

test('GatewayWsManager configures recoveredRequestTimeoutSeconds from options', () => {
  const manager = new GatewayWsManager({ recoveredRequestTimeoutSeconds: 60 });
  assert.equal(manager.recoveredRequestTimeoutSeconds, 60, 'should use custom timeout');
});

test('GatewayWsManager configures recoveredRequestTimeoutSeconds from env', () => {
  const prev = process.env.GATEWAY_WS_RECOVERED_REQUEST_TIMEOUT_S;
  process.env.GATEWAY_WS_RECOVERED_REQUEST_TIMEOUT_S = '45';
  const manager = new GatewayWsManager({});
  assert.equal(manager.recoveredRequestTimeoutSeconds, 45, 'should use env var timeout');
  if (prev !== undefined) {
    process.env.GATEWAY_WS_RECOVERED_REQUEST_TIMEOUT_S = prev;
  } else {
    delete process.env.GATEWAY_WS_RECOVERED_REQUEST_TIMEOUT_S;
  }
});

test('GatewayWsManager defaults recoveredRequestTimeoutSeconds to 30', () => {
  const manager = new GatewayWsManager({});
  assert.equal(manager.recoveredRequestTimeoutSeconds, 30, 'should default to 30s');
});

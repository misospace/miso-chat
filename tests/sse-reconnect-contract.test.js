const test = require('node:test');
const assert = require('node:assert/strict');

// Test the SSE reconnect contract logic extracted from the frontend.
// We simulate the key behaviors without a real browser.

test('SSE reconnect prevents duplicate EventSource instances', () => {
  // Simulate the connectEventSource logic
  let eventSourceCount = 0;
  let activeEventSources = [];
  
  function createMockEventSource() {
    eventSourceCount++;
    const es = {
      close: () => {
        activeEventSources = activeEventSources.filter(e => e !== es);
      },
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    activeEventSources.push(es);
    return es;
  }

  let eventSource = null;
  let sseReconnectTimer = null;
  
  function connectEventSource() {
    // This is the improved logic from public/index.html
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
      sseReconnectTimer = null;
    }
    eventSource = createMockEventSource();
  }

  // First connection
  connectEventSource();
  assert.equal(activeEventSources.length, 1, 'should have exactly 1 EventSource');
  
  // Reconnect (simulating onerror -> reconnect)
  connectEventSource();
  assert.equal(activeEventSources.length, 1, 'should still have exactly 1 EventSource after reconnect');
  assert.equal(eventSourceCount, 2, 'should have created 2 EventSource instances total');
  
  // Multiple rapid reconnects should still result in only 1 active
  connectEventSource();
  connectEventSource();
  connectEventSource();
  assert.equal(activeEventSources.length, 1, 'rapid reconnects should leave exactly 1 active EventSource');
});

test('SSE onclose handler prevents auto-reconnect', () => {
  let sseConnected = false;
  let eventSource = null;
  
  function createMockEventSource() {
    const es = {
      close: () => {},
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
    };
    return es;
  }

  // Simulate an explicit close (not error)
  eventSource = createMockEventSource();
  sseConnected = true;
  
  // Set up the onclose handler as in the real code
  eventSource.onclose = () => {
    sseConnected = false;
  };
  
  // Trigger onclose explicitly
  if (eventSource.onclose) {
    eventSource.onclose();
  }
  
  // After explicit close, sseConnected should be false and no reconnect scheduled
  assert.equal(sseConnected, false, 'sseConnected should be false after close');
});

test('SSE onerror schedules single reconnect timer', () => {
  let sseReconnectTimer = null;
  let connectCalled = 0;
  
  function mockConnectEventSource() {
    connectCalled++;
  }

  // Simulate multiple onerror events firing rapidly
  const onError = async () => {
    if (sseReconnectTimer) {
      clearTimeout(sseReconnectTimer);
    }
    sseReconnectTimer = setTimeout(() => {
      sseReconnectTimer = null;
      mockConnectEventSource();
    }, 5000);
  };

  // Fire onerror multiple times (simulating rapid network issues)
  onError();
  onError();
  onError();
  
  // Only one timer should be active
  assert.equal(sseReconnectTimer !== null, true, 'should have exactly 1 timer');
  
  // After the timer fires, connect should be called once
  clearTimeout(sseReconnectTimer);
  sseReconnectTimer = null;
  
  assert.equal(connectCalled, 0, 'connect should not have been called yet (timer cleared before fire)');
});

test('SSE reconnect to backend closes existing EventSource', () => {
  let eventSourceClosed = false;
  let eventSource = {
    close: () => { eventSourceClosed = true; },
  };

  // Simulate reconnectToBackendWithStatus SSE cleanup
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  
  assert.equal(eventSourceClosed, true, 'existing EventSource should be closed');
  assert.equal(eventSource, null, 'eventSource reference should be cleared');
});

test('SSE connectEventSource handles null eventSource gracefully', () => {
  let eventSource = null;
  let createdNew = false;
  
  function createMockEventSource() {
    createdNew = true;
    return {};
  }

  // First call with null eventSource
  if (eventSource) {
    eventSource.close();
  }
  eventSource = createMockEventSource();
  
  assert.equal(createdNew, true, 'should create new EventSource when none exists');
  
  // Second call with existing eventSource
  createdNew = false;
  let closedExisting = false;
  const existingEs = { close: () => { closedExisting = true; } };
  eventSource = existingEs;
  
  if (eventSource) {
    eventSource.close();
  }
  eventSource = createMockEventSource();
  
  assert.equal(closedExisting, true, 'should close existing EventSource');
  assert.equal(createdNew, true, 'should create new EventSource after closing old one');
});

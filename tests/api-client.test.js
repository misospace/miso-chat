const test = require('node:test');
const assert = require('node:assert/strict');

const { isRetryableSendStatus, isStateChangingMethod } = require('../public/lib/api-client');

test('send queue retries only transient HTTP failures', () => {
  for (const status of [408, 425, 429, 500, 502, 503]) {
    assert.equal(isRetryableSendStatus(status), true, `${status} should be retryable`);
  }

  for (const status of [0, 400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableSendStatus(status), false, `${status} should not be retryable`);
  }
});

test('isStateChangingMethod returns true for POST, PUT, PATCH, DELETE', () => {
  assert.equal(isStateChangingMethod('POST'), true);
  assert.equal(isStateChangingMethod('PUT'), true);
  assert.equal(isStateChangingMethod('PATCH'), true);
  assert.equal(isStateChangingMethod('DELETE'), true);
});

test('isStateChangingMethod returns false for safe methods', () => {
  assert.equal(isStateChangingMethod('GET'), false);
  assert.equal(isStateChangingMethod('HEAD'), false);
  assert.equal(isStateChangingMethod('OPTIONS'), false);
});

test('isStateChangingMethod is case-insensitive', () => {
  assert.equal(isStateChangingMethod('post'), true);
  assert.equal(isStateChangingMethod('Post'), true);
  assert.equal(isStateChangingMethod('delete'), true);
  assert.equal(isStateChangingMethod('get'), false);
});

test('isStateChangingMethod defaults to GET for undefined/null', () => {
  assert.equal(isStateChangingMethod(undefined), false);
  assert.equal(isStateChangingMethod(null), false);
});

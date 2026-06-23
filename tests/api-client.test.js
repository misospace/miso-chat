const test = require('node:test');
const assert = require('node:assert/strict');

const { isRetryableSendStatus } = require('../public/lib/api-client');

test('send queue retries only transient HTTP failures', () => {
  for (const status of [408, 425, 429, 500, 502, 503]) {
    assert.equal(isRetryableSendStatus(status), true, `${status} should be retryable`);
  }

  for (const status of [0, 400, 401, 403, 404, 409, 422]) {
    assert.equal(isRetryableSendStatus(status), false, `${status} should not be retryable`);
  }
});

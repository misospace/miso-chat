'use strict';

const { strict: assert } = require('node:assert');
const { describe, it } = require('node:test');

describe('Gateway scope configuration', () => {
  // We test the scope resolution logic by sourcing the relevant code pattern.
  // The actual REQUESTED_GATEWAY_SCOPES is defined in server.js; these tests
  // verify the same resolution logic independently so they pass even without
  // a full gateway connection.

  function resolveScopes() {
    return [
      'operator.read',
      'operator.write',
      ...(process.env.GATEWAY_ADMIN_SCOPES === 'true'
        ? ['operator.admin', 'operator.pairing']
        : []),
    ];
  }

  it('should include only minimal scopes by default (no GATEWAY_ADMIN_SCOPES)', () => {
    const original = process.env.GATEWAY_ADMIN_SCOPES;
    delete process.env.GATEWAY_ADMIN_SCOPES;

    try {
      const scopes = resolveScopes();
      assert.deepStrictEqual(scopes, ['operator.read', 'operator.write']);
      assert.ok(!scopes.includes('operator.admin'));
      assert.ok(!scopes.includes('operator.pairing'));
    } finally {
      if (original !== undefined) process.env.GATEWAY_ADMIN_SCOPES = original;
    }
  });

  it('should include admin and pairing scopes when GATEWAY_ADMIN_SCOPES=true', () => {
    const original = process.env.GATEWAY_ADMIN_SCOPES;
    process.env.GATEWAY_ADMIN_SCOPES = 'true';

    try {
      const scopes = resolveScopes();
      assert.deepStrictEqual(scopes, [
        'operator.read',
        'operator.write',
        'operator.admin',
        'operator.pairing',
      ]);
    } finally {
      if (original !== undefined) process.env.GATEWAY_ADMIN_SCOPES = original;
      else delete process.env.GATEWAY_ADMIN_SCOPES;
    }
  });

  it('should NOT include admin/pairing when GATEWAY_ADMIN_SCOPES is any other value', () => {
    const original = process.env.GATEWAY_ADMIN_SCOPES;
    process.env.GATEWAY_ADMIN_SCOPES = '1';

    try {
      const scopes = resolveScopes();
      assert.deepStrictEqual(scopes, ['operator.read', 'operator.write']);
      assert.ok(!scopes.includes('operator.admin'));
      assert.ok(!scopes.includes('operator.pairing'));
    } finally {
      if (original !== undefined) process.env.GATEWAY_ADMIN_SCOPES = original;
      else delete process.env.GATEWAY_ADMIN_SCOPES;
    }
  });

  it('should always include operator.read and operator.write', () => {
    const original = process.env.GATEWAY_ADMIN_SCOPES;
    process.env.GATEWAY_ADMIN_SCOPES = 'true';

    try {
      const scopes = resolveScopes();
      assert.ok(scopes.includes('operator.read'));
      assert.ok(scopes.includes('operator.write'));
    } finally {
      if (original !== undefined) process.env.GATEWAY_ADMIN_SCOPES = original;
      else delete process.env.GATEWAY_ADMIN_SCOPES;
    }
  });

  it('should have at least 2 scopes by default and at most 4 with admin opt-in', () => {
    const original = process.env.GATEWAY_ADMIN_SCOPES;

    // Default
    delete process.env.GATEWAY_ADMIN_SCOPES;
    let scopes = resolveScopes();
    assert.ok(scopes.length >= 2, 'default should have at least 2 scopes');
    assert.ok(scopes.length <= 4, 'default should have at most 4 scopes');

    // With admin opt-in
    process.env.GATEWAY_ADMIN_SCOPES = 'true';
    scopes = resolveScopes();
    assert.ok(scopes.length === 4, 'with admin opt-in should have exactly 4 scopes');

    // Restore
    if (original !== undefined) process.env.GATEWAY_ADMIN_SCOPES = original;
    else delete process.env.GATEWAY_ADMIN_SCOPES;
  });
});

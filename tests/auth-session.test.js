const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../lib/auth-session.js');

describe('parseBooleanEnv', () => {
  it('returns true for truthy strings', () => {
    assert.equal(mod.parseBooleanEnv('true'), true);
    assert.equal(mod.parseBooleanEnv('1'), true);
    assert.equal(mod.parseBooleanEnv('yes'), true);
  });

  it('returns false for falsy strings', () => {
    assert.equal(mod.parseBooleanEnv('false'), false);
    assert.equal(mod.parseBooleanEnv('0'), false);
    assert.equal(mod.parseBooleanEnv('no'), false);
  });

  it('falls back to provided default when value is empty or undefined', () => {
    assert.equal(mod.parseBooleanEnv(undefined, true), true);
    assert.equal(mod.parseBooleanEnv('', false), false);
    assert.equal(mod.parseBooleanEnv(undefined, false), false);
  });

  it('returns undefined when no fallback provided and value is missing', () => {
    assert.equal(mod.parseBooleanEnv(undefined), undefined);
    assert.equal(mod.parseBooleanEnv(''), undefined);
  });
});

describe('parseSameSiteEnv', () => {
  it('returns valid same-site values case-insensitively', () => {
    assert.equal(mod.parseSameSiteEnv('lax'), 'lax');
    assert.equal(mod.parseSameSiteEnv('LAX'), 'lax');
    assert.equal(mod.parseSameSiteEnv('strict'), 'strict');
    assert.equal(mod.parseSameSiteEnv('none'), 'none');
  });

  it('falls back to provided default for invalid values', () => {
    assert.equal(mod.parseSameSiteEnv('invalid', 'lax'), 'lax');
    assert.equal(mod.parseSameSiteEnv(undefined, 'strict'), 'strict');
    assert.equal(mod.parseSameSiteEnv('', 'none'), 'none');
  });

  it('returns undefined when no fallback provided and value is missing', () => {
    assert.equal(mod.parseSameSiteEnv(undefined), undefined);
    assert.equal(mod.parseSameSiteEnv(''), undefined);
    assert.equal(mod.parseSameSiteEnv('bogus'), undefined);
  });
});

describe('getReturnTo', () => {
  it('returns the return_to value when it is a safe relative path', () => {
    assert.equal(
      mod.getReturnTo({ query: { return_to: '/dashboard' } }, '/'),
      '/dashboard',
    );
    assert.equal(
      mod.getReturnTo({ query: { return_to: '/rooms/general' } }, '/'),
      '/rooms/general',
    );
  });

  it('returns the default fallback when no return_to is provided', () => {
    assert.equal(mod.getReturnTo({}, '/default'), '/default');
    assert.equal(mod.getReturnTo({ query: {} }, '/fallback'), '/fallback');
  });

  it('rejects dangerous protocols (javascript, data, file)', () => {
    assert.equal(
      mod.getReturnTo({ query: { return_to: 'javascript:alert(1)' } }, '/safe'),
      '/safe',
    );
    assert.equal(
      mod.getReturnTo({ query: { return_to: 'data:text/html,<script>' } }, '/safe'),
      '/safe',
    );
    assert.equal(
      mod.getReturnTo({ query: { return_to: 'file:///etc/passwd' } }, '/safe'),
      '/safe',
    );
  });

  it('normalizes path traversal sequences', () => {
    const result = mod.getReturnTo(
      { query: { return_to: '/../../etc/passwd' } },
      '/safe',
    );
    assert.ok(
      !result.includes('..'),
      'Path traversal should be normalized out',
    );
  });

  it('rejects null bytes in the path', () => {
    const result = mod.getReturnTo(
      { query: { return_to: '/dashboard%00.png' } },
      '/safe',
    );
    assert.ok(
      !result.includes('\0'),
      'Null bytes should not appear in normalized path',
    );
  });
});

describe('getOidcLabel', () => {
  const saveEnv = {
    OIDC_ISSUER_LABEL: process.env.OIDC_ISSUER_LABEL,
    OIDC_PROVIDER_NAME: process.env.OIDC_PROVIDER_NAME,
    OIDC_ISSUER: process.env.OIDC_ISSUER,
  };

  function clearOidcEnv() {
    Object.keys(saveEnv).forEach((k) => {
      if (saveEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saveEnv[k];
      }
    });
  }

  it('returns OIDC_ISSUER_LABEL when set', () => {
    process.env.OIDC_ISSUER_LABEL = 'My Provider';
    delete process.env.OIDC_PROVIDER_NAME;
    delete process.env.OIDC_ISSUER;
    try {
      assert.equal(mod.getOidcLabel(), 'My Provider');
    } finally {
      clearOidcEnv();
    }
  });

  it('falls back to OIDC_PROVIDER_NAME when OIDC_ISSUER_LABEL is not set', () => {
    delete process.env.OIDC_ISSUER_LABEL;
    process.env.OIDC_PROVIDER_NAME = 'Provider Name';
    delete process.env.OIDC_ISSUER;
    try {
      assert.equal(mod.getOidcLabel(), 'Provider Name');
    } finally {
      clearOidcEnv();
    }
  });

  it('derives label from OIDC_ISSUER hostname when neither label is set', () => {
    delete process.env.OIDC_ISSUER_LABEL;
    delete process.env.OIDC_PROVIDER_NAME;
    process.env.OIDC_ISSUER = 'https://accounts.example.com/auth';
    try {
      assert.equal(mod.getOidcLabel(), 'accounts.example.com');
    } finally {
      clearOidcEnv();
    }
  });

  it('defaults to "OIDC" when no issuer info is provided', () => {
    delete process.env.OIDC_ISSUER_LABEL;
    delete process.env.OIDC_PROVIDER_NAME;
    delete process.env.OIDC_ISSUER;
    try {
      assert.equal(mod.getOidcLabel(), 'OIDC');
    } finally {
      clearOidcEnv();
    }
  });
});

describe('buildSessionConfig', () => {
  const saveEnv = {
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL,
    SESSION_SECRET: process.env.SESSION_SECRET,
    SESSION_COOKIE_SECURE: process.env.SESSION_COOKIE_SECURE,
    SESSION_COOKIE_SAMESITE: process.env.SESSION_COOKIE_SAMESITE,
    ALLOW_MEMORY_STORE: process.env.ALLOW_MEMORY_STORE,
  };

  function clearEnv() {
    Object.keys(saveEnv).forEach((k) => {
      if (saveEnv[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saveEnv[k];
      }
    });
  }

  it('returns correct defaults in non-production mode', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
    delete process.env.SESSION_SECRET;
    delete process.env.SESSION_COOKIE_SECURE;
    delete process.env.SESSION_COOKIE_SAMESITE;
    delete process.env.ALLOW_MEMORY_STORE;

    const config = mod.buildSessionConfig({ authMode: 'local' });

    assert.equal(config.secret, 'dev-secret-change-in-production');
    assert.equal(config.resave, false);
    assert.equal(config.saveUninitialized, false);
    assert.equal(config.cookie.httpOnly, true);
    assert.equal(config.cookie.secure, false);
    assert.equal(config.cookie.sameSite, 'strict');
    assert.equal(config.cookie.maxAge, 86400000);
    assert.equal(config.store, undefined);

    clearEnv();
  });

  it('uses lax sameSite for OIDC auth mode', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
    delete process.env.SESSION_COOKIE_SAMESITE;

    const config = mod.buildSessionConfig({ authMode: 'oidc' });

    assert.equal(config.cookie.sameSite, 'lax');

    clearEnv();
  });

  it('respects SESSION_COOKIE_SECURE environment variable', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;

    process.env.SESSION_COOKIE_SECURE = 'true';
    let config = mod.buildSessionConfig({ authMode: 'local' });
    assert.equal(config.cookie.secure, true);

    process.env.SESSION_COOKIE_SECURE = 'false';
    config = mod.buildSessionConfig({ authMode: 'local' });
    assert.equal(config.cookie.secure, false);

    clearEnv();
  });

  it('respects SESSION_COOKIE_SAMESITE environment variable', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;

    process.env.SESSION_COOKIE_SAMESITE = 'none';
    let config = mod.buildSessionConfig({ authMode: 'local' });
    assert.equal(config.cookie.sameSite, 'none');

    process.env.SESSION_COOKIE_SAMESITE = 'strict';
    config = mod.buildSessionConfig({ authMode: 'oidc' });
    assert.equal(config.cookie.sameSite, 'strict');

    clearEnv();
  });

  it('throws in production without REDIS_URL and without ALLOW_MEMORY_STORE', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    delete process.env.ALLOW_MEMORY_STORE;
    process.env.SESSION_SECRET = 'a'.repeat(40);

    assert.throws(() => {
      mod.buildSessionConfig({ authMode: 'local' });
    }, /REDIS_URL is required in production/);

    clearEnv();
  });

  it('allows memory store in production with ALLOW_MEMORY_STORE=true', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    process.env.ALLOW_MEMORY_STORE = 'true';
    process.env.SESSION_SECRET = 'a'.repeat(40);

    const config = mod.buildSessionConfig({ authMode: 'local' });
    assert.equal(config.store, undefined);

    clearEnv();
  });

  it('throws in production with weak SESSION_SECRET', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.REDIS_URL;
    process.env.ALLOW_MEMORY_STORE = 'true';
    process.env.SESSION_SECRET = 'weak';

    assert.throws(() => {
      mod.buildSessionConfig({ authMode: 'local' });
    }, /SESSION_SECRET must be a strong/);

    clearEnv();
  });

  it('uses custom SESSION_SECRET when provided', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
    process.env.SESSION_SECRET = 'my-custom-secret';

    const config = mod.buildSessionConfig({ authMode: 'local' });
    assert.equal(config.secret, 'my-custom-secret');

    clearEnv();
  });
});

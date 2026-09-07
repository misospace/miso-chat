const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('SECURITY.md documents the deployment-boundary session authorization model', () => {
  const security = read('SECURITY.md');

  assert.match(security, /Authentication model & session authorization/);
  assert.match(security, /deployment boundary/);
  assert.match(security, /no per-user session isolation/i);
  assert.match(security, /OIDC/);
});

test('README.md links to the SECURITY.md session authorization section', () => {
  const readme = read('README.md');

  assert.match(readme, /SECURITY\.md#authentication-model/);
  assert.match(readme, /deployment boundary/);
});

test('lib/session-auth.js header links back to SECURITY.md#authentication-model', () => {
  const header = read('lib/session-auth.js').slice(0, 1200);

  assert.match(header, /SECURITY\.md#authentication-model/);
});

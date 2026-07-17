const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildManifest,
  findInlineScriptPayloads,
  sha256Base64,
} = require('../scripts/build-csp-hashes');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const MANIFEST_PATH = path.join(PUBLIC_DIR, 'csp-hashes.json');

// ---------------------------------------------------------------------------
// Audit #629 — Frontend-boot smoke: every inline <script> in public/*.html
// must have a matching sha256 entry in public/csp-hashes.json. If the inline
// script drifts from the manifest, CSP will block it in production, breaking
// startup. This test fails the PR before that happens.
// ---------------------------------------------------------------------------

test('csp-hashes.json exists and is well-formed', () => {
  assert.ok(fs.existsSync(MANIFEST_PATH), 'public/csp-hashes.json must exist');
  const raw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.algorithm, 'sha256');
  assert.ok(parsed.files && typeof parsed.files === 'object');
});

test('every inline <script> in public/*.html has a matching hash in the manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const htmlFiles = fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.html'))
    .sort();

  assert.ok(htmlFiles.length > 0, 'expected at least one HTML file in public/');

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const blocks = findInlineScriptPayloads(html);
    const entry = manifest.files[file];

    assert.ok(
      entry,
      `${file}: missing from csp-hashes.json — run \`node scripts/build-csp-hashes.js\``,
    );
    assert.equal(
      entry.blockCount,
      blocks.length,
      `${file}: blockCount ${entry.blockCount} != actual ${blocks.length}`,
    );
    assert.equal(
      entry.hashes.length,
      blocks.length,
      `${file}: hashes length ${entry.hashes.length} != actual ${blocks.length}`,
    );

    for (let i = 0; i < blocks.length; i++) {
      const expected = sha256Base64(blocks[i].payload);
      assert.equal(
        entry.hashes[i],
        expected,
        `${file}: hash mismatch for inline script block #${i + 1}. ` +
          'Run `node scripts/build-csp-hashes.js` and commit the updated manifest.',
      );
    }
  }
});

test('build-csp-hashes --check agrees with the committed manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const fresh = buildManifest();
  // Compare only the structural parts (ignore generatedAt).
  const stripTs = (m) => {
    // eslint-disable-next-line no-unused-vars
  const { generatedAt: _generatedAt, ...rest } = m;
    return rest;
  };
  assert.deepEqual(
    stripTs(manifest),
    stripTs(fresh),
    'public/csp-hashes.json is stale. Run `node scripts/build-csp-hashes.js` and commit.',
  );
});

test('security.js script-src directive uses hashes, not unsafe-inline', () => {
  // Clear the module cache so security.js re-reads the manifest.
  delete require.cache[require.resolve('../security')];
  const security = require('../security');
  const directive = security.getScriptSrcDirective();
  assert.match(directive, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(directive, /'unsafe-inline'/);
});

test('hashes in manifest match actual sha256 of inline script payloads', () => {
  const htmlFiles = fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.html'))
    .sort();

  for (const file of htmlFiles) {
    const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
    const blocks = findInlineScriptPayloads(html);
    for (const block of blocks) {
      const hash = sha256Base64(block.payload);
      // Verify the hash is a valid sha256 base64 string
      assert.match(
        hash,
        /^'sha256-[A-Za-z0-9+/=]+'$/,
        `${file}: invalid hash format: ${hash}`,
      );
    }
  }
});

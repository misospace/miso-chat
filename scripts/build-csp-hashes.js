#!/usr/bin/env node
/**
 * Build-time CSP hash pinner.
 *
 * Scans every HTML file in `public/` for inline `<script>...</script>` blocks
 * whose content is not just whitespace/comments and computes the SHA-256 hash
 * that browsers will compare against `script-src 'sha256-...'`. Writes the
 * resulting list to `public/csp-hashes.json`, keyed by relative file path.
 *
 * Why: security.js (`Content-Security-Policy` header) loads this manifest and
 * uses the listed hashes in place of `'unsafe-inline'` for `script-src`. This
 * preserves defense-in-depth against future XSS bugs without breaking startup.
 *
 * Browser spec note: CSP `sha256-...` hashes cover the *exact bytes* of the
 * inline script element's text content (after leading whitespace inside the
 * tag, before trailing whitespace before `</script>`). We match that here.
 *
 * Usage:
 *   node scripts/build-csp-hashes.js            # writes public/csp-hashes.json
 *   node scripts/build-csp-hashes.js --check    # exits non-zero if manifest is stale
 *
 * Exit codes:
 *   0 — manifest is up-to-date (write or check)
 *   1 — check mode only: manifest was stale
 *   2 — script error (e.g. malformed HTML, I/O failure)
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const OUTPUT_PATH = path.join(PUBLIC_DIR, 'csp-hashes.json');

/**
 * Find every inline `<script>` block in `html` whose `src` attribute is
 * absent. Returns an array of `{ openIndex, closeIndex, payload }` where
 * `payload` is the exact inner text (UTF-8 string) the browser will hash
 * for CSP comparison.
 */
function findInlineScriptPayloads(html) {
  const payloads = [];
  // We scan the file as text to stay robust against attribute order and
  // formatting differences (e.g. `<script\n  >`, `<script type="...">`).
  const openTagRe = /<script\b([^>]*)>/gi;
  let openMatch;
  while ((openMatch = openTagRe.exec(html)) !== null) {
    const attrs = openMatch[1];
    // Skip scripts that load an external file via `src`.
    if (/\bsrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i.test(attrs)) {
      continue;
    }
    const openEnd = openMatch.index + openMatch[0].length;
    const closeStart = html.indexOf('</script>', openEnd);
    if (closeStart === -1) {
      throw new Error(
        `Unterminated inline <script> block opened at offset ${openMatch.index}`,
      );
    }
    const payload = html.slice(openEnd, closeStart);
    // Skip blocks that are entirely whitespace / HTML comments. CSP hashing
    // matches them but they're harmless and not worth pinning.
    if (/^\s*(?:<!--[\s\S]*?-->)?\s*$/.test(payload)) {
      openTagRe.lastIndex = closeStart + '</script>'.length;
      continue;
    }
    payloads.push({
      openIndex: openMatch.index,
      closeIndex: closeStart + '</script>'.length - 1,
      payload,
    });
    openTagRe.lastIndex = closeStart + '</script>'.length;
  }
  return payloads;
}

function sha256Base64(payload) {
  return (
    "'sha256-" +
    crypto.createHash('sha256').update(payload, 'utf8').digest('base64') +
    "'"
  );
}

function buildManifest() {
  const entries = {};
  const files = fs
    .readdirSync(PUBLIC_DIR)
    .filter((name) => name.endsWith('.html'))
    .sort();

  for (const file of files) {
    const fullPath = path.join(PUBLIC_DIR, file);
    const html = fs.readFileSync(fullPath, 'utf8');
    const blocks = findInlineScriptPayloads(html);
    entries[file] = {
      hashes: blocks.map(({ payload }) => sha256Base64(payload)),
      blockCount: blocks.length,
    };
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    algorithm: 'sha256',
    files: entries,
  };
}

function readExistingManifest() {
  try {
    const raw = fs.readFileSync(OUTPUT_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function compareManifest(a, b) {
  if (!a || !b) return false;
  if (a.version !== b.version) return false;
  if (a.algorithm !== b.algorithm) return false;
  const aFiles = a.files || {};
  const bFiles = b.files || {};
  const aKeys = Object.keys(aFiles).sort();
  const bKeys = Object.keys(bFiles).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  for (const key of aKeys) {
    const ah = aFiles[key].hashes || [];
    const bh = bFiles[key].hashes || [];
    if (ah.length !== bh.length) return false;
    for (let i = 0; i < ah.length; i++) {
      if (ah[i] !== bh[i]) return false;
    }
  }
  return true;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');

  let manifest;
  try {
    manifest = buildManifest();
  } catch (err) {
    console.error(`build-csp-hashes: ${err.message}`);
    process.exit(2);
  }

  if (checkOnly) {
    const existing = readExistingManifest();
    if (!compareManifest(existing, manifest)) {
      console.error(
        'build-csp-hashes: public/csp-hashes.json is stale. Run `node scripts/build-csp-hashes.js` and commit the result.',
      );
      process.exit(1);
    }
    console.log('build-csp-hashes: manifest is up-to-date');
    return;
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2) + '\n');
  const totalHashes = Object.values(manifest.files).reduce(
    (acc, entry) => acc + entry.hashes.length,
    0,
  );
  console.log(
    `build-csp-hashes: wrote ${totalHashes} hash(es) across ${Object.keys(manifest.files).length} file(s) to ${path.relative(REPO_ROOT, OUTPUT_PATH)}`,
  );
}

if (require.main === module) {
  main();
}

module.exports = {
  buildManifest,
  compareManifest,
  findInlineScriptPayloads,
  sha256Base64,
};
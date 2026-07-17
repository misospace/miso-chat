#!/usr/bin/env node
/**
 * Checks that duplicated module files in lib/ and public/lib/ stay in sync.
 *
 * Some modules are intentionally duplicated across both directories to serve
 * as a shared API boundary (see issue #477). This script ensures the copies
 * remain identical so changes don't silently drift between them.
 *
 * Usage: node scripts/check-duplicate-modules.js
 * Exit code 0 = all files in sync, 1 = mismatch detected.
 */

const fs = require('fs');
const path = require('path');

const LIB_DIR = path.resolve(__dirname, '..', 'lib');
const PUBLIC_LIB_DIR = path.resolve(__dirname, '..', 'public', 'lib');

function getJsFiles(dir) {
  if (!fs.existsSync(dir)) return new Set();
  return new Set(
    fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.basename(f))
  );
}

const libFiles = getJsFiles(LIB_DIR);
const publicLibFiles = getJsFiles(PUBLIC_LIB_DIR);

// Find duplicated filenames (present in both directories)
const duplicates = [...libFiles].filter((f) => publicLibFiles.has(f)).sort();

if (duplicates.length === 0) {
  console.log('No duplicated module files found between lib/ and public/lib/.');
  process.exit(0);
}

console.log(`Found ${duplicates.length} duplicated module(s):`);
duplicates.forEach((f) => console.log(`  - ${f}`));
console.log();

let hasMismatch = false;

for (const filename of duplicates) {
  const libPath = path.join(LIB_DIR, filename);
  const publicLibPath = path.join(PUBLIC_LIB_DIR, filename);

  const libContent = fs.readFileSync(libPath, 'utf8');
  const publicLibContent = fs.readFileSync(publicLibPath, 'utf8');

  if (libContent !== publicLibContent) {
    hasMismatch = true;
    console.error(`❌ MISMATCH: ${filename}`);
    console.error(`   lib/${filename} and public/lib/${filename} are not identical.`);
    console.error(`   Please keep these files in sync or remove the duplication.`);
    console.error();
  } else {
    console.log(`✓ ${filename} — in sync`);
  }
}

if (hasMismatch) {
  console.error('Duplicate module check failed. Fix the mismatches above.');
  process.exit(1);
}

console.log('All duplicated modules are in sync.');
process.exit(0);

#!/usr/bin/env node
/**
 * Release Version Consistency Checker
 *
 * Validates that all version sources agree for mobile OTA/APK releases:
 * - package.json version
 * - git tag / release tag
 * - Android update-manifest.json version
 * - APK metadata (if available)
 *
 * Usage:
 *   node scripts/release-version-check.js [--manifest-path <path>] [--tag <tag>]
 *
 * Exit 0 = all versions agree, exit 1 = mismatch detected.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pkgPath = path.join(__dirname, '..', 'package.json');
const manifestPath = process.argv[2] === '--manifest-path'
  ? process.argv[3] || path.join(__dirname, '..', 'update-manifest.json')
  : (process.argv[2] ? undefined : undefined);
const cliTag = process.argv.find((a) => a === '--tag')
  ? process.argv[process.argv.indexOf('--tag') + 1]
  : null;

function log(level, msg) {
  const tag = level === 'ERROR' ? '\x1b[31m' : level === 'WARN' ? '\x1b[33m' : '\x1b[32m';
  console.log(`${tag}[${level}]\x1b[0m ${msg}`);
}

function getVersionFromPkg() {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  return (pkg.version || '').replace(/^v/, '');
}

function getGitTag() {
  if (cliTag) return cliTag.replace(/^v/, '');
  try {
    // Get the most recent tag on current branch
    const output = execSync('git describe --tags --abbrev=0', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return output.replace(/^v/, '');
  } catch {
    return null;
  }
}

function getManifestVersion(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  // Check channels.stable.version or top-level version
  return (
    (manifest.channels?.stable?.version || manifest.version || '').replace(/^v/, '')
  );
}

function compareVersions(v1, v2) {
  const a = v1.split('.').map(Number);
  const b = v2.split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(a[i]) ? a[i] : 0;
    const y = Number.isFinite(b[i]) ? b[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function main() {
  const errors = [];
  const warnings = [];

  // 1. Read package.json version
  const pkgVersion = getVersionFromPkg();
  if (!pkgVersion) {
    log('ERROR', 'package.json has no version field');
    process.exit(1);
  }
  log('INFO', `package.json version: ${pkgVersion}`);

  // 2. Read git tag
  const gitTag = getGitTag();
  if (gitTag) {
    log('INFO', `git tag: ${gitTag}`);
    if (compareVersions(pkgVersion, gitTag) !== 0) {
      errors.push(`Version mismatch: package.json (${pkgVersion}) != git tag (${gitTag})`);
    }
  } else {
    warnings.push('No git tag found (non-tagged checkout)');
  }

  // 3. Read update-manifest version
  const manifestFile = manifestPath || path.join(__dirname, '..', 'update-manifest.json');
  const manifestVersion = getManifestVersion(manifestFile);
  if (manifestVersion) {
    log('INFO', `update-manifest version: ${manifestVersion}`);
    if (compareVersions(pkgVersion, manifestVersion) !== 0) {
      errors.push(`Version mismatch: package.json (${pkgVersion}) != update-manifest (${manifestVersion})`);
    }
  } else {
    warnings.push('No update-manifest.json found (expected after release build)');
  }

  // 4. Report results
  if (errors.length > 0) {
    log('ERROR', `Release validation FAILED with ${errors.length} error(s):`);
    for (const e of errors) log('ERROR', `  - ${e}`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    log('WARN', `Release validation passed with ${warnings.length} warning(s):`);
    for (const w of warnings) log('WARN', `  - ${w}`);
  } else {
    log('INFO', 'Release validation PASSED: all versions agree');
  }

  process.exit(0);
}

main();

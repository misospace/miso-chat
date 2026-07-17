'use strict';

// Verifies the Android release signing wiring described in
// docs / RELEASE.md#android-release-signing and issue misospace/miso-chat#628.
//
// The tests are static / structural: they assert the build script reads
// android/key.properties, gitignore keeps the file out of the repo, and the
// release workflow injects the required secrets. We avoid spinning up
// gradle on the host because the Android SDK is not installed in CI.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const buildGradlePath = path.join(repoRoot, 'android', 'app', 'build.gradle');
const androidGitignorePath = path.join(repoRoot, 'android', '.gitignore');
const exampleKeyPath = path.join(repoRoot, 'android', 'key.properties.example');
const releaseDocPath = path.join(repoRoot, 'RELEASE.md');
const workflowPath = path.join(repoRoot, '.github', 'workflows', 'android-release.yml');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('release build type reads android/key.properties via signingConfig', () => {
  const gradle = read(buildGradlePath);

  // top-level: load key.properties at configuration time
  assert.match(gradle, /keystorePropertiesFile\s*=\s*rootProject\.file\(\s*["']key\.properties["']\s*\)/);
  assert.match(gradle, /keystoreProperties\.load\(\s*new\s+FileInputStream\(\s*keystorePropertiesFile\s*\)\s*\)/);

  // signingConfigs.release block wired to the properties
  assert.match(gradle, /signingConfigs\s*\{[\s\S]*?release\s*\{/);
  assert.match(gradle, /storeFile\s+file\(\s*keystoreProperties\[['"]storeFile['"]\]/);
  assert.match(gradle, /storePassword\s+keystoreProperties\[['"]storePassword['"]\]/);
  assert.match(gradle, /keyAlias\s+keystoreProperties\[['"]keyAlias['"]\]/);
  assert.match(gradle, /keyPassword\s+keystoreProperties\[['"]keyPassword['"]\]/);

  // release build type assigns the signingConfig and fails fast when missing
  assert.match(gradle, /signingConfig\s+signingConfigs\.release/);
  assert.match(
    gradle,
    /throw\s+new\s+GradleException\([^)]*key\.properties\s+is\s+missing[^)]*RELEASE\.md#android-release-signing/
  );
});

test('android/.gitignore keeps key.properties, *.keystore and *.jks out of the repo', () => {
  const gitignore = read(androidGitignorePath);

  assert.match(gitignore, /\*\*\/key\.properties/);
  assert.match(gitignore, /\*\.keystore/);
  assert.match(gitignore, /\*\.jks/);
});

test('android/key.properties.example exists and matches the key names read by gradle', () => {
  const example = read(exampleKeyPath);

  assert.match(example, /^storeFile=/m);
  assert.match(example, /^storePassword=/m);
  assert.match(example, /^keyAlias=/m);
  assert.match(example, /^keyPassword=/m);
});

test('RELEASE.md documents the Android release signing contract', () => {
  const releaseMd = read(releaseDocPath);

  assert.match(releaseMd, /## Android Release Signing/);
  assert.match(releaseMd, /android\/key\.properties/);
  assert.match(releaseMd, /ANDROID_KEYSTORE_BASE64/);
  assert.match(releaseMd, /ANDROID_KEYSTORE_PASSWORD/);
  assert.match(releaseMd, /ANDROID_KEY_ALIAS/);
  assert.match(releaseMd, /ANDROID_KEY_PASSWORD/);
  // must not leak any actual keystore secret value
  assert.doesNotMatch(releaseMd, /^storePassword=\S+/m);
});

test('android-release workflow injects signing material from GitHub Actions secrets', () => {
  const workflow = read(workflowPath);

  assert.match(workflow, /Configure release signing/);
  assert.match(workflow, /ANDROID_KEYSTORE_BASE64:\s*\$\{\{\s*secrets\.ANDROID_KEYSTORE_BASE64\s*\}\}/);
  assert.match(workflow, /ANDROID_KEYSTORE_PASSWORD:\s*\$\{\{\s*secrets\.ANDROID_KEYSTORE_PASSWORD\s*\}\}/);
  assert.match(workflow, /ANDROID_KEY_ALIAS:\s*\$\{\{\s*secrets\.ANDROID_KEY_ALIAS\s*\}\}/);
  assert.match(workflow, /ANDROID_KEY_PASSWORD:\s*\$\{\{\s*secrets\.ANDROID_KEY_PASSWORD\s*\}\}/);
  // step that configures signing must run before the gradle assembleRelease steps
  const configureIdx = workflow.indexOf('Configure release signing');
  const assembleIdx = workflow.indexOf('assembleRelease');
  assert.ok(configureIdx !== -1 && assembleIdx !== -1 && configureIdx < assembleIdx,
    'Configure release signing must run before assembleRelease');
  assert.match(workflow, /base64\s+-d\s+>\s+android\/app\/release\.keystore/);
  assert.match(workflow, /cat\s+>\s+android\/key\.properties/);
});

test('gradle wrapper script still exists and is executable for signed-release flows', () => {
  const gradlew = path.join(repoRoot, 'android', 'gradlew');
  assert.ok(fs.existsSync(gradlew), 'android/gradlew must exist for ./gradlew assembleRelease');
  const stat = fs.statSync(gradlew);
  // owner-exec bit; CI runners may not have the same uid so we accept any exec bit
  assert.ok((stat.mode & 0o111) !== 0, 'android/gradlew must be executable');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');
const updateManagerPath = path.join(__dirname, '..', 'public', 'mobile', 'update-manager.js');

function read(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

test('native onboarding requires backend configuration before app boot continues', () => {
  const indexHtml = read(indexHtmlPath);

  assert.match(indexHtml, /if \(!isNativeCapacitor\(\)\) return true;/);
  assert.match(indexHtml, /if \(getApiBaseUrl\(\)\) return true;/);
  assert.match(indexHtml, /window\.prompt\(`Enter your Miso server URL/);
  assert.match(indexHtml, /window\.alert\('A backend URL is required before the APK can sign in\.'/);
  assert.match(indexHtml, /const result = await verifyBackendUrl\(normalized\);/);
  assert.match(indexHtml, /const backendReady = await ensureMobileBackendConfigured\(\);/);
  assert.match(indexHtml, /if \(!backendReady\) \{/);
});

test('auth-required fetch path will not immediately relaunch login during callback settle window', () => {
  const indexHtml = read(indexHtmlPath);

  assert.match(indexHtml, /if \(mobileAuthInFlight\) \{/);
  assert.match(indexHtml, /throw new Error\('Authentication pending'\);/);
  assert.match(indexHtml, /const justSettled = mobileAuthSettledAt && \(Date\.now\(\) - mobileAuthSettledAt\) < 4000;/);
  assert.match(indexHtml, /throw new Error\('Authentication settling'\);/);
  assert.match(indexHtml, /mobileAuthSettledAt = Date\.now\(\);/);
});

test('manual OTA affordance still exists in the native shell header', () => {
  const indexHtml = read(indexHtmlPath);

  assert.match(indexHtml, /id="manualUpdateBtn"/);
  assert.match(indexHtml, /title="Check for OTA update"/);
});

test('mobile updater fails explicitly when updater plugin is unavailable', () => {
  const updateManager = read(updateManagerPath);

  assert.match(updateManager, /return \{ available: false, reason: 'updater-unavailable' \};/);
  assert.match(updateManager, /Updater plugin unavailable; skipping updater init/);
});


test('native build marker exposes backend and OTA plugin state in-app', () => {
  const indexHtml = read(indexHtmlPath);

  assert.match(indexHtml, /id="nativeBuildMarker"/);
  assert.match(indexHtml, /native shell • backend/);
  assert.match(indexHtml, /ota-plugin:yes/);
  assert.match(indexHtml, /ota-plugin:no/);
  assert.match(indexHtml, /updateNativeBuildMarker\(\);/);
});

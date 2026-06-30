/**
 * Update Manager for Miso Chat Mobile App
 *
 * Single supported update path: Capgo Capacitor Updater (manual mode, no cloud).
 * Updates are distributed via release artifacts containing `update-manifest.json`.
 * The client-side module (`public/mobile/update-manager.js`) handles the full
 * OTA lifecycle (check → download → install → apply) in the browser/Capacitor runtime.
 *
 * This server-side module provides lightweight helpers for serverside checks,
 * e.g. CI jobs or admin endpoints that need to query release metadata.
 * It does NOT perform downloads or installs — those are client-side only.
 */

// Server-side module: never runs on a native platform.
const IS_MOBILE = false;

// GitHub API configuration
const GITHUB_API_URL = 'https://api.github.com';
const REPO_OWNER = 'misospace';
const REPO_NAME = 'miso-chat';

/**
 * Check if running on a mobile platform.
 * @returns {boolean}
 */
function isMobilePlatform() {
  return IS_MOBILE;
}

/**
 * Get the latest release information from GitHub.
 * @returns {Promise<Object|null>} Release information or null on failure.
 */
async function getLatestRelease() {
  try {
    const response = await fetch(
      `${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'MisoChat-UpdateManager',
        },
      }
    );

    if (!response.ok) {
      console.warn(`GitHub API request failed: ${response.status}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch latest release:', error.message);
    return null;
  }
}

/**
 * Get the update-manifest.json asset URL from a release.
 * This is the single supported artifact for OTA updates.
 * APK assets are legacy and should not be used for mobile updates.
 * @param {Object} release - GitHub release object
 * @returns {string|null} manifest download URL or null
 */
function getManifestUrlFromRelease(release) {
  if (!release || !release.assets) return null;

  const manifestAsset = release.assets.find((asset) => asset.name === 'update-manifest.json');
  return manifestAsset ? manifestAsset.browser_download_url : null;
}

/**
 * Compare semantic versions.
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
  const parts1 = String(v1 || '0.0.0')
    .replace(/^v/, '')
    .split('.')
    .map((n) => { const num = Number(n); return Number.isFinite(num) ? num : 0; });
  const parts2 = String(v2 || '0.0.0')
    .replace(/^v/, '')
    .split('.')
    .map((n) => { const num = Number(n); return Number.isFinite(num) ? num : 0; });

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check if an update is available by comparing current bundle version
 * with the latest release. Server-side helper only — does not download.
 * @returns {Promise<Object>} Update status information.
 */
async function checkForUpdate() {
  try {
    // Get latest release from GitHub
    const release = await getLatestRelease();
    if (!release) {
      return { available: false, reason: 'No release found' };
    }

    const latestVersion = (release.tag_name || '').replace(/^v/, '');
    const manifestUrl = getManifestUrlFromRelease(release);

    if (!manifestUrl) {
      return { available: false, reason: 'No update-manifest.json in release' };
    }

    // Fetch manifest to get stable channel version
    let manifestVersion = latestVersion;
    try {
      const manifestResp = await fetch(manifestUrl);
      if (manifestResp.ok) {
        const manifest = await manifestResp.json();
        manifestVersion = manifest.channels?.stable?.version || manifest.version || latestVersion;
      }
    } catch (_) {
      // Manifest fetch is best-effort; fall back to tag name
    }

    return {
      available: true,
      currentVersion: 'unknown', // server doesn't know current bundle version
      latestVersion: manifestVersion,
      manifestUrl,
      release,
    };
  } catch (error) {
    console.error('Error checking for update:', error.message);
    return { available: false, reason: error.message };
  }
}

/**
 * Initialize the update manager on app startup.
 * Server-side init is a no-op — mobile clients use
 * `public/mobile/update-manager.js` which handles full lifecycle.
 * @param {Object} _options - Ignored on server side.
 * @returns {Promise<Object>} Initialization result.
 */
async function initialize(_options = {}) {
  return {
    initialized: true,
    note: 'Server-side update manager is a metadata helper only. Mobile clients use public/mobile/update-manager.js for full OTA lifecycle.',
  };
}

module.exports = {
  isMobilePlatform,
  getLatestRelease,
  getManifestUrlFromRelease,
  compareVersions,
  checkForUpdate,
  initialize,
};

/**
 * Update Manager for Miso Chat Mobile App
 * 
 * Handles OTA updates using Capgo Capacitor Updater plugin.
 * Integrates with GitHub Releases for distributing updates.
 */

const { Capacitor } = require('@capacitor/core');
const { CapgoUpdater } = require('@capgo/capacitor-updater');

const IS_MOBILE = Capacitor.isNativePlatform();

// GitHub API configuration
const GITHUB_API_URL = 'https://api.github.com';
const REPO_OWNER = 'misospace';
const REPO_NAME = 'miso-chat';

/**
 * Check if running on a mobile platform
 */
function isMobilePlatform() {
  return IS_MOBILE;
}

/**
 * Get the latest release information from GitHub
 * @returns {Promise<Object>} Release information
 */
async function getLatestRelease() {
  if (!isMobilePlatform()) {
    return null;
  }

  try {
    const response = await fetch(`${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'MisoChat-UpdateManager'
      }
    });

    if (!response.ok) {
      throw new Error(`GitHub API request failed: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('Failed to fetch latest release:', error);
    throw error;
  }
}

/**
 * Get the APK download URL from the latest release
 * @param {Object} release - GitHub release object
 * @returns {string|null} APK download URL
 */
function getApkUrlFromRelease(release) {
  if (!release || !release.assets) {
    return null;
  }

  // Look for debug APK first, then release APK
  const apkAsset = release.assets.find(asset => 
    asset.name.endsWith('.apk') && !asset.name.includes('-unsigned')
  ) || release.assets.find(asset => asset.name.endsWith('.apk'));

  return apkAsset ? apkAsset.browser_download_url : null;
}

/**
 * Compare semantic versions
 * @param {string} v1 - First version
 * @param {string} v2 - Second version
 * @returns {number} -1 if v1 < v2, 0 if equal, 1 if v1 > v2
 */
function compareVersions(v1, v2) {
  const parts1 = v1.replace(/^v/, '').split('.').map(Number);
  const parts2 = v2.replace(/^v/, '').split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return -1;
    if (p1 > p2) return 1;
  }
  return 0;
}

/**
 * Check if an update is available
 * @returns {Promise<Object>} Update status information
 */
async function checkForUpdate() {
  if (!isMobilePlatform()) {
    return { available: false, reason: 'Not on mobile platform' };
  }

  try {
    // Get current bundle info from Capgo
    const currentBundle = await CapgoUpdater.getCurrent();
    const currentVersion = currentBundle?.version || '0.0.0';

    // Get latest release from GitHub
    const release = await getLatestRelease();
    if (!release) {
      return { available: false, reason: 'No release found' };
    }

    const latestVersion = release.tag_name.replace(/^v/, '');
    const apkUrl = getApkUrlFromRelease(release);

    if (!apkUrl) {
      return { available: false, reason: 'No APK found in release' };
    }

    // Compare versions
    const versionComparison = compareVersions(latestVersion, currentVersion);
    
    if (versionComparison > 0) {
      return {
        available: true,
        currentVersion,
        latestVersion,
        releaseNotes: release.body,
        apkUrl,
        release: release
      };
    }

    return { available: false, reason: 'Already on latest version' };
  } catch (error) {
    console.error('Error checking for update:', error);
    return { available: false, reason: error.message };
  }
}

/**
 * Download and install an update
 * @param {Object} updateInfo - Update information from checkForUpdate
 * @returns {Promise<Object>} Installation result
 */
async function downloadUpdate(updateInfo) {
  if (!isMobilePlatform() || !updateInfo?.available) {
    return { success: false, reason: 'No update available' };
  }

  try {
    // Download the bundle using Capgo
    const downloadedBundle = await CapgoUpdater.download({
      url: updateInfo.apkUrl,
      headers: {
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (!downloadedBundle) {
      return { success: false, reason: 'Download failed' };
    }

    return {
      success: true,
      bundleId: downloadedBundle.id,
      version: updateInfo.latestVersion
    };
  } catch (error) {
    console.error('Error downloading update:', error);
    return { success: false, reason: error.message };
  }
}

/**
 * Install a downloaded bundle
 * @param {string} bundleId - The bundle ID to install
 * @returns {Promise<Object>} Installation result
 */
async function installUpdate(bundleId) {
  if (!isMobilePlatform()) {
    return { success: false, reason: 'Not on mobile platform' };
  }

  try {
    await CapgoUpdater.set({ bundleId });
    return { success: true, bundleId };
  } catch (error) {
    console.error('Error installing update:', error);
    return { success: false, reason: error.message };
  }
}

/**
 * Apply a pending update (requires app restart)
 * @returns {Promise<Object>} Result
 */
async function applyUpdate() {
  if (!isMobilePlatform()) {
    return { success: false, reason: 'Not on mobile platform' };
  }

  try {
    await CapgoUpdater.downloadAndSet({
      url: '', // Will use configured update source
      autoUpdate: true
    });
    return { success: true };
  } catch (error) {
    console.error('Error applying update:', error);
    return { success: false, reason: error.message };
  }
}

/**
 * List available bundles
 * @returns {Promise<Array>} List of bundles
 */
async function listBundles() {
  if (!isMobilePlatform()) {
    return [];
  }

  try {
    const bundles = await CapgoUpdater.list();
    return bundles;
  } catch (error) {
    console.error('Error listing bundles:', error);
    return [];
  }
}

/**
 * Delete a bundle by ID
 * @param {string} bundleId - Bundle ID to delete
 * @returns {Promise<Object>} Result
 */
async function deleteBundle(bundleId) {
  if (!isMobilePlatform()) {
    return { success: false, reason: 'Not on mobile platform' };
  }

  try {
    await CapgoUpdater.delete({ bundleId });
    return { success: true, bundleId };
  } catch (error) {
    console.error('Error deleting bundle:', error);
    return { success: false, reason: error.message };
  }
}

/**
 * Get current bundle info
 * @returns {Promise<Object>} Current bundle information
 */
async function getCurrentBundle() {
  if (!isMobilePlatform()) {
    return null;
  }

  try {
    return await CapgoUpdater.getCurrent();
  } catch (error) {
    console.error('Error getting current bundle:', error);
    return null;
  }
}

/**
 * Initialize the update manager on app startup
 * This should be called during app initialization
 * @param {Object} options - Initialization options
 * @param {boolean} options.autoCheck - Automatically check for updates on startup
 * @param {boolean} options.autoDownload - Automatically download available updates
 * @returns {Promise<Object>} Initialization result
 */
async function initialize(options = {}) {
  const { autoCheck = true, autoDownload = false } = options;
  
  if (!isMobilePlatform()) {
    console.log('Update manager: Not on mobile platform, skipping initialization');
    return { initialized: false, reason: 'Not on mobile platform' };
  }

  try {
    // Verify plugin is available
    await CapgoUpdater.info();
    
    let updateStatus = null;
    
    if (autoCheck) {
      updateStatus = await checkForUpdate();
      
      if (updateStatus.available && autoDownload) {
        const downloadResult = await downloadUpdate(updateStatus);
        if (downloadResult.success) {
          await installUpdate(downloadResult.bundleId);
        }
      }
    }

    return {
      initialized: true,
      updateStatus
    };
  } catch (error) {
    console.error('Error initializing update manager:', error);
    return { initialized: false, reason: error.message };
  }
}

module.exports = {
  isMobilePlatform,
  getLatestRelease,
  compareVersions,
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  applyUpdate,
  listBundles,
  deleteBundle,
  getCurrentBundle,
  initialize
};
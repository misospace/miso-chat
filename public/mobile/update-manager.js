/**
 * Mobile Update Manager - Self-hosted/No-cloud OTA
 *
 * Uses @capgo/capacitor-updater in manual mode with release artifacts.
 * No Capgo account/API key required.
 */

(function(window) {
  'use strict';

  const GITHUB_API_URL = 'https://api.github.com';
  const REPO_OWNER = 'joryirving';
  const REPO_NAME = 'miso-chat';

  function getUpdater() {
    return window.CapacitorUpdater || window.CapgoUpdater || null;
  }

  function normalizeVersion(v) {
    return String(v || '0.0.0').replace(/^v/, '');
  }

  function compareVersions(v1, v2) {
    const a = normalizeVersion(v1).split('.').map(Number);
    const b = normalizeVersion(v2).split('.').map(Number);
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const x = Number.isFinite(a[i]) ? a[i] : 0;
      const y = Number.isFinite(b[i]) ? b[i] : 0;
      if (x < y) return -1;
      if (x > y) return 1;
    }
    return 0;
  }

  const MobileUpdateManager = {
    config: {
      autoCheck: true,
      showNotification: true,
      notificationElement: 'update-notification',
      checkInterval: 3600000,
      debug: false,
    },
    currentBundle: null,
    availableUpdate: null,
    checkIntervalId: null,

    log: function(...args) {
      if (this.config.debug) {
        console.log('[UpdateManager]', ...args);
      }
    },

    isNativePlatform: function() {
      return !!window.Capacitor;
    },

    getCurrentBundle: async function() {
      const updater = getUpdater();
      if (!updater || !updater.getCurrent) return null;
      try {
        return await updater.getCurrent();
      } catch (error) {
        this.log('Error getting current bundle:', error);
        return null;
      }
    },

    getLatestManifest: async function() {
      const releaseResp = await fetch(`${GITHUB_API_URL}/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'MisoChat-Mobile-UpdateManager'
        }
      });
      if (!releaseResp.ok) {
        throw new Error(`release lookup failed: ${releaseResp.status}`);
      }

      const release = await releaseResp.json();
      const manifestAsset = (release.assets || []).find((a) => a.name === 'update-manifest.json');
      if (!manifestAsset) {
        throw new Error('update-manifest.json asset not found on latest release');
      }

      const manifestResp = await fetch(manifestAsset.browser_download_url, {
        headers: { 'Accept': 'application/json' }
      });
      if (!manifestResp.ok) {
        throw new Error(`manifest fetch failed: ${manifestResp.status}`);
      }

      const manifest = await manifestResp.json();
      return { release, manifest };
    },

    checkForUpdate: async function() {
      if (!this.isNativePlatform()) return { available: false, reason: 'not-native' };

      const updater = getUpdater();
      if (!updater || typeof updater.download !== 'function' || typeof updater.set !== 'function') {
        return { available: false, reason: 'updater-unavailable' };
      }

      try {
        this.currentBundle = await this.getCurrentBundle();
        const currentVersion = this.currentBundle?.version || this.currentBundle?.id || '0.0.0';

        const { release, manifest } = await this.getLatestManifest();
        const stable = manifest?.channels?.stable || {};
        const latestVersion = stable.version || manifest.version || release.tag_name;
        const bundleUrl = stable.bundleUrl || manifest.bundleUrl || null;

        if (!bundleUrl) {
          return { available: false, reason: 'manifest-missing-bundleUrl' };
        }

        if (compareVersions(latestVersion, currentVersion) <= 0) {
          return { available: false, reason: 'already-latest', currentVersion, latestVersion };
        }

        this.availableUpdate = {
          version: normalizeVersion(latestVersion),
          bundleUrl,
          releaseNotes: release.body || manifest.releaseNotes || ''
        };

        if (this.config.showNotification) {
          this.showUpdateNotification(this.availableUpdate);
        }

        return { available: true, info: this.availableUpdate, currentVersion };
      } catch (error) {
        this.log('Error checking for update:', error);
        return { available: false, reason: error.message };
      }
    },

    update: async function() {
      const updater = getUpdater();
      if (!updater) return { success: false, reason: 'updater-unavailable' };
      if (!this.availableUpdate) return { success: false, reason: 'no-update-available' };

      try {
        const downloaded = await updater.download({
          version: this.availableUpdate.version,
          url: this.availableUpdate.bundleUrl,
        });

        await updater.set(downloaded);
        return { success: true, bundle: downloaded };
      } catch (error) {
        this.log('Error applying update:', error);
        return { success: false, reason: error.message };
      }
    },

    showUpdateNotification: function() {
      const notificationEl = document.getElementById(this.config.notificationElement);
      if (notificationEl) {
        notificationEl.style.display = 'block';
        notificationEl.classList.add('visible');
        return;
      }
      this.createNotificationElement();
    },

    createNotificationElement: function() {
      const notification = document.createElement('div');
      notification.id = this.config.notificationElement;
      notification.className = 'update-notification';
      notification.innerHTML = `
        <div class="update-notification-content">
          <h3>New Update Available</h3>
          <p>A new version is ready. Apply now?</p>
          <div class="update-actions">
            <button id="update-later-btn" class="update-btn-secondary">Later</button>
            <button id="update-now-btn" class="update-btn-primary">Update Now</button>
          </div>
        </div>
      `;

      document.body.appendChild(notification);

      document.getElementById('update-now-btn').addEventListener('click', () => this.handleUpdateNow());
      document.getElementById('update-later-btn').addEventListener('click', () => this.hideUpdateNotification());
    },

    hideUpdateNotification: function() {
      const notificationEl = document.getElementById(this.config.notificationElement);
      if (!notificationEl) return;
      notificationEl.classList.remove('visible');
      setTimeout(() => {
        notificationEl.style.display = 'none';
      }, 300);
    },

    handleUpdateNow: async function() {
      const btn = document.getElementById('update-now-btn');
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Applying...';
      }

      const result = await this.update();
      if (result.success) {
        return;
      }

      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Update Now';
      }
      alert(`Failed to apply update: ${result.reason}`);
    },

    init: async function(options = {}) {
      Object.assign(this.config, options);

      if (!this.isNativePlatform()) {
        this.log('Not native platform; skipping updater init');
        return;
      }

      const updater = getUpdater();
      if (!updater) {
        this.log('Updater plugin unavailable; skipping updater init');
        return;
      }
      if (updater?.notifyAppReady) {
        try {
          await updater.notifyAppReady();
        } catch (error) {
          this.log('notifyAppReady failed:', error);
        }
      }

      if (this.config.autoCheck) {
        await this.checkForUpdate();
        if (this.config.checkInterval > 0) {
          this.checkIntervalId = setInterval(() => this.checkForUpdate(), this.config.checkInterval);
        }
      }
    },

    destroy: function() {
      if (this.checkIntervalId) {
        clearInterval(this.checkIntervalId);
        this.checkIntervalId = null;
      }
    }
  };

  window.MobileUpdateManager = MobileUpdateManager;
})(window);

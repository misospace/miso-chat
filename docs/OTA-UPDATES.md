# OTA (Over-The-Air) Updates for Miso Chat Mobile

This document describes the implementation of automatic over-the-air (OTA) updates for the Miso Chat mobile application.

## Overview

The OTA update system allows the Miso Chat mobile app to check for and download updates automatically, eliminating the need for users to manually sideload APK files.

## Architecture

### Components

1. **Capgo Capacitor Updater Plugin** (`@capgo/capacitor-updater`)
   - Core plugin for managing web bundle updates
   - Supports versioning, channels, and rollback

2. **Update Manager (Backend)** (`lib/update-manager.js`)
   - Node.js module for server-side update management
   - GitHub Releases integration for version tracking

3. **Update Manager (Frontend)** (`public/mobile/update-manager.js`)
   - Client-side JavaScript for update notifications
   - UI components for update prompts

4. **CI/CD Pipeline** (`.github/workflows/android-release.yml`)
   - Automatic APK building on release
   - Update manifest generation
   - Optional Capgo sync

## Configuration

### Environment Variables

Set these environment variables to configure the update behavior:

```bash
# Capacitor Updater Configuration
CAPGO_APP_ID=chat.openclaw.miso        # Unique app identifier
CAPGO_UPDATE_METHOD=manual             # 'manual' or 'auto'
CAPACITOR_UPDATE_CHANNEL=stable        # 'stable' or 'beta'

# Optional: Capgo Cloud Integration
CAPGO_API_KEY=your_capgo_api_key       # For cloud-based update distribution
```

### Capacitor Config

The `capacitor.config.js` file includes the Capgo Updater configuration:

```javascript
{
  plugins: {
    CapgoUpdater: {
      appId: 'chat.openclaw.miso',
      updateMethod: 'manual',
      updateChannel: 'stable',
      minUpdateDuration: 3000,
      maxUpdateDuration: 30000,
      debug: false
    }
  }
}
```

## Usage

### For End Users

1. **Automatic Update Check**: The app checks for updates on startup (if enabled)
2. **Update Notification**: A dialog appears when a new version is available
3. **Download & Install**: User can choose to update now or later
4. **App Restart**: The app restarts to apply the update

### For Developers

#### Checking for Updates Programmatically

```javascript
// Frontend
import { MobileUpdateManager } from './mobile/update-manager.js';

// Initialize on app startup
MobileUpdateManager.init({
  autoCheck: true,
  showNotification: true,
  checkInterval: 3600000  // Check every hour
});

// Manual check
const updateStatus = await MobileUpdateManager.checkForUpdate();
if (updateStatus.available) {
  console.log('Update available:', updateStatus.info);
}

// Apply update
await MobileUpdateManager.update();
```

#### Backend Integration

```javascript
// Server-side update management
const updateManager = require('./lib/update-manager');

// Check for latest release
const latest = await updateManager.getLatestRelease();

// Compare versions
const comparison = updateManager.compareVersions('1.2.0', '1.1.0'); // 1 (newer)

// Initialize update manager
const result = await updateManager.initialize({
  autoCheck: true,
  autoDownload: false
});
```

## Release Workflow

### Creating a New Release

1. **Update version in `package.json`**:
   ```json
   {
     "version": "1.2.0"
   }
   ```

2. **Create and push a Git tag**:
   ```bash
   git tag v1.2.0
   git push origin v1.2.0
   ```

3. **Create a GitHub Release**:
   - Go to GitHub Releases
   - Create new release with tag `v1.2.0`
   - Add release notes
   - Publish release

4. **Automatic Actions**:
   - CI/CD builds the APK
   - Update manifest is generated
   - APK and manifest are uploaded to the release

### Update Manifest Format

```json
{
  "version": "1.2.0",
  "tag": "v1.2.0",
  "releaseDate": "2026-03-13T00:00:00Z",
  "releaseNotes": "Bug fixes and improvements",
  "channels": {
    "stable": {
      "version": "1.2.0",
      "apkUrl": "https://github.com/misospace/miso-chat/releases/download/v1.2.0/app-debug.apk",
      "mandatory": false
    },
    "beta": {
      "version": "1.2.0",
      "apkUrl": "https://github.com/misospace/miso-chat/releases/download/v1.2.0/app-debug.apk",
      "mandatory": false
    }
  }
}
```

## Capgo Cloud Integration (Optional)

For enhanced update distribution, you can optionally integrate with Capgo's cloud service:

1. **Create a Capgo account** at https://capgo.app

2. **Get your API key** from the Capgo dashboard

3. **Add secrets to GitHub**:
   - `CAPGO_API_KEY`: Your Capgo API key
   - `CAPGO_APP_ID`: Your Capgo app ID (optional, defaults to `chat.openclaw.miso`)

4. **The CI/CD pipeline will automatically**:
   - Upload new bundles to Capgo
   - Manage update channels
   - Provide analytics on update adoption

## Update Channels

### Stable Channel
- Production-ready updates
- Recommended for all users
- Default channel

### Beta Channel
- Pre-release features
- For testing and feedback
- Set `CAPACITOR_UPDATE_CHANNEL=beta` to opt-in

## Troubleshooting

### Update Not Appearing

1. Check that the update manifest is correctly formatted
2. Verify the APK filename matches the manifest URL
3. Ensure the version number is higher than the current version
4. Check network connectivity

### Bundle Not Installing

1. Verify the Capgo plugin is properly synced: `npx cap sync android`
2. Check Android logcat for error messages
3. Ensure sufficient storage space is available

### Clear Update Cache

```javascript
// List all bundles
const bundles = await MobileUpdateManager.listBundles();

// Delete specific bundle
await MobileUpdateManager.deleteBundle('bundle-id');

// Cleanup old bundles (keep last 3)
await MobileUpdateManager.cleanupBundles(3);
```

## Security Considerations

1. **APK Verification**: Always verify APK signatures before installation
2. **HTTPS Only**: Update downloads should only occur over HTTPS
3. **Version Pinning**: Consider mandatory updates for security patches
4. **Rollback Capability**: Keep previous versions available for rollback

## Future Enhancements

- [ ] Differential updates (download only changed files)
- [ ] A/B testing support
- [ ] Update scheduling (WiFi-only, off-peak hours)
- [ ] In-app update progress indicator
- [ ] Update analytics dashboard
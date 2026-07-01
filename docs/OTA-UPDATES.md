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
   - Update manifest generation

## Configuration

### Environment Variables

Set these environment variables to configure the update behavior:

```bash
# Capacitor Updater Configuration
CAPGO_APP_ID=chat.openclaw.miso        # Unique app identifier
CAPGO_UPDATE_METHOD=manual             # 'manual' or 'auto'
CAPACITOR_UPDATE_CHANNEL=stable        # 'stable' or 'beta'


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

Releases use a two-step GitHub Actions pipeline: **Manual Release** → **Publish Release**.

1. Navigate to **Actions → Manual Release → Run workflow**.
2. Enter the target version (e.g. `0.4.20` or `v0.4.20`). The workflow normalizes the prefix, opens a version-bump PR, and enables auto-merge.
3. After required checks pass, the PR merges automatically.
4. **Publish Release** triggers on merge: it tags the merge commit and creates the GitHub release with generated notes.

The `update-manifest.json` is served from the latest GitHub release via `GET /api/mobile/update-manifest`.

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
      "apkUrl": "https://github.com/misospace/miso-chat/releases/download/1.2.0/miso-chat-1.2.0-release.apk",
      "mandatory": false
    },
    "beta": {
      "version": "1.2.0",
      "apkUrl": "https://github.com/misospace/miso-chat/releases/download/1.2.0/miso-chat-1.2.0-release.apk",
      "mandatory": false
    }
  }
}
```

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
## Update Source Configuration (v0.5.0+)

### Server-Served Update Manifest

Starting from v0.5.0, the mobile updater prefers a server-served manifest endpoint
instead of directly hitting the GitHub API. This allows operators to:

- Proxy or cache update manifests without client-side config changes
- Replace GitHub releases with an alternative distribution channel by setting env vars
- Add authentication or rate-limiting at the server layer

**Endpoint:** `GET /api/mobile/update-manifest`

The server fetches the `update-manifest.json` asset from the latest GitHub release,
caches it for 5 minutes (configurable), and serves it to clients. The client falls
back to direct GitHub API lookup if the server endpoint is unavailable.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MOBILE_UPDATE_REPO_OWNER` | `misospace` | GitHub org for update releases |
| `MOBILE_UPDATE_REPO_NAME` | `miso-chat` | GitHub repo for update releases |
| `MOBILE_UPDATE_CACHE_TTL_MS` | `300000` | Cache TTL in milliseconds (5 min) |

To switch to a different release source, set `MOBILE_UPDATE_REPO_OWNER` and
`MOBILE_UPDATE_REPO_NAME` to point at the new GitHub repo, or replace the server
endpoint implementation entirely.

### Client Update Flow

```
1. Client calls GET /api/mobile/update-manifest
2. Server returns cached/fetched manifest JSON
3. If server fails → client falls back to GitHub API direct lookup
4. Client compares manifest version vs current bundle version
5. If newer → download bundle, apply update on next restart
```

### Release Version Validation

Run `node scripts/release-version-check.js` before publishing a release to verify:
- `package.json` version matches the git tag (if present)
- `update-manifest.json` version matches `package.json` (if present)

```bash
# Pre-release validation
node scripts/release-version-check.js --tag v0.5.0

# Post-release validation (with existing manifest)
node scripts/release-version-check.js --manifest-path update-manifest.json
```


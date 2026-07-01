# Miso Chat

<p align="center">
  <img src="https://img.shields.io/docker/v/ghcr.io/misospace/miso-chat?sort=semver&label=ghcr" alt="GHCR">
  <img src="https://github.com/misospace/miso-chat/actions/workflows/build.yaml/badge.svg" alt="Build">
  <img src="https://img.shields.io/github/v/release/misospace/miso-chat?sort=semver" alt="Release">
  <img src="https://img.shields.io/github/license/misospace/miso-chat" alt="License">
</p>

> Chat with your OpenClaw AI assistant from anywhere, protected by authentication.

## Features

- 🔐 **Authentication**: OIDC (Authentik, Okta, Google) + local username/password fallback
- 💬 **Real-time chat**: WebSocket connection to OpenClaw gateway
- 📱 **Mobile-friendly**: PWA-style responsive UI with native app feel
- 🔔 **Background alerts**: Optional browser notifications + sounds for assistant replies when tab is hidden
- 🐳 **Containerized**: Docker + Kubernetes deployment ready
- 🔒 **Security hardened**: Non-root user, rate limiting, XSS protection
- 🤖 **Automated**: CI/CD with linting, testing, and multi-platform builds
- 📲 **OTA Updates**: Automatic over-the-air updates for native mobile apps (no external service required)

## Quick Start

### Docker Compose

```bash
git clone https://github.com/misospace/miso-chat.git
cd miso-chat
cp .env.example .env
docker-compose up -d
```

### Docker

```bash
docker run -d --name miso-chat \
  -p 3000:3000 \
  -v miso-chat-data:/app/data \
  -e GATEWAY_URL=ws://your-gateway:18789 \
  -e SESSION_SECRET=your-secret \
  ghcr.io/misospace/miso-chat:latest

> **Note:** The image runs as a non-root `node` user and includes a healthcheck on `/api/health`.
> Mount `/app/data` to persist the SQLite database across container restarts.
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_URL` | Yes | - | WebSocket URL to OpenClaw gateway |
| `PORT` | No | `3000` | Server port |
| `SESSION_SECRET` | Yes | - | Secret for sessions |
| `SESSION_COOKIE_SAMESITE` | No | `strict` (or `lax` when OIDC enabled) | Session cookie SameSite policy (`strict|lax|none`) |
| `SESSION_COOKIE_SECURE` | No | `true` in production | Override session cookie `Secure` flag |
| `CSRF_TRUSTED_ORIGINS` | No | - | Comma-separated extra origins allowed for state-changing requests |
| `OIDC_ENABLED` | No | `false` | Enable OIDC auth |
| `LOCAL_USERS` | If local | `admin:password123` | Users (user:pass) |
| `REDIS_URL` | **Yes in production** | - | Redis/Dragonfly session store (required for production) |
| `ALLOW_MEMORY_STORE` | No | `false` | Override production Redis requirement for development/testing |
| `CAPACITOR_COOKIES_ENABLED` | No | `true` | Enable Capacitor cookie bridge for native app builds |
| `PUSH_NOTIFICATIONS_ENABLED` | No | `false` | Reserved for future browser push support (production web-push NOT implemented) |
| `PUSH_VAPID_PUBLIC_KEY` | If push enabled | - | Public VAPID key (reserved for future implementation) |
| `PUSH_VAPID_PRIVATE_KEY` | If push enabled | - | Private VAPID key (reserved for future implementation) |
| `PUSH_VAPID_SUBJECT` | If push enabled | - | Contact URI for VAPID claims (reserved for future implementation) |

## Gateway Scope Model

The miso-chat gateway WebSocket client requests OAuth scopes from the OpenClaw gateway on connect.

- **Default scopes** (least-privilege): `operator.read`, `operator.write` — sufficient for normal chat, session list, history, send, and abort operations.
- **Admin/pairing scopes**: `operator.admin`, `operator.pairing` — only requested when `GATEWAY_ADMIN_SCOPES=true` is set in the environment.

This reduces blast radius: if a web/session bug exposes gateway capabilities, the default configuration cannot perform admin or pairing actions.

**Note:** Earlier versions of miso-chat included `chat.send`, `sessions.send`, `sessions.list`, and `sessions.history` in `REQUESTED_GATEWAY_SCOPES`. These are gateway method names, not valid OAuth scopes, and were removed as non-scope entries. The OpenClaw gateway rejects invalid scope names; normal chat/session operations only require `operator.read` + `operator.write`.

### Migration path

Deployments that need admin or pairing features (e.g., device pairing flows, admin tooling) should set:

```bash
-e GATEWAY_ADMIN_SCOPES=true \
```

No code changes are required — the scope list is built at startup from the environment variable.


## Security

- Adds baseline HTTP hardening headers (`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`).
- Enforces origin checks on `POST/PUT/PATCH/DELETE` requests to reduce CSRF risk (configure extra trusted origins with `CSRF_TRUSTED_ORIGINS`).

```yaml
securityContext:
  runAsNonRoot: true
  runAsUser: 1000
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop:
      - ALL
```

## Development

```bash
npm install
npm run dev    # Development
npm run test   # Run tests
npm run lint   # Lint
```


## Mobile Session Persistence (Capacitor)

For native APK builds, session persistence depends on cookie handling between the WebView and backend:

- `capacitor.config.js` now enables `CapacitorCookies` by default (`CAPACITOR_COOKIES_ENABLED=true`).
- If the app runs from an app origin (`capacitor://` or custom scheme) and talks to a remote HTTPS API, set:
  - `SESSION_COOKIE_SAMESITE=none`
  - `SESSION_COOKIE_SECURE=true`
- `401` responses already trigger a login redirect in the client as a fallback when a session has expired.

## Background Notifications

Foreground browser notifications (tab-visible only; production web-push is NOT implemented yet).

- Open the top-right menu (`☰`) and toggle **Alerts** on.
- The app will ask for browser notification permission once.
- If notifications are blocked, allow them in site settings and re-enable Alerts.

> **Note:** This uses the native Browser Notification API while the page is loaded. Production
> background web-push (via VAPID/SW) is reserved for future implementation.
## Testing

### Post-Deploy Smoke Check

Verify deploy health, login flow, and send-message API path:

```bash
SMOKE_BASE_URL="https://miso-chat.example.com" \
SMOKE_USERNAME="admin" \
SMOKE_PASSWORD="your-password" \
npm run smoke:deploy
```

Optional overrides:
- `SMOKE_SESSION_KEY` (default: `default`)
- `SMOKE_MESSAGE` (default: timestamped smoke ping)
- `SMOKE_HEALTH_URL` (if health endpoint is not `/api/health`)
- `SMOKE_TIMEOUT_SECONDS` (default: `20`)

### WebSocket Reconnection

The `GatewayWsManager` includes automatic reconnection with exponential backoff:
- ✅ **Tested**: Connection loss recovery (server restart, network interruption)
- ✅ **Tested**: Exponential backoff delays (1s, 2s, 4s, 8s...)
- ✅ **Tested**: Max reconnection attempts limit (default: 5)
- ✅ **Tested**: Origin preservation across reconnections
- ✅ **Tested**: Event emission for `reconnecting`, `reconnect-error`, `reconnect-failed`

Manual testing performed by:
1. Starting miso-chat with active gateway connection
2. Stopping the OpenClaw gateway service
3. Observing reconnection attempts in logs
4. Restarting gateway - connection automatically restored

See: `lib/gateway-ws.js` for implementation details (issue #111, parent #110)

### WebSocket Persistence

**Issue #115** - WebSocket connection persistence and behavior testing.

The Gateway connection maintains persistent state across disruptions:

| Scenario | Behavior | Status |
|----------|----------|--------|
| Gateway restart | Auto-reconnect with exponential backoff | ✅ Tested |
| Network interruption (brief) | Reconnection after 1s → 2s → 4s... | ✅ Tested |
| Network interruption (extended) | Max 5 attempts, then `reconnect-failed` | ✅ Tested |
| Browser sleep/wake | Connection resumes if within retry window | ✅ Tested |
| Server-side close (1000/1001) | Clean close, no reconnect | ✅ Tested |
| Server-side error (1011) | Triggers reconnect sequence | ✅ Tested |

**Persistence Configuration:**
```javascript
const manager = new GatewayWsManager({
  maxReconnectAttempts: 5,    // Max retries before giving up
  reconnectDelay: 1000,       // Initial delay (ms)
  reconnectBackoff: 2,        // Exponential multiplier
  // Max delay = 1000 * 2^4 = 16000ms (16s) on final attempt
});
```

**Events for Monitoring:**
```javascript
manager.on('reconnecting', (attempt, delay) => {
  console.log(`Reconnecting in ${delay}ms (attempt ${attempt})`);
});

manager.on('reconnect-failed', (err) => {
  console.log('Giving up - manual intervention needed');
});
```

**Pending Request Handling:**
- In-flight requests during disconnect → timeout after 30s (configurable)
- Requests queued while disconnected → immediate error
- Successful reconnect does not retry failed requests (client responsibility)

## API Endpoints

### Sessions
- `GET /api/sessions` - List all sessions
- `GET /api/sessions/:sessionKey/history` - Get session message history
- `POST /api/sessions/:sessionKey/send` - Send a message

### Reactions
- `GET /api/reactions/:sessionKey` - Get all reactions for a session
- `GET /api/messages/:messageId/reactions` - Get reactions for a message (optionally scoped with `?sessionKey=...`)
- `POST /api/messages/:messageId/reactions` - Toggle a reaction (add/remove)
- Investigation notes for gateway reaction notifications: [`docs/reaction-events-investigation.md`](docs/reaction-events-investigation.md)

## Contributing & Releases

### Before Release Checklist
- [ ] Update version in package.json
- [ ] Ensure all tests pass (`npm test`)
- [ ] Run linting (`node --check server.js`)
- [ ] Check for security vulnerabilities (`npm audit`)
- [ ] Verify README.md is current (changelog, config table, OTA docs)
- [ ] Test WebSocket reconnection manually

### Issues & PRs
- [Open Issues](https://github.com/misospace/miso-chat/issues)
- [Open PRs](https://github.com/misospace/miso-chat/pulls)

## Changelog

### v0.4.19 (2026-06-23)
- Restore shared session access

### v0.4.18 (2026-06-23)
- Restore frontend startup

### v0.4.17 (2026-06-22)
- Fix render-utils.js module not defined and Rocket Loader script conflict

### v0.4.16 (2026-06-22)
- Release pipeline: support publish recovery, recognize app PR authors, detect missing tags, avoid tag visibility race
- Fix service worker serving stale HTML with old CSP headers
- Fix invalid action SHAs in android-release workflow

### v0.4.15 (2026-06-22)
- Route manual-release through PR + auto-merge
- Remove CSP nonce that blocks inline scripts
- Commit missing JS files (present in Docker image but not git)
- Automate protected releases

### v0.4.14 (2026-06-16)
- Harden mobile OTA manifest trust with validation
- Add session/operation authorization boundary and route-level CSRF tokens
- Consolidate update manager, remove stale APK logic
- Add SESSION_COOKIE_DOMAIN env var for subdomain isolation
- Repair release/docs drift (changelog + OTA docs)
- Make lint actually run ESLint on server.js, lib/, and tests/
- Add authorization/integration test matrix
- Harden container runtime defaults

### v0.4.13 (2026-06-04)
- Added release runbook to AGENTS.md
- Updated `@capgo/capacitor-updater` 8.47.5 → 8.47.6
- Updated `actions/checkout` CI action v6.0.2 → v6.0.3

### v0.4.12 (2026-04-30)
- Fixed README (README drift corrections)
- fix(ws): infer `GATEWAY_WS_ORIGIN` from `CORS_ORIGIN` if not set

### v0.4.11 (2026-04-28)
- feat(chat): render YouTube embeds inline
- feat: add issue templates
- feat: add GPL-3.0 license
- fix(readme): update docker badge to ghcr
- fix(mobile): reload page after mobile auth callback to prevent 401 loop
- Migrated from `joryirving` to `misospace` org
- Feat/rename claude
- Fix xmldom high severity vulnerability
- Cap WebSocket reconnect backoff delay (#446)
- Add AGENTS.md for agent guidance
- Security audit fixes for issue #449

### v0.4.10 (2026-04-04)
- fix(mobile): restore native onboarding and OTA affordance
- fix(chat): strip tool output from rendered history
- fix(chat): partial fix for #407 live send sanitization

### v0.4.9 (2026-03-31)
- fix(mobile): stop auth loop and hide tool output

### v0.4.8 (2026-03-31)
- fix(mobile): restore onboarding and auth callback flow

### v0.4.7 (2026-03-31)
- fix(ui): restore grouped session picker and agent naming
- fix(chat): bypass broken stream send queue path

### v0.4.6 (2026-03-30)
- Fix #354: Integrate OTA update manager and add documentation
- fix(chat): add retry controls for failed sends
- fix(chat): prevent duplicate pending messages on reconnect (fixes #365)
- Fix #363: Remove group chat UI and related flows
- fix(rate-limit): use express-rate-limit ipKeyGenerator for IPv6-safe key generation
- fix(chat): remove unsupported attachment composer affordance
- fix(chat): clarify connecting status text as OpenClaw gateway
- fix(chat): clarify OpenClaw Gateway URL in settings copy
- feat(release): add one-click manual release workflow
- fix(chat): clarify reaction buttons are local-only via aria-label
- feat(release): use bot auth for one-click release
- fix(server): restore release build startup banner
- fix(ci): repair release auth-smoke startup
- fix(ci): restore session api routes for auth smoke
- fix(chat): restore UI/gateway contract regressions
- fix(ws): use gateway-compatible client id
- fix(ws): send gateway device auth during connect
- fix(ui): restore header control handlers
- fix(chat): restore assistant header and message rendering
- fix(chat): restore gateway send and history contract
- fix(chat): send correct fallback message payload

### v0.4.5 (2026-03-20)
- fix: handle mobile auth callback on cold app launch
- fix(debug): show mobile auth traces in browser console on web
- fix(ota): publish web bundles to Capgo + default auto updates
- feat(ota): self-hosted Capacitor OTA via GitHub release assets

### v0.4.4 (2026-03-20)
- Added auto-bump workflow for package.json
- Added debug logging to mobile auth endpoint
- ci: generate and manage release notes via separate workflow

### v0.4.3 (2026-03-19)
- Fix version display and add group chat feature

### v0.4.2 (2026-03-19)
- fix: resolve 0.4.1 'Connecting...' frontend regression

### v0.4.1 (2026-03-19)
- fix: checkout release tag before reading version in android-release workflow
- fix: enhance message queue persistence with edge case handling
- feat: Add streaming response support via /send-stream endpoint
- docs: Add comprehensive wishlist improvement suggestions
- feat: add version number to footer
- Fix: Include all session kinds in sessions list
- feat: add multi-agent group chat endpoint

### v0.4.0 (2026-03-16)
- **WebSocket reconnection** with session state recovery
- fix: prevent auto-login after logout by forcing re-authentication
- feat: Add loading spinner for tool calls in progress
- fix: Improve notification sound playback and tab title updates (#306)

### v0.3.0 (2026-03-01)
- **#125**: Add reaction counts like Discord - reactions now show count badges
- **#126**: Add dark/light theme toggle with localStorage persistence
- Improved WebSocket reconnection on errors
- Fixed emoji picker background and positioning
- Typing indicator now responds to gateway events only

### v0.2.0 (2026-02-28)
- Initial release
- OIDC authentication support
- Real-time WebSocket chat
- Mobile-friendly PWA UI

## License

MIT License - see [LICENSE](LICENSE).


## Notes

- When running behind Envoy/Ingress over HTTPS, this app trusts one proxy hop for secure session cookies.
- WebSocket upgrades require an authenticated session (unauthenticated upgrades are rejected with 401).
- With OIDC enabled, `/login` redirects directly to `/auth/oidc`.

- Startup validation fails fast when OIDC is enabled but required env vars are missing.


### Home-ops tip (Dragonfly)

If you enable the `dragonfly` component in home-ops, set:

```yaml
env:
  REDIS_URL: "redis://{{ .Release.Name }}-dragonfly:6379"
```

In **production**, `REDIS_URL` is required — without it, miso-chat will refuse to start (fail-fast). This prevents silent data loss from in-memory session stores across restarts or multi-instance deployments.

For local development and testing, the in-memory store is used by default. If you need MemoryStore in production for a specific reason, set `ALLOW_MEMORY_STORE=true` to override the check.

## OTA Updates

Miso Chat supports automatic over-the-air (OTA) updates for native mobile apps using the self-hosted Capgo Capacitor Updater. No external service or API key required — updates are served from GitHub releases.

### How It Works

1. When a new release is published on GitHub, the update manager checks for updates
2. The server serves `update-manifest.json` from the latest release via `GET /api/mobile/update-manifest`
3. If an update is available, you'll see a notification in the app
4. Tap "Update Now" to download and install the update
5. The app restarts with the new version

### Requirements

- Native mobile app build (Android APK or iOS app)
- Capacitor platform with `@capgo/capacitor-updater` plugin installed
- GitHub release with `update-manifest.json` asset

### Server-Served Update Manifest

Since v0.4.x, miso-chat serves the update manifest from its own endpoint rather than having clients hit the GitHub API directly:

- **Endpoint:** `GET /api/mobile/update-manifest`
- **Cache:** Server caches the manifest for 5 minutes (configurable)
- **Fallback:** Client falls back to direct GitHub API lookup if the server is unavailable

**Environment Variables:**

| Variable | Default | Description |
|---|---|---|
| `MOBILE_UPDATE_REPO_OWNER` | `misospace` | GitHub org for update releases |
| `MOBILE_UPDATE_REPO_NAME` | `miso-chat` | GitHub repo for update releases |
| `MOBILE_UPDATE_CACHE_TTL_MS` | `300000` | Cache TTL in milliseconds (5 min) |

To switch to a different release source, set `MOBILE_UPDATE_REPO_OWNER` and `MOBILE_UPDATE_REPO_NAME`.

### Manual Update Check

To manually check for updates, call:

```javascript
await MobileUpdateManager.checkForUpdate();
```

### Update Notification

The update notification appears when:
- A new version is available
- The app is running on a native mobile platform
- `showNotification` is enabled in the config

### Configuration

The update manager can be configured with:

```javascript
await MobileUpdateManager.init({
  autoCheck: true,        // Automatically check for updates on startup
  showNotification: true, // Show update notification when available
  checkInterval: 3600000, // Check every hour (default)
  debug: false            // Enable debug logging
});
```

### Release Workflow

To publish an update, use the **Manual Release** GitHub Actions workflow and enter a version like `0.4.15`. It normalizes `v0.4.15` to `0.4.15`, opens a version-bump PR, and enables auto-merge. After the required checks pass, **Publish Release** tags the merged commit and creates the GitHub release with generated notes.

1. Run the `Manual Release` workflow with the target version
2. Follow the linked version-bump PR; it merges automatically after required checks pass
3. The publish workflow creates the plain-semver git tag (for example `0.4.15`)
4. Attach the APK/IPA and `update-manifest.json` to the created GitHub release if needed
5. The update manager will automatically detect the new version

### Troubleshooting

**Updates not appearing?**
- Check that the GitHub release includes `update-manifest.json`
- Verify the version number in `package.json` is higher than the current version
- Check browser console for update manager errors

**Update failed?**
- Ensure the APK/IPA is properly signed
- Check network connectivity
- Verify the `update-manifest.json` contains valid `bundleUrl`

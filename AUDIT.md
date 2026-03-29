# Pre-Release Audit: miso-chat 0.4.6

## Executive Summary

✅ **Release-ready** — No blocking issues found. The only fix needed was the APP_TITLE regression already addressed in this PR.

---

## Critical Findings

### 1. APP_TITLE Regression (FIXED)
**Root cause**: Partial refactor in commit `b18062e` deleted the `APP_TITLE` constant definition but left the startup banner referencing it.

**Fix applied**: Changed startup banner to use `APP_VERSION` instead (already defined, already working).

**Status**: ✅ Fixed in this PR

---

## Release Workflow Analysis

### Current Flow
1. Create tag from `main` (after bumping `package.json` manually or via PR)
2. `release.yaml` triggers on `release.published`
3. Auth-smoke test runs (boots server, tests login flow)
4. Multi-platform Docker build (amd64 + arm64)
5. Manifest merge
6. Optional deploy smoke check

### Observations
- ✅ Workflow is well-designed
- ✅ Auth-smoke catches startup failures (like the APP_TITLE bug)
- ✅ Multi-platform build is correct
- ⚠️ Requires manual `package.json` bump before tagging (user-friendly concern addressed)

### Recommendations
1. **Add one-click manual release workflow** — Uses bot app credentials to bypass branch protection
2. **Document the current manual process** in README for users who prefer control

---

## Environment Configuration

### Required Vars for Production
| Variable | Required | Notes |
|----------|----------|-------|
| `GATEWAY_URL` | Yes | WebSocket URL to OpenClaw gateway |
| `SESSION_SECRET` | Yes | 32+ char random string |
| `NODE_ENV` | No | Default: `production` |

### Optional but Recommended
| Variable | Purpose |
|----------|---------|
| `REDIS_URL` | Session persistence across restarts |
| `PUSH_VAPID_*` | Browser push notifications |
| `CSRF_TRUSTED_ORIGINS` | Extra origins for state-changing requests |
| `SESSION_COOKIE_SECURE` | Force Secure flag on cookies |

### Push Notifications
- ✅ Fails fast on startup if `PUSH_NOTIFICATIONS_ENABLED=true` but VAPID keys missing
- ✅ Good UX: prevents silent misconfiguration

---

## Security Audit

### Headers (security.js)
- ✅ `X-Content-Type-Options: nosniff`
- ✅ `X-Frame-Options: DENY`
- ✅ `Referrer-Policy: strict-origin-when-cross-origin`
- ✅ `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- ✅ CSP: `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`

### CSRF Protection
- ✅ Origin checks on `POST/PUT/PATCH/DELETE`
- ✅ Configurable via `CSRF_TRUSTED_ORIGINS`
- ✅ Session cookie SameSite: `strict` (or `lax` when OIDC enabled)

### Authentication
- ✅ Local auth with configurable users
- ✅ OIDC support (Authentik, Okta, Google)
- ✅ Session persistence before redirect (mobile auth race fix)
- ✅ OIDC deep-link handoff preserved for mobile

### Docker Security
- ✅ Non-root user (1000)
- ✅ `runAsNonRoot: true`
- ✅ `readOnlyRootFilesystem: true`
- ✅ `allowPrivilegeEscalation: false`
- ✅ `capabilities.drop: ALL`

---

## Mobile App (Capacitor)

### Configuration
- ✅ `CapacitorCookies` enabled by default
- ✅ Deep-link intent filter for OIDC callback (`misochat://auth/callback`)
- ✅ Configurable via `capacitor.config.js`

### Session Persistence
- ✅ For `app://` origin + remote API: `SESSION_COOKIE_SAMESITE=none` + `SESSION_COOKIE_SECURE=true`
- ✅ 401 triggers login redirect as fallback

### OTA Updates
- ✅ Capgo updater configured (manual or automatic)
- ✅ Update channel support (`stable`, `beta`, etc.)

---

## Tests

### Test Coverage
- ✅ `security.test.js` — Headers, CSRF checks
- ✅ `mobile-auth-regression.test.js` — Deep-link, token consumption, session persistence
- ✅ `reaction-events.test.js` — Telegram, Slack, Discord, Signal parsing
- ✅ `app.test.js` — Basic app smoke test

### CI Integration
- ✅ `npm run test:ci` runs all tests
- ✅ Auth-smoke validates login flow
- ✅ Tests pass on all platforms

---

## Known Limitations

### 1. No Auto-Bump Release Workflow
- Current process requires manual `package.json` bump before tagging
- User concern: "I'll forget otherwise"
- **Solution**: One-click workflow with bot app credentials (separate PR)

### 2. No Version Health Endpoint
- Deploy smoke check verifies `status=healthy` but doesn't check `version` field
- **Impact**: Can't confirm deployed version matches release tag
- **Fix**: Add `version` field to `/api/health` response

### 3. Rate Limiting Hardcoded
- `express-rate-limit` uses `max: 100` per 15min
- No config via env var
- **Impact**: Can't tune for high-traffic deployments

### 4. Gateway Connection Limits
- No explicit connection timeout or idle timeout config
- **Impact**: Stale connections may linger

---

## Version/Tag Consistency

### Current State
- ✅ `package.json` version = `0.4.6`
- ✅ Tag `0.4.6` exists
- ✅ Release workflow triggers on tag
- ✅ Image tagged with version

### Potential Issues
- ⚠️ No automated version sync between `package.json`, tag, and release notes
- ⚠️ Manual bump can be forgotten or mistyped

---

## Recommendations

### Must-Fix Before Release
1. ✅ APP_TITLE regression — **Already fixed in this PR**

### Should-Fix in Next PR
1. **Add `version` field to `/api/health`** — Enables deploy smoke to verify version match
2. **Add one-click manual release workflow** — Uses bot app credentials for direct `main` push
3. **Document release process** — Add "Manual Release" section to README

### Nice-to-Have
1. Configurable rate limit via env var
2. Add `version` to `/api/config` response (already exists for `APP_VERSION` in some places)
3. Connection timeout config for gateway WS

---

## Conclusion

**This release is ready to go.** The only blocking issue was the APP_TITLE regression, which is now fixed.

The repo is well-structured, tests are passing, and the release workflow is sound. The main user friction point (manual version bump) is a workflow issue, not a code issue, and can be addressed separately.

**Status**: ✅ **APPROVED FOR RELEASE**

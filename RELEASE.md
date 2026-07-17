# Release Process

## Versioning
This project uses [Semantic Versioning](https://semver.org/) (semver).

- **Major**: Breaking changes
- **Minor**: New features (backward compatible)
- **Patch**: Bug fixes

## Current Version
See `package.json` for the current version.

## Release Flow

### Patch Release (bug fixes)
```bash
npm version patch
git push && git push --tags
```

### Minor Release (new features)
```bash
npm version minor
git push && git push --tags
```

### Major Release (breaking changes)
```bash
npm version major
git push && git push --tags
```

## GitHub Releases
1. Create release from tag on GitHub
2. Add release notes
3. Image automatically tagged with version
4. `release.yaml` runs automated readiness checks:
   - semantic release tag validation
   - GHCR image existence for the release tag
   - optional deploy smoke check via `RELEASE_SMOKE_HEALTH_URL` secret

## Post-Deploy Smoke Check

Run this after each deploy to verify login + message path + API health:

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



## Android Release Signing

Android release builds (`assembleRelease` / `bundleRelease`) MUST be signed
with a real release keystore. The OTA update manifest advertises these
artifacts under the stable/beta channels and un-signed / debug-signed APKs
are rejected by Android on real devices, so the release build type fails fast
when signing is not configured instead of silently publishing an unsigned APK.

### How it works

`android/app/build.gradle` reads `android/key.properties` at configure time.
The properties file contains the keystore path and three passwords/aliases.
Both `android/key.properties` and `*.keystore` / `*.jks` are gitignored; a
template lives at `android/key.properties.example`.

When `android/key.properties` is missing, the release build type throws a
`GradleException` with a pointer at this section. When it is present, the
`signingConfigs.release` block is wired up and applied to the release build
type so the resulting APK / AAB is signed with the supplied keystore.

### Required GitHub Actions secrets

Configure these repository secrets before triggering a release. They are
consumed by `.github/workflows/android-release.yml`:

| Secret | Description |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | Base64-encoded contents of the release keystore file (e.g. `base64 -w0 release.keystore`). |
| `ANDROID_KEYSTORE_PASSWORD` | Password for the keystore. |
| `ANDROID_KEY_ALIAS` | Alias of the signing key inside the keystore. |
| `ANDROID_KEY_PASSWORD` | Password for the signing key. |

The workflow decodes `ANDROID_KEYSTORE_BASE64` to `android/app/release.keystore`
and writes a populated `android/key.properties` next to the file before
invoking `./gradlew assembleRelease` / `bundleRelease`. Without these
secrets the release job fails at the build step with a clear error pointing
back to this section.

### Local builds

To produce a signed release locally:

1. Generate (or copy) a release keystore, e.g. `keytool -genkey -v -keystore ~/keys/miso-release.jks -alias miso -keyalg RSA -keysize 2048 -validity 10000`.
2. Copy `android/key.properties.example` to `android/key.properties` and fill
   in `storeFile` (path relative to `android/app/`), `storePassword`,
   `keyAlias`, and `keyPassword`.
3. From `android/`, run `./gradlew assembleRelease`. The resulting APK lives
   at `app/build/outputs/apk/release/app-release.apk` and is signed with your
   keystore.

## Image Tags
| Event | Tag |
|-------|-----|
| Main branch | `latest` |
| Commit SHA | `main-{sha}` |
| PR | `pr-{number}` |
| Release v0.2.0 | `0.2.0`, `0.2`, `0` |

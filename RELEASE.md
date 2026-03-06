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

## Image Tags
| Event | Tag |
|-------|-----|
| Main branch | `latest` |
| Commit SHA | `main-{sha}` |
| PR | `pr-{number}` |
| Release v0.2.0 | `0.2.0`, `0.2`, `0` |

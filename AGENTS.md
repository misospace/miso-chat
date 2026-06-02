# AGENTS.md

## Repo-Specific Context

### Key Technologies
- **Runtime**: Node.js server (`server.js`)
- **WebSocket**: `ws` library with custom `GatewayWsManager` (`lib/gateway-ws.js`)
- **Gateway Connection**: WebSocket connection to OpenClaw Gateway at `ws://openclaw.llm.svc.cluster.local:18789`
- **Database**: SQLite via `lib/db.js`

### Environment Variables
- `GATEWAY_WS_URL`: WebSocket gateway URL (default: `ws://openclaw.llm.svc.cluster.local:18789`)
- `GATEWAY_WS_ORIGIN`: Origin header for gateway connection (default: `http://localhost:3000`)
- `GATEWAY_WS_WAIT_CHALLENGE_MS`: Challenge timeout in ms (default: 1200)
- `GATEWAY_WS_MAX_RECONNECT_ATTEMPTS`: Max reconnect attempts (0 = unlimited)

### WebSocket Connection Flow
1. Client opens WebSocket to gateway URL
2. Gateway sends `connect.challenge` event with nonce
3. Client responds with `connect` request using nonce and auth token
4. Gateway responds with connect ACK → connection established

### Release Process
miso-chat uses GitHub Actions for release automation. The `Manual Release` workflow (`.github/workflows/manual-release.yml`) handles version bump, git push (via bot token that bypasses branch protection), tag, and release creation in one shot.

#### Steps (preferred: GitHub Actions Manual Release)

Go to **Actions → Manual Release → Run workflow**, enter the version (e.g. `0.4.12`; `v` prefix is accepted and normalized).

The workflow handles the full sequence: version bump → commit to main (via bot token) → tag → release with auto-generated notes. The `Release Build & Verify` workflow (`.github/workflows/release.yaml`) then triggers on the published release and runs regression tests + auth smoke check.

#### Steps (CLI — branch-protection-safe fallback)

```bash
# Ensure main is up-to-date
git checkout main
git pull --ff-only --tags origin main

# Branch for the version bump
git checkout -b chore/release-v<version>

# Bump version
npm version <version> --no-git-tag-version --allow-same-version

# Validate
npm run lint
npm run test:ci
npm run release:readiness

# Commit and push branch
git add package.json package-lock.json
git commit -m "chore(release): bump version to <version>"
git push -u origin chore/release-v<version>

# Open PR and squash-merge
gh pr create --repo misospace/miso-chat --base main --head chore/release-v<version>   --title "chore(release): bump version to <version>"   --body "Version bump for release v<version>."
gh pr merge --repo misospace/miso-chat --squash --delete-branch

# After PR merge, tag and publish
git checkout main
git pull --ff-only --tags origin main
git tag <version>
git push origin <version>

# Create release
gh release create <version> --repo misospace/miso-chat --title "<version>" --generate-notes
```

#### Version source of truth

- `package.json` is canonical
- Tags use plain semver (e.g. `0.4.12`, no `v` prefix)

#### Validation gates

Before opening the version bump PR:
- `npm run lint` — syntax check all JS files
- `npm run test:ci` — all regression tests pass
- `npm run release:readiness` — image exists check + deploy smoke test


## Guidelines

- Be direct and practical
- Provide working solutions, not just suggestions
- When debugging WebSocket issues, check gateway logs first
- Write clean, maintainable code
- Security first — don't expose secrets

## Research Before Task

**Before working any task, research the problem space first.** This is not optional.

Research means: read related commits, check similar past fixes, understand the code areas involved. Do not guess. Do not start coding before you understand the problem.
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
- Tags use plain semver (e.g., `0.4.6`, no `v` prefix)
- Version in `package.json` is source of truth
- Prefer manual release workflow over ad-hoc tagging

## Guidelines

- Be direct and practical
- Provide working solutions, not just suggestions
- When debugging WebSocket issues, check gateway logs first
- Write clean, maintainable code
- Security first — don't expose secrets

## Research Before Task

**Before working any task, research the problem space first.** This is not optional.

Research means: read related commits, check similar past fixes, understand the code areas involved. Do not guess. Do not start coding before you understand the problem.
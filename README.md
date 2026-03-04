# Miso Chat

<p align="center">
  <img src="https://img.shields.io/docker/vize/joryirving/miso-chat?sort=semver&label=docker" alt="Docker">
  <img src="https://github.com/joryirving/miso-chat/actions/workflows/build.yaml/badge.svg" alt="Build">
  <img src="https://img.shields.io/github/v/release/joryirving/miso-chat?sort=semver" alt="Release">
  <img src="https://img.shields.io/github/license/joryirving/miso-chat" alt="License">
</p>

> Chat with your OpenClaw AI assistant from anywhere, protected by authentication.

## Features

- 🔐 **Authentication**: OIDC (Authentik, Okta, Google) + local username/password fallback
- 💬 **Real-time chat**: WebSocket connection to OpenClaw gateway
- 📱 **Mobile-friendly**: PWA-style responsive UI with native app feel
- 🐳 **Containerized**: Docker + Kubernetes deployment ready
- 🔒 **Security hardened**: Non-root user, rate limiting, XSS protection
- 🤖 **Automated**: CI/CD with linting, testing, and multi-platform builds

## Quick Start

### Docker Compose

```bash
git clone https://github.com/joryirving/miso-chat.git
cd miso-chat
cp .env.example .env
docker-compose up -d
```

### Docker

```bash
docker run -d --name miso-chat \
  -p 3000:3000 \
  -e GATEWAY_URL=ws://your-gateway:18789 \
  -e SESSION_SECRET=your-secret \
  ghcr.io/joryirving/miso-chat:latest
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GATEWAY_URL` | Yes | - | WebSocket URL to OpenClaw gateway |
| `PORT` | No | `3000` | Server port |
| `SESSION_SECRET` | Yes | - | Secret for sessions |
| `OIDC_ENABLED` | No | `false` | Enable OIDC auth |
| `LOCAL_USERS` | If local | `admin:password123` | Users (user:pass) |
| `REDIS_URL` | No | - | Optional Redis/Dragonfly session store |

## Security

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


## Testing

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
- `GET /api/messages/:messageId/reactions` - Get reactions for a message
- `POST /api/messages/:messageId/reactions` - Toggle a reaction (add/remove)
- Investigation notes for gateway reaction notifications: [`docs/reaction-events-investigation.md`](docs/reaction-events-investigation.md)

## Contributing & Releases

### Before Release Checklist
- [ ] Update CHANGELOG.md with changes
- [ ] Update version in package.json
- [ ] Ensure all tests pass (`npm test`)
- [ ] Run linting (`npm run lint`)
- [ ] Check for security vulnerabilities (`npm audit`)
- [ ] Verify README.md is current
- [ ] Test WebSocket reconnection manually

### Issues & PRs
- [Open Issues](https://github.com/joryirving/miso-chat/issues)
- [Open PRs](https://github.com/joryirving/miso-chat/pulls)

## Changelog

## Changelog

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

This is optional. If `REDIS_URL` is not set, miso-chat falls back to in-memory sessions.

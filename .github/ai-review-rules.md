# AI PR Review: miso-chat

## Security review conventions

miso-chat is a public, authenticated frontend to a self-hosted OpenClaw Gateway. Security-sensitive areas:

- **WebSocket Gateway** (`lib/gateway-ws.js`): authentication challenge flow, reconnect behavior, WS message handling
- **Authentication** (`server.js`): OIDC login, session regeneration, session secrets
- **Security middleware** (`security.js`): CSRF origin validation, security headers, CSP, origin normalization for native app schemes (`capacitor://`, `ionic://`, `app://`)
- **Message handling**: HTML escaping (`escapeHtml`, `sanitizeAssistantText`), length limits (`MAX_CHAT_MESSAGE_LENGTH`)
- **SSRF prevention** (`lib/ssrf-validation.js`): link preview endpoints, DNS rebinding protection
- **OTA/manifest integrity** (`lib/mobile-manifest-validator.js`, `lib/update-manager.js`): manifest schema validation, digest verification, release host trust
- **File serving**: Any public routes must sanitize paths and block directory traversal

For PRs that touch these areas, call out:
- Is input validated before use in sensitive operations?
- Are auth bypass routes intentionally public and narrowly scoped?
- Does a security issue address all stated threat cases from the linked issue, or are edge cases explicitly documented as out of scope?
- Is the `SECURITY_REVIEW.md` still accurate after the change?

## Review tone

- Be direct and practical.
- Flag only real defects, regressions, or meaningful risks as blocking.
- Do not nitpick formatting, naming, or style unless it affects readability or correctness.
- Prefer `approve` or non-blocking comments for PRs that look reasonable overall.

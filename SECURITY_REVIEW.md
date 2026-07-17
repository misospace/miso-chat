# Security Review - OpenClaw Chat

## Findings

### Critical
- [x] XSS in user messages (unescaped HTML) - Fixed: `escapeHtml()` in index.html and `sanitizeAssistantText()` in server.js
- [x] No CSRF protection on POST forms - Fixed: `csrfOriginCheck` middleware in security.js

### High
- [x] Session fixation (should regenerate after login) - Fixed: Session regenerated after OIDC login
- [x] WebSocket message size limits - Fixed: JSON body parser limited to 10kb
- [x] OIDC callback URL validation — Fixed: Production requires an explicit absolute HTTP(S) `OIDC_CALLBACK_URL`, preventing callback host injection through request headers.

### Medium
- [x] Missing security headers (Permissions-Policy, Referrer-Policy) - Fixed: All baseline headers implemented in security.js
- [x] No input length validation on messages - Fixed: `MAX_CHAT_MESSAGE_LENGTH` enforced (default: 4000 chars)

### Low
- [x] Error messages leak server info - Fixed: Generic error responses in production

## Implementation Details

### Security Middleware (security.js)
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- Content Security Policy with strict defaults
- CSRF origin validation for state-changing requests

### Input Validation
- Message length limited via `MAX_CHAT_MESSAGE_LENGTH` env var
- JSON payload limited to 10kb
- HTML escaping for rendered messages

### Session Security
- Sessions regenerated after successful OIDC authentication
- Secure cookie settings (httpOnly, secure in production)
- Configurable SameSite policy for cross-site deployments

### OIDC Authentication
- openid-client v6: automatic PKCE, discovery via `.well-known/openid-configuration`, verified id_token signatures
- Required `sub` claim enforced; username derived from `preferred_username` > `name` > `sub`
- Callback URL: production requires an explicit absolute HTTP(S) `OIDC_CALLBACK_URL`
- PKCE and token verification are handled by openid-client; callback URL validation is enforced separately by application configuration.

## Recommendations
1. ~~Add HTML escaping for user messages~~ ✅ Implemented
2. ~~Add CSRF protection~~ ✅ Implemented
3. ~~Regenerate session after successful login~~ ✅ Implemented
4. ~~Consider additional OIDC callback URL whitelist validation~~ ✅ Enforced via `OIDC_CALLBACK_URL` env validation in production
5. ~~Add input length limits~~ ✅ Implemented

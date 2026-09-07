# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please send an email to the repository owner. All security vulnerabilities will be promptly addressed.

Please include the following:
- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Any suggested fixes (optional)

## Security Best Practices

### Container Security

This container runs as a non-root user by default.

Recommended deployment configuration:

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

### Environment Variables

Never commit secrets to version control. Use:

- Kubernetes Secrets
- HashiCorp Vault
- AWS Secrets Manager
- GitHub Secrets

Required environment variables:
- `GATEWAY_URL` - OpenClaw WebSocket gateway
- `SESSION_SECRET` - Random string for session encryption

### Network

- Always run behind a reverse proxy with TLS
- Configure firewall rules to restrict access
- Use network policies in Kubernetes

### Authentication

- Change default passwords immediately
- Use strong, unique passwords
- Enable OIDC for production deployments
- Rotate secrets regularly

## Authentication model & session authorization

miso-chat authorizes session operations at the **deployment boundary**, not per
user. Once a request is authenticated (local username/password or OIDC), the
requester can read and write **every** session returned by the authenticated
`/api/sessions` endpoint — including sessions created by other users. There is
no per-user session isolation: `requireSessionAccess` (`lib/session-auth.js`)
checks only that the request is authenticated, never that the requesting user
owns the session key being accessed.

This is intentional. OpenClaw session keys use `agent:<agent-id>:<session-id>`,
and the agent ID is not a web username — OpenClaw does not expose per-user
ownership metadata. The model is correct for a **single-tenant** deployment
where the OIDC provider represents admin/operator roles and every authenticated
user is a trusted operator of the same workspace.

### Consequences for OIDC deployments that mint non-operator users

If your OIDC provider (Authentik, Keycloak, Okta, Auth0, Google, etc.) can mint
more than one human user, be aware that:

- **Every authenticated user sees every other user's session list and full
  message history.** A user invited to the workspace later (e.g. a junior
  engineer added for an incident) immediately gains read/write access to all
  existing sessions.
- **There is no per-user scoping of `/api/sessions`, session history, send,
  abort, or reaction endpoints.** Do not assume a user's sessions are private
  to that user.
- **Real-time events are not gated per user either.** Gateway events are
  broadcast to every connected SSE client (`/api/events`) regardless of session
  ownership — see `REALTIME-CONTRACT.md`.

If you need per-user isolation, do not rely on miso-chat's built-in
authorization: run one miso-chat deployment per user/tenant, or place a
per-user authorization layer in front of the API. The current model is a
deliberate trade-off for single-tenant operator deployments, not a bug.

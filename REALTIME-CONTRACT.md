# Realtime Health, SSE & WebSocket Contract

This document describes the realtime lifecycle contract between the miso-chat
backend (`server.js`, `lib/gateway-ws.js`) and frontend (`public/index.html`).
It covers health reporting, SSE event forwarding, and gateway WebSocket reconnect semantics.

## 1. `/api/health` — Backend health endpoint

**GET /api/health** (no auth required) returns a JSON object with three sections:

```jsonc
{
  "status": "healthy",                    // always "healthy" for the HTTP server itself
  "version": "0.5.0",                     // app version string
  "timestamp": "2026-05-18T11:00:00.000Z",

  "gatewayWs": {
    "connected": true,                    // boolean — protocol-level Gateway WS connected
    "connecting": false,                  // boolean — currently attempting to connect
    "reconnectAttempts": 2,               // number — consecutive reconnect attempts
    "pendingRequests": 0,                 // number — requests waiting for response
    "pendingForRecovery": 0,              // number — requests queued for resend on reconnect
    "lastError": null,                    // string | null — last error message
    "lastClose": {                        // object | null — last close event details
      "code": 1006,
      "reason": "abnormal closure",
      "at": "2026-05-18T10:59:30.000Z"
    }
  },

  "realtime": {
    "state": "healthy",                   // one of: "healthy" | "reconnecting" | "degraded" | "disconnected"
    "message": "Gateway WebSocket connected"
  }
}
```

### Realtime state values

| State | Meaning |
|---|---|
| `healthy` | Gateway WS is connected (`isConnected() === true`) |
| `reconnecting` | Gateway WS disconnected, reconnect attempts > 0 |
| `degraded` | Gateway WS not connected and there was a recent error |
| `disconnected` | Gateway WS not connected, no active reconnect attempt |

The frontend reads this endpoint (via `refreshBackendHealth()`) to update its
online/offline UI indicator.

## 2. SSE Event Forwarding — `/api/events`

**GET /api/events** (auth required) opens a Server-Sent Events connection that
forwards gateway WebSocket events to the browser.

### Lifecycle

1. Client creates `new EventSource('/api/events')`.
2. Server sends `data: {"event":"connected","data":{"ok":true},"timestamp":...}` on open.
3. Gateway WS manager emits `'gateway-event'` → server broadcasts to all SSE clients.
4. On SSE error, client waits 5 s then retries (single timer prevents duplicates).
5. On explicit close (`onclose`), client does **not** auto-reconnect.

### Duplicate prevention

`connectEventSource()` always:
- Closes any existing `EventSource` instance before creating a new one.
- Clears any pending reconnect timer (`sseReconnectTimer`) to avoid duplicate reconnection attempts.

## 3. Gateway WebSocket Pending Request Semantics

When the persistent Gateway WS connection drops, in-flight requests are handled as follows:

### On disconnect (while connected)

1. `_storePendingForRecovery()` — copies all `pendingRequests` entries into `_recoveryPending`.
2. Each entry stores `{ resolve, reject, timeout, frameData }` where `frameData` is the original
   `{ type, id, method, params }` frame JSON that was sent.

### On reconnect (after successful reconnection)

1. `_recoverPendingRequests()` is called from the `'connected'` handler in `connect()`.
2. For each recovered request with valid `frameData`:
   - The original frame is **resent** over the new socket connection.
   - A new timeout (`recoveredRequestTimeoutSeconds`, default 30 s) is set.
   - The entry is restored to `pendingRequests` so responses are matched correctly.
3. Requests without `frameData` (edge case) are rejected with `'Request could not be resent after reconnect'`.

### Configuration

- `recoveredRequestTimeoutSeconds` — timeout for recovered requests (seconds).
  - Constructor option: `{ recoveredRequestTimeoutSeconds: 60 }`
  - Environment variable: `GATEWAY_WS_RECOVERED_REQUEST_TIMEOUT_S=60`
  - Default: `30`

### Idempotency expectations

Clients should design their gateway method calls to be idempotent when possible,
since resent requests will arrive with the same request ID. The gateway treats
duplicate IDs as retries of the same logical operation.

## 4. Frontend Fallback Behavior

When the gateway is unavailable:

1. **Health polling** — `refreshBackendHealth()` runs periodically (on SSE reconnect,
   queue retry scheduling, and manual checks). It reads `/api/health` to determine
   if the gateway is reconnecting or fully disconnected.
2. **Message queueing** — Failed sends are queued in `localStorage` (`miso.pendingQueue`).
3. **SSE fallback** — On SSE error, `startHistoryPolling()` begins polling session history
   as a degraded real-time substitute.
4. **UI indicators** — The frontend displays:
   - `"Reconnecting to gateway…"` when health reports reconnect attempts > 0.
   - `"Gateway handshake failed (backend disconnected)"` when fully disconnected.
   - A queued-message count badge when pending items exist.

## 5. Quick Reference

| Component | File | Key Methods |
|---|---|---|
| Health endpoint | `server.js` | `/api/health` GET handler |
| WS manager | `lib/gateway-ws.js` | `connect()`, `send()`, `_recoverPendingRequests()` |
| SSE forwarder | `server.js` | `/api/events` handler, `broadcastToSseClients()` |
| Frontend SSE | `public/index.html` | `connectEventSource()`, `refreshBackendHealth()` |

## 6. Tests

| Test file | Covers |
|---|---|
| `tests/realtime-health-contract.test.js` | `/api/health` payload fields and structure |
| `tests/sse-reconnect-contract.test.js` | SSE duplicate prevention and reconnect behavior |
| `tests/gateway-ws-reconnect.test.js` | WS manager initial state, disconnect handling, recovery |
| `tests/gateway-ws-pending-resend.test.js` | Frame data storage, resend on reconnect, timeout config |

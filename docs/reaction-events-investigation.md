# Issue #174 — OpenClaw reaction events investigation

## Scope
Investigate whether OpenClaw gateway emits reaction events that miso-chat can consume for frontend rendering.

## Findings

### 1) Reactions are emitted as **system event text**, not structured chat payloads
OpenClaw channel monitors enqueue reaction notifications with `enqueueSystemEvent(...)`.

Examples from upstream source:

- Telegram: `Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42`
  - Source: `/app/src/telegram/bot-handlers.ts`
- Slack: `Slack reaction added: :thumbsup: by alice in #general msg 1732906502.139329 from bob`
  - Source: `/app/src/slack/monitor/events/reactions.ts`
- Discord: `Discord reaction added: ✅ by user#1234 on guild channel msg 12345`
  - Source: `/app/src/discord/monitor/listeners.ts`
- Signal: `Signal reaction added: 👍 by Alice msg 1717171717`
  - Source: `/app/src/signal/monitor.ts`

This means reaction updates currently arrive as plain text system events in session history, not as a dedicated typed object.

### 2) Gateway WS manager can forward arbitrary events, but no dedicated `reaction.*` UI contract exists here
miso-chat forwards gateway websocket events to SSE clients (`gateway-event` -> `/api/events`), but frontend handling currently only consumes typing/error signals.

- Server forward path: `server.js` (`gatewayWsManager.on('gateway-event', ...)`)
- Frontend SSE handling: `public/index.html` (`typing.start`, `typing.stop`, and `error`)

## Data shape observed today (text only)

Current practical shape is string-based and channel-specific:

```text
Telegram reaction added: <emoji> by <actor> on msg <messageId>
Slack reaction added|removed: :<emoji>: by <actor> in <channel> msg <messageTs> [from <author>]
Discord reaction added|removed: <emoji> by <actor> on <guild> <channel> msg <messageId> [from <author>]
Signal reaction added|removed: <emoji> by <actor> msg <messageId>
```

## Recommendation

For issue #175 (frontend display), parse these system-event strings into a normalized reaction object in miso-chat before rendering:

```json
{
  "channel": "telegram|slack|discord|signal",
  "action": "added|removed",
  "emoji": "👍",
  "actor": "Ada",
  "messageId": "42",
  "raw": "original system event text"
}
```

## Effort estimate

- Parsing + normalization in backend: **S (1-2 hours)**
- Frontend mapping/rendering on messages: **M (3-5 hours)**
- Edge-case tuning per channel format: **S-M (1-3 hours)**

Total implementation for #175 after this spike: **~1 day**.

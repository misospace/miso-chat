/**
 * lib/reaction-events-browser.js
 *
 * Browser-compatible version of reaction event parsing.
 *
 * This module provides a minimal, self-contained implementation of
 * parseGatewayReactionEvent for the browser. It is intentionally
 * simplified compared to lib/reaction-events.js (which has full
 * emoji-shortcodes integration) because:
 *
 * 1. The frontend already has EMOJI_SHORTCODES defined inline
 * 2. Reaction display is currently disabled (shouldShowReactions = false)
 * 3. Only parseGatewayReactionEvent is actively used in the browser
 *
 * Server/Frontend API Boundary
 * ----------------------------
 * parseGatewayReactionEvent defines the contract between gateway
 * system messages and the frontend reaction processor. Any changes
 * to the regex patterns or event format must be mirrored in both
 * lib/reaction-events.js (server) and this file (browser).
 * See issue #477 for tracking.
 */

(function () {
  'use strict';

  /* eslint-disable no-restricted-globals */
  var root = typeof globalThis !== 'undefined' ? globalThis : self;
  /* eslint-enable no-restricted-globals */

  // Minimal shortcode -> emoji map (subset of full EMOJI_SHORTCODES)
  // Only the shortcodes that appear in reaction events from external
  // channels (Slack, Discord, etc.) need to be resolved here.
  var SHORTCODE_MAP = {
    thumbs_up: '\uD83D\uDC4D',
    thumbsup: '\uD83D\uDC4D',
    thumbs_down: '\uD83D\uDC4E',
    thumbsdown: '\uD83D\uDC4E',
    '+1': '\uD83D\uDC4D',
    '-1': '\uD83D\uDC4E',
    clap: '\uD83D\uDC4F',
    heart: '\u2764\uFE0F',
    fire: '\uD83D\uDD25',
    star: '\u2B50',
    eyes: '\uD83D\uDC40',
    check: '\u2705',
    x: '\u274C',
    laugh: '\uD83D\uDE02',
    rofl: '\uD83E\uDD23',
  };

  function resolveShortcodeEmoji(shortcode) {
    var normalized = shortcode.trim().replace(/^:+|:+$/g, '').toLowerCase().replace(/-/g, '_');
    if (!normalized) return '';
    return SHORTCODE_MAP[normalized] || '';
  }

  function normalizeReactionEmoji(rawEmoji) {
    var value = String(rawEmoji || '').trim();
    if (!value) return '';
    var shortcodeMatch = value.match(/^:([^:]+):$/);
    if (!shortcodeMatch) return value;
    return resolveShortcodeEmoji(shortcodeMatch[1]) || value;
  }

  var REACTION_EVENT_MATCHERS = [
    {
      channel: 'telegram',
      regex: /^Telegram reaction (added|removed):\s+(.+?)\s+by\s+(.+?)\s+on\s+(?:msg|message)\s+([^\s]+)$/i,
      toEvent: function (m) {
        return { action: m[1].toLowerCase(), emoji: normalizeReactionEmoji(m[2]), actor: m[3], messageId: m[4] };
      },
    },
    {
      channel: 'slack',
      regex: /^Slack reaction (added|removed):\s+(:[^\s]+:|[^\s]+)\s+by\s+(.+?)\s+in\s+.+?\s+(?:msg|message)\s+([^\s]+)(?:\s+from\s+.+)?$/i,
      toEvent: function (m) {
        return { action: m[1].toLowerCase(), emoji: normalizeReactionEmoji(m[2]), actor: m[3], messageId: m[4] };
      },
    },
    {
      channel: 'discord',
      regex: /^Discord reaction (added|removed):\s+(.+?)\s+by\s+(.+?)\s+on\s+.+?\s+(?:msg|message)\s+([^\s]+)(?:\s+from\s+.+)?$/i,
      toEvent: function (m) {
        return { action: m[1].toLowerCase(), emoji: normalizeReactionEmoji(m[2]), actor: m[3], messageId: m[4] };
      },
    },
    {
      channel: 'signal',
      regex: /^Signal reaction (added|removed):\s+(.+?)\s+by\s+(.+?)\s+(?:on\s+)?(?:msg|message)\s+([^\s]+)$/i,
      toEvent: function (m) {
        return { action: m[1].toLowerCase(), emoji: normalizeReactionEmoji(m[2]), actor: m[3], messageId: m[4] };
      },
    },
  ];

  function parseGatewayReactionEvent(text) {
    var raw = String(text || '').trim();
    if (!raw) return null;

    for (var i = 0; i < REACTION_EVENT_MATCHERS.length; i++) {
      var matcher = REACTION_EVENT_MATCHERS[i];
      var matched = raw.match(matcher.regex);
      if (!matched) continue;
      var parsed = matcher.toEvent(matched);
      if (!parsed.messageId || !parsed.emoji) return null;
      return {
        channel: matcher.channel,
        action: parsed.action,
        emoji: parsed.emoji,
        actor: parsed.actor,
        messageId: String(parsed.messageId),
        raw: raw,
      };
    }

    return null;
  }

  // Expose globally for browser use (index.html calls these directly)
  root.parseGatewayReactionEvent = parseGatewayReactionEvent;
  root.normalizeReactionEmoji = normalizeReactionEmoji;
  root.REACTION_EVENT_MATCHERS = REACTION_EVENT_MATCHERS;
})();

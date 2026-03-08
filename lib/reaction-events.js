const { normalizeShortcode, resolveShortcode } = require('./emoji-shortcodes');

function resolveShortcodeEmoji(shortcode) {
  const normalized = normalizeShortcode(shortcode).replace(/-/g, '_');
  if (!normalized) return '';

  return resolveShortcode(normalized)
    || resolveShortcode(normalized.replace(/^thumbsup$/, 'thumbs_up'))
    || resolveShortcode(normalized.replace(/^thumbsdown$/, 'thumbs_down'))
    || '';
}

function normalizeReactionEmoji(rawEmoji) {
  const value = String(rawEmoji || '').trim();
  if (!value) return '';

  const shortcodeMatch = value.match(/^:([^:]+):$/);
  if (!shortcodeMatch) return value;

  return resolveShortcodeEmoji(shortcodeMatch[1]) || value;
}

const REACTION_EVENT_MATCHERS = [
  {
    channel: 'telegram',
    regex: /^Telegram reaction (added|removed):\s+(.+?)\s+by\s+(.+?)\s+on\s+(?:msg|message)\s+([^\s]+)$/i,
  },
  {
    channel: 'slack',
    regex: /^Slack reaction (added|removed):\s+(:[^\s]+:|[^\s]+)\s+by\s+(.+?)\s+in\s+.+?\s+(?:msg|message)\s+([^\s]+)(?:\s+from\s+.+)?$/i,
  },
  {
    channel: 'discord',
    regex: /^Discord reaction (added|removed):\s+(.+?)\s+by\s+(.+?)\s+on\s+.+?\s+(?:msg|message)\s+([^\s]+)(?:\s+from\s+.+)?$/i,
  },
  {
    channel: 'signal',
    regex: /^Signal reaction (added|removed):\s+(.+?)\s+by\s+(.+?)\s+(?:on\s+)?(?:msg|message)\s+([^\s]+)$/i,
  },
];

function parseGatewayReactionEvent(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  for (const matcher of REACTION_EVENT_MATCHERS) {
    const matched = raw.match(matcher.regex);
    if (!matched) continue;

    const action = String(matched[1] || '').toLowerCase();
    const emoji = normalizeReactionEmoji(matched[2]);
    const actor = String(matched[3] || '').trim();
    const messageId = String(matched[4] || '').trim();

    if (!action || !emoji || !messageId) return null;

    return {
      channel: matcher.channel,
      action,
      emoji,
      actor,
      messageId,
      raw,
    };
  }

  return null;
}

module.exports = {
  parseGatewayReactionEvent,
  normalizeReactionEmoji,
  REACTION_EVENT_MATCHERS,
};

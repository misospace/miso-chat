/**
 * Emoji shortcode index
 *
 * Issue: #171
 * Maps common shortcode tokens to emoji characters.
 */

const EMOJI_SHORTCODES = Object.freeze({
  smile: '😀',
  smiley: '😃',
  grin: '😁',
  joy: '😂',
  rofl: '🤣',
  blush: '😊',
  innocent: '😇',
  heart_eyes: '😍',
  kissing_heart: '😘',
  thinking: '🤔',
  neutral_face: '😐',
  expressionless: '😑',
  rolling_eyes: '🙄',
  smirk: '😏',
  disappointed: '😞',
  cry: '😢',
  sob: '😭',
  scream: '😱',
  angry: '😠',
  rage: '🤬',
  poop: '💩',
  thumbs_up: '👍',
  '+1': '👍',
  thumbs_down: '👎',
  '-1': '👎',
  clap: '👏',
  wave: '👋',
  pray: '🙏',
  muscle: '💪',
  heart: '❤️',
  broken_heart: '💔',
  fire: '🔥',
  star: '⭐',
  sparkles: '✨',
  boom: '💥',
  eyes: '👀',
  hundred: '💯',
  check: '✅',
  x: '❌',
  warning: '⚠️',
  tada: '🎉',
  party_popper: '🎉',
  rocket: '🚀',
  wave_goodbye: '👋',
  coffee: '☕',
  beer: '🍺',
  pizza: '🍕',
  laptop: '💻',
  bug: '🐛',
  wrench: '🔧',
  lock: '🔒',
  unlock: '🔓',
});

function normalizeShortcode(shortcode = '') {
  return String(shortcode).trim().replace(/^:+|:+$/g, '').toLowerCase();
}

function resolveShortcode(shortcode = '') {
  const key = normalizeShortcode(shortcode);
  return key ? EMOJI_SHORTCODES[key] || null : null;
}

function searchShortcodes(query = '', limit = 8) {
  const normalized = normalizeShortcode(query);
  if (!normalized) return [];

  const results = [];
  for (const [shortcode, emoji] of Object.entries(EMOJI_SHORTCODES)) {
    if (shortcode.includes(normalized)) {
      results.push({ shortcode, emoji });
      if (results.length >= limit) break;
    }
  }

  return results;
}

module.exports = {
  EMOJI_SHORTCODES,
  normalizeShortcode,
  resolveShortcode,
  searchShortcodes,
};

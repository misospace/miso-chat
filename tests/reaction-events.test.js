const test = require('node:test');
const assert = require('node:assert/strict');

const { parseGatewayReactionEvent, normalizeReactionEmoji } = require('../lib/reaction-events');

test('parses Telegram reaction events with msg and message keywords', () => {
  const withMsg = parseGatewayReactionEvent('Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42');
  const withMessage = parseGatewayReactionEvent('Telegram reaction removed: 👍 by Ada (@ada_bot) on message 43');

  assert.deepEqual(withMsg, {
    channel: 'telegram',
    action: 'added',
    emoji: '👍',
    actor: 'Ada (@ada_bot)',
    messageId: '42',
    raw: 'Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42',
  });

  assert.deepEqual(withMessage, {
    channel: 'telegram',
    action: 'removed',
    emoji: '👍',
    actor: 'Ada (@ada_bot)',
    messageId: '43',
    raw: 'Telegram reaction removed: 👍 by Ada (@ada_bot) on message 43',
  });
});

test('parses Slack reaction events and resolves shortcode emoji', () => {
  const parsed = parseGatewayReactionEvent('Slack reaction added: :thumbsup: by alice in #general message 1732906502.139329 from bob');

  assert.deepEqual(parsed, {
    channel: 'slack',
    action: 'added',
    emoji: '👍',
    actor: 'alice',
    messageId: '1732906502.139329',
    raw: 'Slack reaction added: :thumbsup: by alice in #general message 1732906502.139329 from bob',
  });
});

test('parses Slack :white_check_mark: reaction events into unicode emoji', () => {
  const event = parseGatewayReactionEvent(
    'Slack reaction added: :white_check_mark: by alice in #general msg 1732906502.139329 from bob'
  );

  assert.deepEqual(event, {
    channel: 'slack',
    action: 'added',
    emoji: '✅',
    actor: 'alice',
    messageId: '1732906502.139329',
    raw: 'Slack reaction added: :white_check_mark: by alice in #general msg 1732906502.139329 from bob',
  });
});

test('keeps unknown shortcodes untouched for diagnostics', () => {
  const event = parseGatewayReactionEvent(
    'Slack reaction added: :custom_team_emoji: by miso in #chat msg 12345'
  );

  assert.equal(event.emoji, ':custom_team_emoji:');
});

test('parses Discord reaction events with message keyword', () => {
  const parsed = parseGatewayReactionEvent('Discord reaction removed: ✅ by user#1234 on guild channel message 12345');

  assert.deepEqual(parsed, {
    channel: 'discord',
    action: 'removed',
    emoji: '✅',
    actor: 'user#1234',
    messageId: '12345',
    raw: 'Discord reaction removed: ✅ by user#1234 on guild channel message 12345',
  });
});

test('parses Signal reaction events with optional on keyword', () => {
  const parsed = parseGatewayReactionEvent('Signal reaction added: 👍 by Alice on message 1717171717');

  assert.deepEqual(parsed, {
    channel: 'signal',
    action: 'added',
    emoji: '👍',
    actor: 'Alice',
    messageId: '1717171717',
    raw: 'Signal reaction added: 👍 by Alice on message 1717171717',
  });
});

test('normalizeReactionEmoji keeps non-shortcode emoji intact and resolves known shortcode aliases', () => {
  assert.equal(normalizeReactionEmoji('✅'), '✅');
  assert.equal(normalizeReactionEmoji(':thumbsup:'), '👍');
  assert.equal(normalizeReactionEmoji(':thumbs-up:'), '👍');
  assert.equal(normalizeReactionEmoji(':unknown_shortcode:'), ':unknown_shortcode:');
});

test('returns null for non-reaction system text', () => {
  const parsed = parseGatewayReactionEvent('Gateway connected successfully');
  assert.equal(parsed, null);
});

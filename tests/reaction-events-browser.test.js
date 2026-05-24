const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Tests for lib/reaction-events-browser.js
 *
 * Since this module is designed for browser use (IIFE that attaches to globalThis/self),
 * we run it in a vm context to simulate the browser environment.
 */

// Create a sandbox that mimics the browser global scope
function createBrowserSandbox() {
  const sandbox = {
    globalThis: {},
    self: {},
    console,
    String,
    Number,
    Boolean,
    Object,
    Array,
    RegExp,
    Math,
    parseInt,
    parseFloat,
    isNaN,
    undefined,
    null: null,
  };

  // Make globalThis and self reference each other (browser behavior)
  sandbox.self.globalThis = sandbox.globalThis;
  sandbox.globalThis.self = sandbox.self;

  return sandbox;
}

// Load and execute the browser module in the sandbox
function loadBrowserModule() {
  const sandbox = createBrowserSandbox();
  const modulePath = path.join(__dirname, '..', 'lib', 'reaction-events-browser.js');
  const moduleSource = fs.readFileSync(modulePath, 'utf8');

  // Run the IIFE in the sandbox context
  vm.runInNewContext(moduleSource, sandbox);

  return {
    parseGatewayReactionEvent: sandbox.globalThis.parseGatewayReactionEvent,
    normalizeReactionEmoji: sandbox.globalThis.normalizeReactionEmoji,
    REACTION_EVENT_MATCHERS: sandbox.globalThis.REACTION_EVENT_MATCHERS,
  };
}

const { parseGatewayReactionEvent, normalizeReactionEmoji, REACTION_EVENT_MATCHERS } = loadBrowserModule();

// --- parseGatewayReactionEvent smoke tests ---

test('parseGatewayReactionEvent parses Telegram reaction events', () => {
  const parsed = parseGatewayReactionEvent('Telegram reaction added: 👍 by Ada (@ada_bot) on msg 42');

  assert.equal(parsed.channel, 'telegram');
  assert.equal(parsed.action, 'added');
  assert.equal(parsed.emoji, '👍');
  assert.equal(parsed.actor, 'Ada (@ada_bot)');
  assert.equal(parsed.messageId, '42');
});

test('parseGatewayReactionEvent parses Telegram message keyword', () => {
  const parsed = parseGatewayReactionEvent('Telegram reaction removed: 👍 by Ada on message 43');

  assert.equal(parsed.channel, 'telegram');
  assert.equal(parsed.action, 'removed');
  assert.equal(parsed.messageId, '43');
});

test('parseGatewayReactionEvent parses Slack reaction events', () => {
  const parsed = parseGatewayReactionEvent('Slack reaction added: :thumbsup: by alice in #general message 1732906502.139329 from bob');

  assert.equal(parsed.channel, 'slack');
  assert.equal(parsed.action, 'added');
  assert.equal(parsed.emoji, '👍');
  assert.equal(parsed.actor, 'alice');
});

test('parseGatewayReactionEvent parses Discord reaction events', () => {
  const parsed = parseGatewayReactionEvent('Discord reaction removed: ✅ by user#1234 on guild channel message 12345');

  assert.equal(parsed.channel, 'discord');
  assert.equal(parsed.action, 'removed');
  assert.equal(parsed.emoji, '✅');
});

test('parseGatewayReactionEvent parses Signal reaction events', () => {
  const parsed = parseGatewayReactionEvent('Signal reaction added: 👍 by Alice on message 1717171717');

  assert.equal(parsed.channel, 'signal');
  assert.equal(parsed.action, 'added');
  assert.equal(parsed.emoji, '👍');
});

test('parseGatewayReactionEvent returns null for non-reaction text', () => {
  const parsed = parseGatewayReactionEvent('Gateway connected successfully');
  assert.equal(parsed, null);
});

test('parseGatewayReactionEvent returns null for empty input', () => {
  assert.equal(parseGatewayReactionEvent(''), null);
  assert.equal(parseGatewayReactionEvent(null), null);
  assert.equal(parseGatewayReactionEvent(undefined), null);
});

// --- normalizeReactionEmoji smoke tests ---

test('normalizeReactionEmoji keeps unicode emoji intact', () => {
  assert.equal(normalizeReactionEmoji('👍'), '👍');
  assert.equal(normalizeReactionEmoji('✅'), '✅');
});

test('normalizeReactionEmoji resolves known shortcodes', () => {
  assert.equal(normalizeReactionEmoji(':thumbsup:'), '👍');
  assert.equal(normalizeReactionEmoji(':thumbs_up:'), '👍');
  assert.equal(normalizeReactionEmoji(':+1:'), '👍');
  // Note: :-1: is NOT resolved because - gets replaced with _ making it _1 (not in map)
});

test('normalizeReactionEmoji keeps unknown shortcodes untouched', () => {
  assert.equal(normalizeReactionEmoji(':custom_emoji:'), ':custom_emoji:');
});

// --- REACTION_EVENT_MATCHERS smoke test ---

test('REACTION_EVENT_MATCHERS has entries for all channels', () => {
  assert.ok(Array.isArray(REACTION_EVENT_MATCHERS));
  assert.equal(REACTION_EVENT_MATCHERS.length, 4);

  const channels = REACTION_EVENT_MATCHERS.map((m) => m.channel);
  assert.ok(channels.includes('telegram'));
  assert.ok(channels.includes('slack'));
  assert.ok(channels.includes('discord'));
  assert.ok(channels.includes('signal'));
});

// --- Browser module IIFE smoke test ---

test('browser module does not leak to Node.js global scope', () => {
  // The browser module should only attach to globalThis/self in the vm context.
  // In this test process, parseGatewayReactionEvent should NOT be on globalThis.
  assert.equal(typeof globalThis.parseGatewayReactionEvent, 'undefined');
  assert.equal(typeof globalThis.normalizeReactionEmoji, 'undefined');
});

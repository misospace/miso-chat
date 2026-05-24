const test = require('node:test');
const assert = require('node:assert/strict');

const {
  escapeHtml,
  normalizedLang,
  protectTokenMatches,
  restoreTokenMatches,
  highlightCode,
  encodeCopyPayload,
  decodeCopyPayload,
} = require('../lib/render-utils');

// --- escapeHtml ---

test('escapeHtml escapes &, <, > characters', () => {
  assert.equal(escapeHtml('<div> & "test" </div>'), '&lt;div&gt; &amp; "test" &lt;/div&gt;');
});
test('escapeHtml handles &, <, > without escaping quotes', () => {
  assert.equal(escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});

test('escapeHtml returns empty string for null/undefined', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml is identity for safe strings', () => {
  assert.equal(escapeHtml('hello world 123'), 'hello world 123');
});

// --- normalizedLang ---

test('normalizedLang normalizes JS variants to javascript', () => {
  assert.equal(normalizedLang('js'), 'javascript');
  assert.equal(normalizedLang('jsx'), 'javascript');
  assert.equal(normalizedLang('mjs'), 'javascript');
  assert.equal(normalizedLang('cjs'), 'javascript');
});

test('normalizedLang normalizes TS variants to typescript', () => {
  assert.equal(normalizedLang('ts'), 'typescript');
  assert.equal(normalizedLang('tsx'), 'typescript');
});

test('normalizedLang normalizes shell variants to bash', () => {
  assert.equal(normalizedLang('sh'), 'bash');
  assert.equal(normalizedLang('zsh'), 'bash');
});

test('normalizedLang normalizes yml to yaml', () => {
  assert.equal(normalizedLang('yml'), 'yaml');
});

test('normalizedLang lowercases and trims input', () => {
  assert.equal(normalizedLang('  JavaScript  '), 'javascript');
  assert.equal(normalizedLang('JSON'), 'json');
});

test('normalizedLang passes through unknown values', () => {
  assert.equal(normalizedLang('python'), 'python');
  assert.equal(normalizedLang('rust'), 'rust');
  assert.equal(normalizedLang(''), '');
});

// --- protectTokenMatches / restoreTokenMatches ---

test('protectTokenMatches replaces matches with placeholders', () => {
  const { out, tokens } = protectTokenMatches('hello world', [
    { regex: /\bworld\b/g, className: 'word' },
  ]);

  assert.equal(out, 'hello __TOK_0__');
  assert.equal(tokens.length, 1);
  assert.ok(tokens[0].includes('world'));
});

test('restoreTokenMatches restores placeholders to original tokens', () => {
  const tokens = ['<span class="word">world</span>'];
  const result = restoreTokenMatches('hello __TOK_0__', tokens);
  assert.equal(result, 'hello <span class="word">world</span>');
});

test('restoreTokenMatches handles missing index gracefully', () => {
  const result = restoreTokenMatches('hello __TOK_99__', []);
  assert.equal(result, 'hello ');
});

test('protectTokenMatches preserves order across multiple patterns', () => {
  const { out, tokens } = protectTokenMatches('a b c', [
    { regex: /a/g, className: 'first' },
    { regex: /b/g, className: 'second' },
  ]);

  assert.equal(tokens.length, 2);
  assert.ok(out.includes('__TOK_0__'));
  assert.ok(out.includes('__TOK_1__'));
});

// --- highlightCode ---

test('highlightCode escapes HTML in code blocks', () => {
  const result = highlightCode('<script>alert(1)</script>', '');
  assert.ok(result.includes('&lt;script&gt;'));
});

test('highlightCode highlights JS keywords', () => {
  const result = highlightCode('const x = 42;', 'javascript');
  assert.ok(result.includes('tok-keyword'));
  assert.ok(result.includes('tok-number'));
});

test('highlightCode highlights JS comments and strings', () => {
  const result = highlightCode('// comment\nconst s = "hello";', 'javascript');
  assert.ok(result.includes('tok-comment'));
  assert.ok(result.includes('tok-string'));
});

test('highlightCode handles JSON property highlighting', () => {
  const result = highlightCode('{"name": "test", "count": 42}', 'json');
  assert.ok(result.includes('tok-property'));
  assert.ok(result.includes('tok-string'));
  assert.ok(result.includes('tok-number'));
});

test('highlightCode handles YAML highlighting', () => {
  const result = highlightCode('# comment\nkey: true\nfoo: 123', 'yaml');
  assert.ok(result.includes('tok-comment'));
  assert.ok(result.includes('tok-property'));
  assert.ok(result.includes('tok-boolean'));
});

test('highlightCode handles Bash highlighting', () => {
  const result = highlightCode('#!/bin/bash\necho "hello"', 'bash');
  assert.ok(result.includes('tok-comment'));
  assert.ok(result.includes('tok-string'));
});

test('highlightCode returns plain text for unknown languages', () => {
  const result = highlightCode('some python code\nimport os', 'python');
  assert.equal(result, escapeHtml('some python code\nimport os'));
});

test('highlightCode handles empty input', () => {
  const result = highlightCode('', 'javascript');
  assert.equal(result, '');
});

test('highlightCode handles null/undefined input', () => {
  const result = highlightCode(null, 'javascript');
  assert.equal(result, '');
  const result2 = highlightCode(undefined, 'javascript');
  assert.equal(result2, '');
});

// --- encodeCopyPayload / decodeCopyPayload ---

test('encodeCopyPayload and decodeCopyPayload are inverses', () => {
  const payloads = [
    'hello world',
    'const x = 42;',
    '<script>alert("xss")</script>',
    'unicode: \u00e9\u00e8\u00ea',
    '',
    'a'.repeat(1000),
  ];

  payloads.forEach((text) => {
    const encoded = encodeCopyPayload(text);
    const decoded = decodeCopyPayload(encoded);
    assert.equal(decoded, text);
  });
});

test('encodeCopyPayload produces base64 string', () => {
  const encoded = encodeCopyPayload('test');
  // Should only contain base64 characters
  assert.ok(/^[A-Za-z0-9+/]*={0,2}$/.test(encoded));
});

test('decodeCopyPayload returns empty string for invalid input', () => {
  assert.equal(decodeCopyPayload(''), '');
  assert.equal(decodeCopyPayload('not-valid-base64!!!'), '');
  assert.equal(decodeCopyPayload(null), '');
  assert.equal(decodeCopyPayload(undefined), '');
});

// --- Integration: highlightCode preserves token integrity ---

test('highlightCode does not double-escape protected tokens', () => {
  // Strings containing HTML-like content should be escaped once, not twice
  const result = highlightCode('const html = "<div>";', 'javascript');
  // The string content should be escaped but the quotes inside should be preserved
  assert.ok(result.includes('tok-string'));
  assert.ok(!result.includes('&amp;lt;'));
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtmlPath = path.join(__dirname, '..', 'public', 'index.html');

function readIndexHtml() {
  return fs.readFileSync(indexHtmlPath, 'utf8');
}

// Issue #876 — the miso-chat header ("banner") should carry a GitHub icon so
// the repo is one click away from the app. The icon must render (inline SVG,
// no external asset fetch) and open the repo.

test('index.html header contains a GitHub icon linking to the miso-chat repo', () => {
  const html = readIndexHtml();

  const linkRe = /<a\s+[^>]*class="github-link"[^>]*>[\s\S]*?<\/a>/;
  const match = html.match(linkRe);
  assert.ok(match, 'header must contain a <a class="github-link"> element');

  const link = match[0];
  assert.match(
    link,
    /href="https:\/\/github\.com\/misospace\/miso-chat"/,
    'GitHub link must point at https://github.com/misospace/miso-chat',
  );
  assert.match(link, /<svg/, 'GitHub icon must be an inline SVG (no external image fetch)');
  assert.match(
    link,
    /aria-label="View on GitHub"/,
    'GitHub link must carry an accessible aria-label',
  );
});

test('GitHub icon anchor sits inside the header (banner) element', () => {
  const html = readIndexHtml();
  const headerStart = html.indexOf('<header class="header">');
  const headerEnd = html.indexOf('</header>');
  assert.ok(headerStart >= 0 && headerEnd > headerStart, 'header element must exist');

  const headerBlock = html.slice(headerStart, headerEnd);
  assert.ok(
    /<a\s+[^>]*class="github-link"/.test(headerBlock),
    'the GitHub icon must render inside the banner/header',
  );
  // The icon appears before the header controls so it reads as part of the banner.
  assert.ok(
    headerBlock.indexOf('class="github-link"') < headerBlock.indexOf('class="header-controls"'),
    'GitHub icon should precede the header controls in the banner',
  );
});

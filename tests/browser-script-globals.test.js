const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const publicRoot = path.resolve(publicDir);
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

test('classic browser scripts share a valid global lexical scope', () => {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  const sources = [];
  let match;

  while ((match = scriptPattern.exec(indexHtml)) !== null) {
    const attributes = match[1];
    if (/\btype=["']module["']/i.test(attributes)) continue;

    const srcMatch = attributes.match(/\bsrc=["']([^"']+)["']/i);
    if (srcMatch) {
      const sourcePath = path.resolve(publicRoot, srcMatch[1].replace(/^\//, ''));
      assert.ok(
        sourcePath.startsWith(`${publicRoot}${path.sep}`),
        `script source must stay within public/: ${srcMatch[1]}`
      );
      sources.push(fs.readFileSync(sourcePath, 'utf8'));
    } else {
      sources.push(match[2]);
    }
  }

  assert.ok(sources.length > 0, 'index.html should contain browser scripts');
  assert.doesNotThrow(
    () => new vm.Script(sources.join('\n;\n'), { filename: 'public/index.html scripts' }),
    'classic scripts must not redeclare global let/const bindings'
  );
});

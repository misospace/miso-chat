/**
 * lib/render-utils.js
 *
 * Frontend rendering utilities extracted from public/index.html.
 *
 * These functions are pure (no DOM or browser APIs) so they can be:
 * 1. Imported by the browser bundle in index.html via a <script> tag
 * 2. Required by Node.js tests for unit testing
 * 3. Used by server-side rendering in the future if needed
 *
 * Server/Frontend API Boundary
 * ----------------------------
 * The functions in this module define the shared contract between
 * server-generated content and client-side rendering. Any function
 * that appears in both server.js and index.html should live here
 * to prevent divergence (see issue #477).
 */

/**
 * Escape HTML special characters to prevent XSS when inserting
 * user content into innerHTML.
 *
 * Handles: & < > only (no quotes — those are handled by attribute context).
 * @param {string} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Normalize a language identifier to a canonical form used for
 * CSS class assignment and syntax highlighting grammar selection.
 *
 * @param {string} lang
 * @returns {string}
 */
function normalizedLang(lang) {
  const value = String(lang || '').trim().toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs'].includes(value)) return 'javascript';
  if (['ts', 'tsx'].includes(value)) return 'typescript';
  if (['sh', 'zsh'].includes(value)) return 'bash';
  if (value === 'yml') return 'yaml';
  return value;
}

/**
 * Protect matched tokens from subsequent regex replacements by
 * replacing them with placeholder markers. Used during syntax
 * highlighting to prevent string/comment content from being
 * re-matched as keywords/numbers/etc.
 *
 * @param {string} source
 * @param {Array<{regex: RegExp, className: string}>} patterns
 * @returns {{ out: string, tokens: string[] }}
 */
function protectTokenMatches(source, patterns) {
  let out = source;
  const tokens = [];

  patterns.forEach(({ regex, className }) => {
    out = out.replace(regex, (match) => {
      const index = tokens.push(`<span class="${className}">${match}</span>`) - 1;
      return `__TOK_${index}__`;
    });
  });

  return { out, tokens };
}

/**
 * Restore token placeholders to their original HTML spans after
 * all regex replacements are complete.
 *
 * @param {string} source
 * @param {string[]} tokens
 * @returns {string}
 */
function restoreTokenMatches(source, tokens) {
  return source.replace(/__TOK_(\d+)__/g, (_, rawIndex) => {
    const index = Number(rawIndex);
    return Number.isInteger(index) && tokens[index] ? tokens[index] : '';
  });
}

/**
 * Apply language-specific syntax highlighting to a code block.
 * Uses regex-based tokenization with HTML span wrapping.
 *
 * Supported languages: JavaScript, TypeScript, JSON, YAML, Bash/Shell.
 * Unknown languages return plain escaped text.
 *
 * @param {string} rawCode - Raw code content (will be escaped)
 * @param {string} lang - Language identifier
 * @returns {string} HTML with <span> tokens for syntax highlighting
 */
function highlightCode(rawCode, lang) {
  const source = escapeHtml(rawCode);
  const grammar = normalizedLang(lang);

  if (grammar === 'json') {
    // JSON highlighting - simpler than JS since there are no comments.
    // Punctuation is applied LAST to match original behavior.
    let out = source;
    out = out.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"(?=\s*:)/g, '<span class="tok-property">"$1"</span>');
    out = out.replace(/:\s*("(?:[^"\\]|\\.)*")/g, ': <span class="tok-string">$1</span>');
    out = out.replace(/\b(true|false|null)\b/g, '<span class="tok-boolean">$1</span>');
    out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
    out = out.replace(/([{}[\],])/g, '<span class="tok-punctuation">$1</span>');
    return out;
  }

  if (['javascript', 'typescript'].includes(grammar)) {
    // JS/TS highlighting strategy:
    // 1. Run the greedy operator regex on clean escaped text FIRST (before any
    //    <span> insertion), so it does not match < > = chars inside HTML tags.
    // 2. Protect strings and comments with placeholders so they cannot be
    //    re-matched by keyword/boolean/number/punctuation regexes.
    // 3. Apply keyword/boolean/number/punctuation replacements.
    // 4. Restore protected strings/comments.
    let out = source;

    // Step 1: Operators on clean text
    out = out.replace(/([+\-*\/%=&|!<>]+)/g, '<span class="tok-operator">$1</span>');

    // Step 2: Protect strings and comments
    const { out: protected_, tokens } = protectTokenMatches(out, [
      { regex: /(\/\/[^\n]*)/g, className: 'tok-comment' },
      { regex: /(`(?:[^`\\]|\\.)*"|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g, className: 'tok-string' },
    ]);

    // Step 3: Keywords, booleans, numbers on protected text
    out = protected_;
    out = out.replace(/\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|from|export|default|async|await|typeof|instanceof)\b/g, '<span class="tok-keyword">$1</span>');
    out = out.replace(/\b(true|false|null|undefined)\b/g, '<span class="tok-boolean">$1</span>');
    out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
    out = out.replace(/([{}()[\].,;:])/g, '<span class="tok-punctuation">$1</span>');

    // Step 4: Restore protected strings/comments
    return restoreTokenMatches(out, tokens);
  }

  if (grammar === 'yaml') {
    let out = source;
    out = out.replace(/(^|\n)(\s*#.*)/g, '$1<span class="tok-comment">$2</span>');
    out = out.replace(/(^|\n)(\s*[\w.-]+)(\s*:)/g, '$1<span class="tok-property">$2</span>$3');
    out = out.replace(/:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, ': <span class="tok-string">$1</span>');
    out = out.replace(/\b(true|false|null|yes|no|on|off)\b/gi, '<span class="tok-boolean">$1</span>');
    out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
    return out;
  }

  if (grammar === 'bash' || grammar === 'shell') {
    let out = source;
    out = out.replace(/(^|\n)(\s*#.*)/g, '$1<span class="tok-comment">$2</span>');
    out = out.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g, '<span class="tok-string">$1</span>');
    out = out.replace(/(^|\n)(\s*)([a-zA-Z_][\w.-]*)/g, '$1$2<span class="tok-command">$3</span>');
    out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
    return out;
  }

  return source;
}

/**
 * Encode plain text as a Base64 payload for copy-to-clipboard buttons.
 * Uses UTF-8 safe encoding (encodeURIComponent + btoa).
 *
 * @param {string} value
 * @returns {string}
 */
function encodeCopyPayload(value) {
  return btoa(unescape(encodeURIComponent(String(value || ''))));
}

/**
 * Decode a Base64 copy payload back to plain text.
 *
 * @param {string} payload
 * @returns {string}
 */
function decodeCopyPayload(payload) {
  try {
    return decodeURIComponent(escape(atob(payload || '')));
  } catch {
    return '';
  }
}

module.exports = {
  escapeHtml,
  normalizedLang,
  protectTokenMatches,
  restoreTokenMatches,
  highlightCode,
  encodeCopyPayload,
  decodeCopyPayload,
};

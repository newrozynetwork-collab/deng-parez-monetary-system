'use strict';

/**
 * add-chat-sidebar.js
 *
 * Inserts a Chat <li> sidebar item into every admin HTML page.
 * Skips public pages and pages that already contain href="/chat".
 * Idempotent: safe to run multiple times.
 *
 * Insertion strategy:
 *   1. Try to insert BEFORE the <li> that contains href="/referrers"
 *   2. Fall back to inserting BEFORE the <li> that contains href="/payments"
 */

const fs   = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '..', 'public', 'pages');

// Public pages that must NOT be modified
const SKIP_FILES = new Set([
  'login.html',
  'connect.html',
  'connect-universal.html',
  'shower-index.html',
  'shower-artist.html',
]);

// The Chat <li> to inject — compact one-liner to match the existing style
const CHAT_LI =
  `<li class="sidebar-item"><a class="sidebar-link waves-effect waves-dark" href="/chat"><i data-feather="message-circle" class="feather-icon"></i><span class="hide-menu">Chat</span></a></li>`;

/**
 * Build a regex that matches the entire <li>…</li> block containing the
 * given href.  Works for both compact one-liners and the multi-line style
 * used in dashboard.html (where the <li> and <a> may be on different lines).
 *
 * Returns a RegExp or null.
 */
function buildLiRegex(href) {
  // Escape the href for use inside a regex
  const escapedHref = href.replace(/\//g, '\\/');
  // Match: optional whitespace, then <li ... > ... href="TARGET" ... </li>
  // The [\s\S]*? makes it work across newlines too.
  return new RegExp(
    `([ \\t]*<li[^>]*>(?:(?!</li>)[\\s\\S])*?href="${escapedHref}"(?:(?!</li>)[\\s\\S])*?</li>)`,
    ''
  );
}

function processFile(filePath) {
  const filename = path.basename(filePath);

  if (SKIP_FILES.has(filename)) {
    console.log(`  SKIP  ${filename}  (public page)`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');

  if (content.includes('href="/chat"')) {
    console.log(`  SKIP  ${filename}  (already has href="/chat")`);
    return;
  }

  // --- Attempt 1: insert before the /referrers <li> ---
  const referrersRe = buildLiRegex('/referrers');
  const referrersMatch = referrersRe.exec(content);

  if (referrersMatch) {
    const original = referrersMatch[1];
    content = content.replace(original, CHAT_LI + '\n' + original);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  DONE  ${filename}  (inserted before /referrers)`);
    return;
  }

  // --- Attempt 2: insert before the /payments <li> ---
  const paymentsRe = buildLiRegex('/payments');
  const paymentsMatch = paymentsRe.exec(content);

  if (paymentsMatch) {
    const original = paymentsMatch[1];
    content = content.replace(original, CHAT_LI + '\n' + original);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`  DONE  ${filename}  (inserted before /payments)`);
    return;
  }

  // --- No insertion point found ---
  console.warn(`  WARN  ${filename}  (no /referrers or /payments anchor found — skipped)`);
}

// ---- Main ----------------------------------------------------------------

const files = fs.readdirSync(PAGES_DIR)
  .filter(f => f.endsWith('.html'))
  .map(f => path.join(PAGES_DIR, f));

console.log(`Processing ${files.length} HTML files in ${PAGES_DIR}\n`);

for (const file of files) {
  processFile(file);
}

console.log('\nDone.');

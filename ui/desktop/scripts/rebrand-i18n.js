#!/usr/bin/env node
/**
 * Rewrites user-facing "goose" / "Goose" branding to "ModelForge" in the desktop
 * i18n message catalogue.
 *
 * Deliberately preserved (they are technical identifiers, not prose):
 *   - .goosehints / .goose/skills / ~/.config/goose  (config paths)
 *   - goose://  (deeplink scheme; keep in sync with forge.config.ts protocols)
 *   - GOOSE_* environment variables
 *   - @goose/ npm scopes
 *
 * Usage: node scripts/rebrand-i18n.js [--write] [--locale en]
 */
const fs = require('fs');
const path = require('path');

const MESSAGES_DIR = path.join(__dirname, '..', 'src', 'i18n', 'messages');
const PLACEHOLDER = '\u0000';

const PROTECTED = [
  '.goosehints',
  '.goose/skills',
  '/goose/',
  'goose://',
  'GOOSE_',
  '@goose/',
  'goose-acp-client',
  'goose-app',
];

function rebrand(value) {
  let text = value;
  const restored = [];
  for (const token of PROTECTED) {
    const marker = `${PLACEHOLDER}${restored.length}${PLACEHOLDER}`;
    if (text.includes(token)) {
      text = text.split(token).join(marker);
      restored.push(token);
    }
  }

  text = text.replace(/\bGoose\b/g, 'ModelForge');
  // In prose the product name is capitalised: "ask goose anything" -> "ask ModelForge anything".
  // Hyphens are left outside the boundary class so German compounds are caught
  // ("goose-Server"), apostrophes so agglutinative forms are caught ("goose'u").
  // Real identifiers are already masked by PROTECTED above.
  text = text.replace(/(?<![A-Za-z0-9_-])goose(?![A-Za-z0-9_])/g, 'ModelForge');

  restored.forEach((token, index) => {
    text = text.split(`${PLACEHOLDER}${index}${PLACEHOLDER}`).join(token);
  });

  return text.replace(/\s{2,}/g, ' ').replace(/ModelForge's/g, "ModelForge's");
}

/**
 * Only prose fields are rewritten. Message ids, descriptions and other metadata
 * keep their original spelling.
 */
function rewriteNode(node) {
  if (Array.isArray(node)) return node.map(rewriteNode);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === 'defaultMessage' && typeof value === 'string' ? rebrand(value) : rewriteNode(value);
    }
    return out;
  }
  return node;
}

function main() {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const localeIndex = args.indexOf('--locale');
  const only = localeIndex >= 0 ? args[localeIndex + 1] : null;

  const files = fs
    .readdirSync(MESSAGES_DIR)
    .filter((name) => name.endsWith('.json'))
    .filter((name) => !only || name === `${only}.json`)
    .sort();

  let totalChanges = 0;
  for (const file of files) {
    const full = path.join(MESSAGES_DIR, file);
    const original = fs.readFileSync(full, 'utf8');
    const parsed = JSON.parse(original);
    const updated = rewriteNode(parsed);
    const serialized = JSON.stringify(updated, null, 2) + '\n';

    const before = countMatches(original, /goose/gi);
    const after = countMatches(serialized, /goose/gi);
    totalChanges += before - after;

    console.log(`${file}: goose occurrences ${before} -> ${after}`);
    if (write) fs.writeFileSync(full, serialized);
    else if (before !== after) {
      for (const line of diffLines(original, serialized).slice(0, 6)) console.log(`    ${line}`);
    }
  }
  console.log(`\n${write ? 'rewrote' : 'would rewrite'} ${totalChanges} occurrences`);
}

function countMatches(text, pattern) {
  return (text.match(pattern) || []).length;
}

function diffLines(a, b) {
  const left = a.split('\n');
  const right = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) out.push(`- ${left[i]}\n      + ${right[i]}`);
  }
  return out;
}

module.exports = { rebrand, rewriteNode, PROTECTED };

if (require.main === module) main();

#!/usr/bin/env node
/**
 * Rebrands the `defaultMessage` literals in the desktop source so they match the
 * rebranded locale catalogues. Uses the same protection rules as
 * scripts/rebrand-i18n.js, so config paths, the deeplink scheme and GOOSE_*
 * environment variables are left untouched.
 *
 * Usage: node scripts/rebrand-source.js [--write]
 */
const fs = require('fs');
const path = require('path');
const { rebrand } = require('./rebrand-i18n.js');

const SRC = path.join(__dirname, '..', 'src');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'i18n') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const LITERAL = /defaultMessage:\s*('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/g;

function unescape(literal) {
  const quote = literal[0];
  const body = literal.slice(1, -1);
  return body.replace(/\\(.)/g, (_, ch) => (ch === quote ? quote : `\\${ch}`));
}

function escapeLike(text, quote) {
  return text.replace(/\\/g, '\\\\').replace(new RegExp(quote, 'g'), `\\${quote}`);
}

function rewriteFile(file, write) {
  const original = fs.readFileSync(file, 'utf8');
  let changed = 0;
  const updated = original.replace(LITERAL, (match, literal) => {
    const quote = literal[0];
    const value = unescape(literal);
    const rebranded = rebrand(value);
    if (rebranded === value) return match;
    changed++;
    return `defaultMessage: ${quote}${escapeLike(rebranded, quote)}${quote}`;
  });
  if (changed && write) fs.writeFileSync(file, updated);
  return changed;
}

function main() {
  const write = process.argv.includes('--write');
  let files = 0;
  let literals = 0;
  for (const file of walk(SRC)) {
    const changed = rewriteFile(file, write);
    if (!changed) continue;
    files++;
    literals += changed;
    console.log(`${changed.toString().padStart(3)}  ${path.relative(SRC, file)}`);
  }
  console.log(`\n${write ? 'rewrote' : 'would rewrite'} ${literals} defaultMessage literals in ${files} files`);
}

module.exports = { rewriteFile };

if (require.main === module) main();

#!/usr/bin/env node
/**
 * Sorts every locale catalogue by message id. `formatjs extract` emits ids in
 * sorted order and scripts/i18n-check.js compares the committed file against a
 * fresh extraction, so the committed catalogues must stay sorted.
 *
 * Usage: node scripts/sort-i18n.js [--write]
 */
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'i18n', 'messages');

function main() {
  const write = process.argv.includes('--write');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const full = path.join(dir, file);
    const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    const keys = Object.keys(parsed);
    const sorted = [...keys].sort();
    const changed = JSON.stringify(keys) !== JSON.stringify(sorted);
    if (changed && write) {
      const out = {};
      for (const key of sorted) out[key] = parsed[key];
      fs.writeFileSync(full, JSON.stringify(out, null, 2) + '\n');
    }
    console.log(`${file}: ${changed ? (write ? 'reordered' : 'would reorder') : 'already sorted'}`);
  }
}

if (require.main === module) main();

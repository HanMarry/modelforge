#!/usr/bin/env node
/**
 * Copies the PDF.js runtime assets the viewer fetches at runtime into `public/pdfjs/`.
 *
 * PDF.js resolves `wasmUrl` / `standardFontDataUrl` as plain URL prefixes, so the files have to
 * exist at a stable path instead of a hashed Vite asset name. `public/` is served verbatim in
 * dev and copied into the build output, which keeps both modes working.
 */
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const targetDir = path.join(projectDir, 'public', 'pdfjs');
// Resolve instead of assuming a path: pnpm hoists the package to the workspace root.
const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'));
const sources = [
  { from: path.join(pdfjsDir, 'wasm'), to: targetDir, filter: /\.wasm$/ },
  {
    from: path.join(pdfjsDir, 'standard_fonts'),
    to: path.join(targetDir, 'standard_fonts'),
    filter: /^[^.].*$/,
  },
];

let copied = 0;

for (const source of sources) {
  if (!fs.existsSync(source.from)) {
    console.warn(`[pdfjs-assets] skipped missing directory: ${source.from}`);
    continue;
  }
  fs.mkdirSync(source.to, { recursive: true });
  for (const entry of fs.readdirSync(source.from)) {
    if (!source.filter.test(entry)) continue;
    fs.copyFileSync(path.join(source.from, entry), path.join(source.to, entry));
    copied += 1;
  }
}

console.log(`[pdfjs-assets] copied ${copied} file(s) into ${path.relative(projectDir, targetDir)}`);

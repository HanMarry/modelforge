#!/usr/bin/env node
/**
 * 打包示例题库（需求 9.6）：把 `resources/examples/<id>/` 过滤后输出到 `.bundle/examples/`。
 *
 * 规则与 `src/utils/examples/exampleCatalog.ts` 的 `bundleFiles` 保持一致：
 *   - 始终保留 `example.json` 与按小问分节的参考思路（`solution/*`）；
 *   - 题面与附件只在 `license.redistributable === true` 时保留；
 *   - `redistributable !== true` 的题目不打包题面与附件，仅保留清单与参考思路。
 *
 * `forge.config.ts` 的 `extraResource` 应指向 `.bundle/examples`。
 */
const fs = require('fs');
const path = require('path');

const EXAMPLES_DIR = path.join(__dirname, '..', 'resources', 'examples');
const OUTPUT_DIR = path.join(__dirname, '..', '.bundle', 'examples');

function bundleFileList(manifest) {
  const files = ['example.json'];
  for (const section of manifest.solution ?? []) {
    if (section.file) files.push(section.file);
  }
  if (manifest.license && manifest.license.redistributable === true) {
    if (manifest.problemFile) files.push(manifest.problemFile);
    for (const attachment of manifest.attachments ?? []) {
      if (attachment) files.push(attachment);
    }
  }
  return files;
}

function main() {
  if (!fs.existsSync(EXAMPLES_DIR)) {
    console.log('no examples directory; nothing to bundle');
    return;
  }
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const ids = fs
    .readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  let total = 0;
  for (const id of ids) {
    const manifestPath = path.join(EXAMPLES_DIR, id, 'example.json');
    if (!fs.existsSync(manifestPath)) {
      console.log(`skipped  ${id}: no example.json`);
      continue;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const files = bundleFileList(manifest);

    let copied = 0;
    for (const relative of files) {
      const source = path.join(EXAMPLES_DIR, id, relative);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(OUTPUT_DIR, id, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      copied += 1;
    }
    total += copied;
    console.log(`bundled  ${id}: ${copied}/${files.length} file(s)`);
  }
  console.log(`\nbundled ${total} file(s) into ${OUTPUT_DIR}`);
}

if (require.main === module) main();

module.exports = { bundleFileList };

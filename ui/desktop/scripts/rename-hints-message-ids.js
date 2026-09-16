const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const MESSAGES = path.join(SRC, 'i18n', 'messages');

const RENAMES = [
  ['goosehintsModal.', 'projectHintsModal.'],
  ['goosehintsSection.', 'projectHintsSection.'],
  ['groupedExtensionLoadingToast.askGoose', 'groupedExtensionLoadingToast.askAssistant'],
];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let sourceEdits = 0;
for (const file of walk(SRC)) {
  if (file.startsWith(MESSAGES)) continue;
  const original = fs.readFileSync(file, 'utf8');
  let updated = original;
  for (const [from, to] of RENAMES) updated = updated.split(from).join(to);
  if (updated !== original) {
    fs.writeFileSync(file, updated);
    sourceEdits++;
    console.log(`src: ${path.relative(SRC, file)}`);
  }
}

let messageEdits = 0;
for (const name of fs.readdirSync(MESSAGES).filter((f) => f.endsWith('.json'))) {
  const file = path.join(MESSAGES, name);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const out = {};
  let changed = false;
  for (const [key, value] of Object.entries(parsed)) {
    let next = key;
    for (const [from, to] of RENAMES) next = next.split(from).join(to);
    if (next !== key) changed = true;
    out[next] = value;
  }
  if (changed) {
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    messageEdits++;
    console.log(`i18n: ${name}`);
  }
}

console.log(`\nrenamed keys in ${sourceEdits} source files and ${messageEdits} locale files`);

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function assertSafeRemoval(repo, files) {
  const root = fs.realpathSync(repo);
  const git = (args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
  const gitRoot = fs.realpathSync(git(['rev-parse', '--show-toplevel']).trim());
  if (path.relative(root, gitRoot) !== '')
    throw new Error('Refusing to strip outside the repository root.');
  git(['rev-parse', '--verify', 'HEAD']);
  if (git(['status', '--porcelain=v1', '--untracked-files=all']).trim()) {
    throw new Error(
      'Refusing to strip a dirty tree. Commit or back up and isolate your work first.'
    );
  }
  const tracked = new Set(git(['ls-files', '-z']).split('\0'));
  for (const file of files) {
    const relative = path.relative(root, fs.realpathSync(file));
    if (
      !relative ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('Refusing to strip a file outside the repository.');
    }
    if (!tracked.has(path.relative(root, file).split(path.sep).join('/'))) {
      throw new Error(`Refusing to strip an uncommitted or ignored file: ${relative}`);
    }
  }
  return git(['rev-parse', 'HEAD']).trim();
}

module.exports = { assertSafeRemoval };

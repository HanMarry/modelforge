const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertSafeRemoval } = require('./strip-safety');

function fixture(t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-strip-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${path.join(repo, 'no-hooks')}`,
        ...args,
      ],
      { stdio: 'pipe', windowsHide: true }
    );
  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'asset.txt'), 'recoverable');
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.ignored\n');
  git('add', '.');
  git('commit', '-qm', 'test baseline');
  return repo;
}

test('allows committed files and returns their recovery revision', (t) => {
  const repo = fixture(t);
  assert.match(assertSafeRemoval(repo, [path.join(repo, 'asset.txt')]), /^[a-f0-9]{40,64}$/);
});

test('rejects modified files before any removal', (t) => {
  const repo = fixture(t);
  const file = path.join(repo, 'asset.txt');
  fs.writeFileSync(file, 'unsaved work');
  assert.throws(() => assertSafeRemoval(repo, [file]), /dirty tree/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unsaved work');
});

test('rejects untracked work elsewhere in the tree', (t) => {
  const repo = fixture(t);
  fs.writeFileSync(path.join(repo, 'new.txt'), 'new work');
  assert.throws(() => assertSafeRemoval(repo, [path.join(repo, 'asset.txt')]), /dirty tree/);
});

test('rejects ignored target files even in an otherwise clean tree', (t) => {
  const repo = fixture(t);
  const file = path.join(repo, 'asset.ignored');
  fs.writeFileSync(file, 'not recoverable');
  assert.throws(() => assertSafeRemoval(repo, [file]), /uncommitted or ignored/);
});

test('rejects files outside the repository', (t) => {
  const repo = fixture(t);
  assert.throws(() => assertSafeRemoval(repo, [__filename]), /outside the repository/);
});

// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// The script under test is CommonJS; load it with Node's own loader.
const requireCjs = createRequire(import.meta.url);
const { assertSafeRemoval } = requireCjs('./strip-safety.js');

const fixtures = [];

afterEach(() => {
  for (const repo of fixtures.splice(0)) fs.rmSync(repo, { recursive: true, force: true });
});

function fixture() {
  // realpath: on macOS the temp directory is reached through the /var -> /private/var
  // symlink, and assertSafeRemoval compares canonical paths.
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-strip-')));
  fixtures.push(repo);
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

describe('assertSafeRemoval', () => {
  it('allows committed files and returns their recovery revision', () => {
    const repo = fixture();
    expect(assertSafeRemoval(repo, [path.join(repo, 'asset.txt')])).toMatch(/^[a-f0-9]{40,64}$/);
  });

  it('rejects modified files before any removal', () => {
    const repo = fixture();
    const file = path.join(repo, 'asset.txt');
    fs.writeFileSync(file, 'unsaved work');
    expect(() => assertSafeRemoval(repo, [file])).toThrow(/dirty tree/);
    expect(fs.readFileSync(file, 'utf8')).toBe('unsaved work');
  });

  it('rejects untracked work elsewhere in the tree', () => {
    const repo = fixture();
    fs.writeFileSync(path.join(repo, 'new.txt'), 'new work');
    expect(() => assertSafeRemoval(repo, [path.join(repo, 'asset.txt')])).toThrow(/dirty tree/);
  });

  it('rejects ignored target files even in an otherwise clean tree', () => {
    const repo = fixture();
    const file = path.join(repo, 'asset.ignored');
    fs.writeFileSync(file, 'not recoverable');
    expect(() => assertSafeRemoval(repo, [file])).toThrow(/uncommitted or ignored/);
  });

  it('rejects files outside the repository', () => {
    const repo = fixture();
    const outside = fileURLToPath(import.meta.url);
    expect(() => assertSafeRemoval(repo, [outside])).toThrow(/outside the repository/);
  });
});

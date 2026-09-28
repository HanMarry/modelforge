/**
 * `--check` mode shared by the repository checks (`docs-check.js`, `check-skills.js`;
 * spec mathmodel-parity-and-beyond, requirement 24.3).
 *
 * A check run in CI must only report: it may not create, modify or delete a file in the
 * working tree. `enforceReadOnly()` makes that a property of the process instead of a
 * promise in a comment — after it runs, every `fs` call that would write throws
 * `ReadOnlyViolation`, so a future "regenerate the index while we are at it" edit fails
 * loudly in CI instead of silently rewriting tracked files. The CI workflow additionally
 * compares `git status --porcelain` before and after the checks, which also covers
 * child processes.
 */
const fs = require('fs');

class ReadOnlyViolation extends Error {
  constructor(operation, target) {
    super(`read-only check mode: refusing fs.${operation}(${target ?? ''})`);
    this.name = 'ReadOnlyViolation';
  }
}

/** fs functions that create, modify or delete files; each has sync and callback forms. */
const WRITERS = [
  'appendFile',
  'chmod',
  'chown',
  'copyFile',
  'cp',
  'lchown',
  'link',
  'lutimes',
  'mkdir',
  'mkdtemp',
  'rename',
  'rm',
  'rmdir',
  'symlink',
  'truncate',
  'unlink',
  'utimes',
  'writeFile',
];

/** `open` flags that only read. Anything else (w, a, r+, numeric write bits) writes. */
function isReadOnlyFlag(flags) {
  if (flags === undefined || flags === null) return true;
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) === 0;
  }
  return flags === 'r' || flags === 'rs' || flags === 'sr';
}

let enforced = false;

/** Makes every writing `fs` call in this process throw. Idempotent. */
function enforceReadOnly() {
  if (enforced) return;
  enforced = true;

  const refuse = (operation) =>
    function refused(target) {
      throw new ReadOnlyViolation(operation, target);
    };
  for (const name of WRITERS) {
    for (const variant of [name, `${name}Sync`]) {
      if (typeof fs[variant] === 'function') fs[variant] = refuse(variant);
    }
    if (fs.promises && typeof fs.promises[name] === 'function') {
      fs.promises[name] = async (target) => {
        throw new ReadOnlyViolation(`promises.${name}`, target);
      };
    }
  }
  fs.createWriteStream = refuse('createWriteStream');

  const { open, openSync } = fs;
  fs.openSync = function guardedOpenSync(target, flags, ...rest) {
    if (!isReadOnlyFlag(flags)) throw new ReadOnlyViolation('openSync', target);
    return openSync.call(fs, target, flags, ...rest);
  };
  fs.open = function guardedOpen(target, flags, ...rest) {
    if (typeof flags !== 'function' && !isReadOnlyFlag(flags)) {
      throw new ReadOnlyViolation('open', target);
    }
    return open.call(fs, target, flags, ...rest);
  };
}

/**
 * Parses the flags a check accepts. Returns `{ check }`; an unknown flag is a usage error
 * (exit code 2), so a typo such as `--chek` cannot silently fall back to another mode.
 */
function parseCheckArgs(argv, usage) {
  const args = argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--check');
  if (unknown.length) {
    console.error(`unknown argument(s): ${unknown.join(' ')}\nusage: ${usage}`);
    process.exit(2);
  }
  return { check: args.includes('--check') };
}

module.exports = { ReadOnlyViolation, enforceReadOnly, isReadOnlyFlag, parseCheckArgs };

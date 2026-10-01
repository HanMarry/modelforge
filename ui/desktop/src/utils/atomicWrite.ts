/**
 * Atomic file replacement (requirement 2.6, 2.8, 6.8): the data goes to a temporary file in the
 * target's directory, is flushed to disk, and only then renamed over the target. Readers see
 * either the complete old file or the complete new one; on failure the temporary file is removed
 * and the target is left untouched.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface AtomicFileHandle {
  writeFile: (data: string | Uint8Array) => Promise<void>;
  sync: () => Promise<void>;
  close: () => Promise<void>;
}

/** The subset of `fs.promises` the writer needs, injectable for fault-injection tests. */
export interface AtomicWriteFileSystem {
  open: (target: string, flags: 'wx') => Promise<AtomicFileHandle>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (target: string) => Promise<void>;
}

export type AtomicWriteStage = 'open' | 'write' | 'sync' | 'close' | 'rename';

export class AtomicWriteError extends Error {
  readonly stage: AtomicWriteStage;
  readonly target: string;

  constructor(target: string, stage: AtomicWriteStage, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Atomic write of ${target} failed during ${stage}: ${reason}`, { cause });
    this.name = 'AtomicWriteError';
    this.stage = stage;
    this.target = target;
  }
}

export interface AtomicWriteOptions {
  fs?: AtomicWriteFileSystem;
  /** Waits between rename retries; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
  tempPath?: (target: string) => string;
}

/** Windows reports these while an antivirus scanner or indexer briefly holds the target. */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY']);
export const RENAME_RETRIES = 3;
const RENAME_RETRY_DELAY_MS = 50;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function defaultTempPath(target: string): string {
  const suffix = `${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  return path.join(path.dirname(target), `.${path.basename(target)}.${suffix}`);
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

export async function writeFileAtomic(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const fileSystem = options.fs ?? (fs.promises as unknown as AtomicWriteFileSystem);
  const sleep = options.sleep ?? defaultSleep;
  const tempPath = (options.tempPath ?? defaultTempPath)(target);

  let stage: AtomicWriteStage = 'open';
  let created = false;
  try {
    const handle = await fileSystem.open(tempPath, 'wx');
    created = true;
    let closed = false;
    try {
      stage = 'write';
      await handle.writeFile(data);
      stage = 'sync';
      await handle.sync();
      stage = 'close';
      closed = true;
      await handle.close();
    } finally {
      if (!closed) {
        await handle.close().catch(() => undefined);
      }
    }

    stage = 'rename';
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fileSystem.rename(tempPath, target);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (attempt >= RENAME_RETRIES || !code || !RETRYABLE_RENAME_CODES.has(code)) {
          throw error;
        }
        await sleep(RENAME_RETRY_DELAY_MS);
      }
    }
  } catch (error) {
    if (created) {
      await fileSystem.unlink(tempPath).catch(() => undefined);
    }
    throw new AtomicWriteError(target, stage, error);
  }
}

/** The subset of the synchronous `fs` API `writeFileAtomicSync` needs, injectable for tests. */
export interface AtomicWriteSyncFileSystem {
  openSync: (target: string, flags: 'wx') => number;
  writeFileSync: (fd: number, data: string | Uint8Array) => void;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (target: string) => void;
}

export interface AtomicWriteSyncOptions {
  fs?: AtomicWriteSyncFileSystem;
  /** Blocks between rename retries; injectable so tests do not sleep. */
  sleep?: (ms: number) => void;
  tempPath?: (target: string) => string;
}

const nodeSyncFs: AtomicWriteSyncFileSystem = {
  openSync: (target, flags) => fs.openSync(target, flags),
  writeFileSync: (fd, data) => fs.writeFileSync(fd, data),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (from, to) => fs.renameSync(from, to),
  unlinkSync: (target) => fs.unlinkSync(target),
};

/** Blocks the calling thread; only used for the short waits between rename retries. */
const blockingSleep = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * `writeFileAtomic` for callers that must stay synchronous, such as `settings.json`, which the
 * main process reads back right after writing it: the same temporary file, flush and rename, and
 * the same rename retries, whose short waits block.
 */
export function writeFileAtomicSync(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteSyncOptions = {}
): void {
  const fileSystem = options.fs ?? nodeSyncFs;
  const sleep = options.sleep ?? blockingSleep;
  const tempPath = (options.tempPath ?? defaultTempPath)(target);
  let stage: AtomicWriteStage = 'open';
  let created = false;
  try {
    const fd = fileSystem.openSync(tempPath, 'wx');
    created = true;
    let closed = false;
    try {
      stage = 'write';
      fileSystem.writeFileSync(fd, data);
      stage = 'sync';
      fileSystem.fsyncSync(fd);
      stage = 'close';
      closed = true;
      fileSystem.closeSync(fd);
    } finally {
      if (!closed) {
        try {
          fileSystem.closeSync(fd);
        } catch {
          // The write already failed; that error is the one reported.
        }
      }
    }
    stage = 'rename';
    for (let attempt = 0; ; attempt += 1) {
      try {
        fileSystem.renameSync(tempPath, target);
        return;
      } catch (error) {
        const code = errorCode(error);
        if (attempt >= RENAME_RETRIES || !code || !RETRYABLE_RENAME_CODES.has(code)) {
          throw error;
        }
        sleep(RENAME_RETRY_DELAY_MS);
      }
    }
  } catch (error) {
    if (created) {
      try {
        fileSystem.unlinkSync(tempPath);
      } catch {
        // Best effort: a leftover temporary file never replaces the target.
      }
    }
    throw new AtomicWriteError(target, stage, error);
  }
}

/** Injectable writer for modules that persist state (credential store, reports, indexes). */
export interface AtomicFs {
  writeFileAtomic: (target: string, data: string | Uint8Array) => Promise<void>;
}

export const nodeAtomicFs: AtomicFs = {
  writeFileAtomic: (target, data) => writeFileAtomic(target, data),
};

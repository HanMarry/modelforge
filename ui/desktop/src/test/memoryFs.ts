/**
 * In-memory stand-in for the file operations the atomic writer uses, with fault injection.
 * Listeners run after every visible change, so tests can check what a concurrent reader of the
 * target file could have observed at any moment.
 */
import type {
  AtomicFileHandle,
  AtomicWriteFileSystem,
  AtomicWriteSyncFileSystem,
} from '../utils/atomicWrite';

export type MemoryFsFault =
  | { op: 'open' | 'write' | 'sync' | 'close'; code?: string }
  /** Writes the first half of the data, then fails, like a full disk. */
  | { op: 'write-partial'; code?: string }
  /** Fails the first `times` renames with `code`, then lets them through. */
  | { op: 'rename'; code: string; times: number };

const fsError = (message: string, code: string): Error =>
  Object.assign(new Error(`${code}: ${message}`), { code });

export class MemoryFs implements AtomicWriteFileSystem, AtomicWriteSyncFileSystem {
  readonly files = new Map<string, string>();
  fault: MemoryFsFault | null = null;
  private renameFailures = 0;
  private readonly listeners: Array<() => void> = [];
  /** Descriptor → path of the files `openSync` opened. */
  private readonly descriptors = new Map<number, string>();
  private nextDescriptor = 3;

  constructor(initial: Record<string, string> = {}) {
    for (const [file, contents] of Object.entries(initial)) {
      this.files.set(file, contents);
    }
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  private failIf(op: 'open' | 'write' | 'sync' | 'close', defaultCode: string): void {
    if (this.fault && this.fault.op === op) {
      throw fsError(`${op} failed`, this.fault.code ?? defaultCode);
    }
  }

  async open(target: string, flags: 'wx'): Promise<AtomicFileHandle> {
    this.failIf('open', 'EACCES');
    if (flags === 'wx' && this.files.has(target)) {
      throw fsError(`${target} exists`, 'EEXIST');
    }
    this.files.set(target, '');
    this.changed();

    const decoder = new TextDecoder();
    return {
      writeFile: async (data) => {
        const text = typeof data === 'string' ? data : decoder.decode(data);
        if (this.fault?.op === 'write-partial') {
          this.files.set(target, text.slice(0, Math.floor(text.length / 2)));
          this.changed();
          throw fsError('no space left on device', this.fault.code ?? 'ENOSPC');
        }
        this.failIf('write', 'EIO');
        this.files.set(target, text);
        this.changed();
      },
      sync: async () => this.failIf('sync', 'EIO'),
      close: async () => this.failIf('close', 'EIO'),
    };
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.fault?.op === 'rename' && this.renameFailures < this.fault.times) {
      this.renameFailures += 1;
      throw fsError(`rename ${from} failed`, this.fault.code);
    }
    const contents = this.files.get(from);
    if (contents === undefined) {
      throw fsError(`${from} does not exist`, 'ENOENT');
    }
    // One step: a reader sees either the old target or the new one.
    this.files.delete(from);
    this.files.set(to, contents);
    this.changed();
  }

  async unlink(target: string): Promise<void> {
    if (!this.files.delete(target)) {
      throw fsError(`${target} does not exist`, 'ENOENT');
    }
    this.changed();
  }

  // The synchronous API of `writeFileAtomicSync`, with the same faults.

  openSync(target: string, flags: 'wx'): number {
    this.failIf('open', 'EACCES');
    if (flags === 'wx' && this.files.has(target)) {
      throw fsError(`${target} exists`, 'EEXIST');
    }
    this.files.set(target, '');
    this.changed();
    const fd = this.nextDescriptor;
    this.nextDescriptor += 1;
    this.descriptors.set(fd, target);
    return fd;
  }

  writeFileSync(fd: number, data: string | Uint8Array): void {
    const target = this.descriptors.get(fd);
    if (target === undefined) {
      throw fsError(`bad file descriptor ${fd}`, 'EBADF');
    }
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    if (this.fault?.op === 'write-partial') {
      this.files.set(target, text.slice(0, Math.floor(text.length / 2)));
      this.changed();
      throw fsError('no space left on device', this.fault.code ?? 'ENOSPC');
    }
    this.failIf('write', 'EIO');
    this.files.set(target, text);
    this.changed();
  }

  fsyncSync(_fd: number): void {
    this.failIf('sync', 'EIO');
  }

  closeSync(fd: number): void {
    this.descriptors.delete(fd);
    this.failIf('close', 'EIO');
  }

  renameSync(from: string, to: string): void {
    if (this.fault?.op === 'rename' && this.renameFailures < this.fault.times) {
      this.renameFailures += 1;
      throw fsError(`rename ${from} failed`, this.fault.code);
    }
    const contents = this.files.get(from);
    if (contents === undefined) {
      throw fsError(`${from} does not exist`, 'ENOENT');
    }
    this.files.delete(from);
    this.files.set(to, contents);
    this.changed();
  }

  unlinkSync(target: string): void {
    if (!this.files.delete(target)) {
      throw fsError(`${target} does not exist`, 'ENOENT');
    }
    this.changed();
  }
}

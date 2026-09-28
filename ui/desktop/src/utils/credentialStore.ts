/**
 * Desktop credential store (requirement 2). The keys the app keeps for itself, such as the
 * provider key the external agent kernels reuse, live in `agent-kernel-secrets.json`,
 * encrypted with the OS secure storage.
 *
 * - Without secure storage a key is held in memory for this session only; nothing reversible
 *   (plaintext, Base64 or any other encoding) reaches the disk (2.1, 2.2).
 * - Every write replaces the whole file atomically (2.6, 2.8).
 * - A file that cannot be read or parsed is never written until the user repairs or deletes
 *   it (2.7).
 * - `raw:` entries left by older versions are migrated one at a time. Each is replaced only
 *   after its encrypted copy was written and read back intact (2.4, 2.5).
 *
 * File layout: `{ "version": 2, "entries": { "<id>": "enc:<base64>" } }`. Version 1 was a
 * flat `{ "<id>": "enc:…" | "raw:…" }` map and is still read. A migration step may add a
 * `staged` map holding encrypted copies that are not committed yet; readers ignore it and the
 * next write drops it.
 */
import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, type AtomicFs, type AtomicWriteFileSystem } from './atomicWrite';

export const SECRETS_FILE_VERSION = 2;
const ENC_PREFIX = 'enc:';
const RAW_PREFIX = 'raw:';

export type SaveOutcome = 'encrypted' | 'memory-only' | 'failed';

export type CredentialErrorCode =
  /** The secrets file cannot be read or parsed, so it is left alone. */
  | 'SECRETS_FILE_CORRUPTED'
  /** Replacing the file failed; the previous file is unchanged. */
  | 'ATOMIC_WRITE_FAILED'
  /** The OS secure storage refused to encrypt the value. */
  | 'ENCRYPTION_FAILED'
  /** Empty id or value. */
  | 'INVALID_INPUT';

export interface CredentialError {
  code: CredentialErrorCode;
  /** The underlying exception, for logs. Mask it before it is shown or logged. */
  cause?: unknown;
}

export type SaveResult =
  | { outcome: 'encrypted' | 'memory-only' }
  | { outcome: 'failed'; error: CredentialError };

export type DeleteResult = { ok: true } | { ok: false; error: CredentialError };

export interface MigrationResult {
  migrated: number;
  failed: number;
}

export interface CredentialStoreStatus {
  /** Location of the secrets file, so the user can repair or delete it. */
  path: string;
  /** Whether a save right now would be encrypted on disk. */
  persistent: boolean;
  /** The file cannot be read or parsed; nothing is written until it is repaired or deleted. */
  corrupted: boolean;
  /** `raw:` entries from older versions that still wait for migration. */
  legacyEntries: number;
  /** Keys kept for this session only. */
  memoryOnlyEntries: number;
  /** Outcome of the latest migration run; null until one ran. */
  lastMigration: MigrationResult | null;
}

/** The subset of Electron's `safeStorage` the store needs, injectable for tests. */
export interface CredentialCrypto {
  available: () => boolean;
  encrypt: (plaintext: string) => Buffer;
  decrypt: (ciphertext: Buffer) => string;
}

export interface CredentialFileSystem extends AtomicFs {
  /** The file as UTF-8 text, or null when it does not exist. Any other failure throws. */
  readFile: (file: string) => string | null;
}

export interface CredentialStore {
  /** Whether a save right now would be encrypted on disk. */
  isPersistent: () => boolean;
  save: (id: string, value: string) => Promise<SaveResult>;
  get: (id: string) => string | null;
  delete: (id: string) => Promise<DeleteResult>;
  migrateRawEntries: () => Promise<MigrationResult>;
  /** Reads the file again, so a secrets file the user repaired or deleted is picked up. */
  reload: () => Promise<void>;
  status: () => CredentialStoreStatus;
  /** Every key value seen in this session, for masking logs and errors (requirement 1.10). */
  sensitiveValues: () => string[];
}

export interface CredentialStoreOptions {
  file: string;
  crypto: CredentialCrypto;
  fs: CredentialFileSystem;
  /** Receives diagnostics. Messages carry ids and paths, never key values. */
  log?: (message: string) => void;
}

type FileProblem = 'unreadable' | 'invalid-json' | 'invalid-format';

interface SecretsFileContents {
  entries: Map<string, string>;
  staged: Map<string, string>;
}

type ParseResult =
  | { ok: true; contents: SecretsFileContents }
  | { ok: false; problem: FileProblem };

const PROBLEM_TEXT: Record<FileProblem, string> = {
  unreadable: 'cannot be read',
  'invalid-json': 'is not valid JSON',
  'invalid-format': 'has an unknown layout',
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function stringMap(value: unknown): Map<string, string> | null {
  if (!isRecord(value)) {
    return null;
  }
  const map = new Map<string, string>();
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      return null;
    }
    map.set(key, item);
  }
  return map;
}

/** Parses the secrets file. A layout it does not know (including a newer version) is a problem. */
export function parseSecretsFile(text: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'invalid-json' };
  }
  if (!isRecord(data)) {
    return { ok: false, problem: 'invalid-format' };
  }
  if (!Object.hasOwn(data, 'version')) {
    const entries = stringMap(data);
    return entries
      ? { ok: true, contents: { entries, staged: new Map() } }
      : { ok: false, problem: 'invalid-format' };
  }
  if (data.version !== SECRETS_FILE_VERSION) {
    return { ok: false, problem: 'invalid-format' };
  }
  const entries = stringMap(data.entries);
  const staged = data.staged === undefined ? new Map<string, string>() : stringMap(data.staged);
  if (!entries || !staged) {
    return { ok: false, problem: 'invalid-format' };
  }
  return { ok: true, contents: { entries, staged } };
}

function serializeSecretsFile(entries: Map<string, string>, staged?: Map<string, string>): string {
  const body: {
    version: number;
    entries: Record<string, string>;
    staged?: Record<string, string>;
  } = { version: SECRETS_FILE_VERSION, entries: Object.fromEntries(entries) };
  if (staged && staged.size > 0) {
    body.staged = Object.fromEntries(staged);
  }
  return JSON.stringify(body, null, 2);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * `raw:` values are the Base64 of the UTF-8 plaintext. A value that does not round-trip is
 * not something this app wrote, so it is left for the user rather than guessed at.
 */
function decodeRaw(stored: string): string | null {
  const encoded = stored.slice(RAW_PREFIX.length);
  if (encoded.length % 4 !== 0 || !BASE64.test(encoded)) {
    return null;
  }
  const plaintext = Buffer.from(encoded, 'base64').toString('utf8');
  return Buffer.from(plaintext, 'utf8').toString('base64') === encoded ? plaintext : null;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;

const failed = (code: CredentialErrorCode, cause?: unknown): SaveResult => ({
  outcome: 'failed',
  error: { code, cause },
});

export function createCredentialStore({
  file,
  crypto,
  fs: fileSystem,
  log = () => {},
}: CredentialStoreOptions): CredentialStore {
  /** Entries of the file as last read or written; empty while the file is unusable. */
  let persisted = new Map<string, string>();
  let readOnly = false;
  let lastMigration: MigrationResult | null = null;
  const memory = new Map<string, string>();
  const sensitive = new Set<string>();
  const undecryptable = new Set<string>();
  let queue: Promise<unknown> = Promise.resolve();

  const track = (value: string | null): void => {
    if (value) {
      sensitive.add(value);
    }
  };

  const encryptionAvailable = (): boolean => {
    try {
      return crypto.available();
    } catch {
      return false;
    }
  };

  const encrypt = (plaintext: string): string =>
    ENC_PREFIX + crypto.encrypt(plaintext).toString('base64');

  const decrypt = (stored: string): string =>
    crypto.decrypt(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));

  const load = (): ParseResult => {
    let text: string | null;
    try {
      text = fileSystem.readFile(file);
    } catch {
      return { ok: false, problem: 'unreadable' };
    }
    if (text === null) {
      return { ok: true, contents: { entries: new Map(), staged: new Map() } };
    }
    return parseSecretsFile(text);
  };

  /**
   * Reads the file again before every change, so external edits are respected and a file
   * that went bad is never overwritten. Returns false when the store is read-only.
   */
  const refresh = (): boolean => {
    const result = load();
    if (!result.ok) {
      if (!readOnly) {
        log(
          `${file} ${PROBLEM_TEXT[result.problem]}; it is left untouched until it is repaired or deleted`
        );
      }
      readOnly = true;
      persisted = new Map();
      return false;
    }
    if (readOnly) {
      log(`${file} is readable again`);
    }
    readOnly = false;
    persisted = result.contents.entries;
    for (const stored of persisted.values()) {
      if (stored.startsWith(RAW_PREFIX)) {
        track(decodeRaw(stored));
      }
    }
    return true;
  };

  const writeContents = async (
    entries: Map<string, string>,
    staged?: Map<string, string>
  ): Promise<void> => {
    if (readOnly) {
      throw new Error(`${file} is left untouched until it is repaired or deleted`);
    }
    await fileSystem.writeFileAtomic(file, serializeSecretsFile(entries, staged));
  };

  /** Changes run one at a time, each on top of the file the previous one left. */
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  const decode = (id: string, stored: string): string | null => {
    if (stored.startsWith(RAW_PREFIX)) {
      return decodeRaw(stored);
    }
    if (!stored.startsWith(ENC_PREFIX)) {
      return null;
    }
    try {
      return decrypt(stored);
    } catch (error) {
      if (!undecryptable.has(id)) {
        undecryptable.add(id);
        log(`cannot decrypt ${id}: ${messageOf(error)}`);
      }
      return null;
    }
  };

  const saveInMemory = async (id: string, value: string): Promise<SaveResult> => {
    // A copy left on disk would come back after a restart; drop it so that the key shows as
    // not configured next time (2.2).
    if (refresh() && persisted.has(id)) {
      const next = new Map(persisted);
      next.delete(id);
      try {
        await writeContents(next);
      } catch (error) {
        return failed('ATOMIC_WRITE_FAILED', error);
      }
      persisted = next;
    }
    memory.set(id, value);
    return { outcome: 'memory-only' };
  };

  const save = (id: string, value: string): Promise<SaveResult> =>
    serialize(async (): Promise<SaveResult> => {
      if (!id || !value) {
        return failed('INVALID_INPUT');
      }
      track(value);
      if (!encryptionAvailable()) {
        return saveInMemory(id, value);
      }
      if (!refresh()) {
        return failed('SECRETS_FILE_CORRUPTED');
      }
      let stored: string;
      try {
        stored = encrypt(value);
      } catch (error) {
        return failed('ENCRYPTION_FAILED', error);
      }
      const next = new Map(persisted).set(id, stored);
      try {
        await writeContents(next);
      } catch (error) {
        return failed('ATOMIC_WRITE_FAILED', error);
      }
      persisted = next;
      memory.delete(id);
      undecryptable.delete(id);
      return { outcome: 'encrypted' };
    });

  const remove = (id: string): Promise<DeleteResult> =>
    serialize(async (): Promise<DeleteResult> => {
      memory.delete(id);
      if (!refresh()) {
        // The file may still hold the key, and it cannot be rewritten.
        return { ok: false, error: { code: 'SECRETS_FILE_CORRUPTED' } };
      }
      if (!persisted.has(id)) {
        return { ok: true };
      }
      const next = new Map(persisted);
      next.delete(id);
      try {
        await writeContents(next);
      } catch (error) {
        return { ok: false, error: { code: 'ATOMIC_WRITE_FAILED', cause: error } };
      }
      persisted = next;
      return { ok: true };
    });

  /** Whether the staged copy of `id` landed on disk intact, next to the untouched raw entry. */
  const stagedCopyIsIntact = (
    id: string,
    original: string,
    encrypted: string,
    plaintext: string
  ): boolean => {
    const result = load();
    if (!result.ok) {
      return false;
    }
    const copy = result.contents.staged.get(id);
    if (copy === undefined || copy !== encrypted || result.contents.entries.get(id) !== original) {
      return false;
    }
    try {
      return decrypt(copy) === plaintext;
    } catch {
      return false;
    }
  };

  const migrateOne = async (id: string, original: string): Promise<boolean> => {
    const plaintext = decodeRaw(original);
    if (plaintext === null) {
      log(`cannot migrate ${id}: the stored value is not valid Base64`);
      return false;
    }
    track(plaintext);

    let encrypted: string;
    try {
      encrypted = encrypt(plaintext);
    } catch (error) {
      log(`cannot migrate ${id}: encryption failed: ${messageOf(error)}`);
      return false;
    }

    // 1. Write the encrypted copy next to the raw entry, which stays as it is.
    try {
      await writeContents(persisted, new Map([[id, encrypted]]));
    } catch (error) {
      log(`cannot migrate ${id}: writing the encrypted copy failed: ${messageOf(error)}`);
      return false;
    }

    // 2. Read the file back and decrypt what actually reached the disk.
    if (!stagedCopyIsIntact(id, original, encrypted, plaintext)) {
      log(`cannot migrate ${id}: the encrypted copy did not read back intact`);
      if (refresh()) {
        // Best effort only: the next write drops the staged copy anyway.
        await writeContents(persisted).catch(() => undefined);
      }
      return false;
    }

    // 3. Only now replace the raw entry.
    const next = new Map(persisted).set(id, encrypted);
    try {
      await writeContents(next);
    } catch (error) {
      log(`cannot migrate ${id}: replacing the raw entry failed: ${messageOf(error)}`);
      return false;
    }
    persisted = next;
    return true;
  };

  const migrateRawEntries = (): Promise<MigrationResult> =>
    serialize(async (): Promise<MigrationResult> => {
      if (!encryptionAvailable() || !refresh()) {
        return { migrated: 0, failed: 0 };
      }
      const pending = [...persisted]
        .filter(([, stored]) => stored.startsWith(RAW_PREFIX))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const result: MigrationResult = { migrated: 0, failed: 0 };
      for (const [id, stored] of pending) {
        if (!readOnly && (await migrateOne(id, stored))) {
          result.migrated += 1;
        } else {
          result.failed += 1;
        }
      }
      lastMigration = result;
      return { ...result };
    });

  const get = (id: string): string | null => {
    const inMemory = memory.get(id);
    if (inMemory !== undefined) {
      return inMemory;
    }
    const stored = persisted.get(id);
    if (stored === undefined) {
      return null;
    }
    const value = decode(id, stored);
    track(value);
    return value;
  };

  const legacyEntries = (): number =>
    [...persisted.values()].filter((stored) => stored.startsWith(RAW_PREFIX)).length;

  refresh();

  return {
    isPersistent: encryptionAvailable,
    save,
    get,
    delete: remove,
    migrateRawEntries,
    reload: () =>
      serialize(async () => {
        refresh();
      }),
    status: () => ({
      path: file,
      persistent: encryptionAvailable(),
      corrupted: readOnly,
      legacyEntries: legacyEntries(),
      memoryOnlyEntries: memory.size,
      lastMigration: lastMigration && { ...lastMigration },
    }),
    sensitiveValues: () => [...sensitive],
  };
}

/** The secrets file is private to the user: 0600 on POSIX (Windows ignores the mode). */
const privateFileSystem: AtomicWriteFileSystem = {
  open: (target, flags) => fs.promises.open(target, flags, 0o600),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (target) => fs.promises.unlink(target),
};

export const nodeCredentialFs: CredentialFileSystem = {
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return null;
      }
      throw error;
    }
  },
  writeFileAtomic: async (target, data) => {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await writeFileAtomic(target, data, { fs: privateFileSystem });
  },
};

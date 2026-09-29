import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryFs } from '../test/memoryFs';
import { pbtParams } from '../test/pbt';
import { writeFileAtomic } from './atomicWrite';
import {
  createCredentialStore,
  nodeCredentialFs,
  parseSecretsFile,
  type CredentialCrypto,
  type CredentialFileSystem,
} from './credentialStore';

const FILE = '/userData/agent-kernel-secrets.json';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

/**
 * Reversible stand-in for safeStorage: the UTF-8 bytes XOR-ed behind a marker byte, so the
 * ciphertext never contains the plaintext or its Base64.
 */
const MARKER = 0xa5;
const MASK = 0x5a;

function seal(plaintext: string): Buffer {
  const bytes = Buffer.from(plaintext, 'utf8');
  return Buffer.concat([Buffer.from([MARKER]), Buffer.from(bytes.map((byte) => byte ^ MASK))]);
}

function unseal(ciphertext: Buffer): string {
  if (ciphertext[0] !== MARKER) {
    throw new Error('not sealed with this key');
  }
  return Buffer.from(ciphertext.subarray(1).map((byte) => byte ^ MASK)).toString('utf8');
}

const enc = (plaintext: string): string => `enc:${seal(plaintext).toString('base64')}`;
const raw = (plaintext: string): string =>
  `raw:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
const unsealStored = (stored: string): string =>
  unseal(Buffer.from(stored.slice('enc:'.length), 'base64'));

interface FakeCipher extends CredentialCrypto {
  enabled: boolean;
  /** Plaintexts whose encryption throws. */
  failEncrypt: Set<string>;
  /** Plaintexts that decrypt to something else. */
  garbleDecrypt: Set<string>;
}

function fakeCipher(enabled = true): FakeCipher {
  const cipher: FakeCipher = {
    enabled,
    failEncrypt: new Set(),
    garbleDecrypt: new Set(),
    available: () => cipher.enabled,
    encrypt: (plaintext) => {
      if (cipher.failEncrypt.has(plaintext)) {
        throw new Error('encryption refused');
      }
      return seal(plaintext);
    },
    decrypt: (ciphertext) => {
      const plaintext = unseal(ciphertext);
      return cipher.garbleDecrypt.has(plaintext) ? `${plaintext}\u0000garbled` : plaintext;
    },
  };
  return cipher;
}

interface MemoryCredentialFs extends CredentialFileSystem {
  memory: MemoryFs;
  /** Write attempts, including the ones that failed. */
  writes: number;
  /** Fails a write (before it touches the file) when it returns true for the new contents. */
  failWrite: ((text: string) => boolean) | null;
}

/** The store's file system on top of the in-memory atomic-write stand-in. */
function memoryCredentialFs(initial?: string): MemoryCredentialFs {
  const memory = new MemoryFs(initial === undefined ? {} : { [FILE]: initial });
  const credentialFs: MemoryCredentialFs = {
    memory,
    writes: 0,
    failWrite: null,
    readFile: (file) => memory.files.get(file) ?? null,
    writeFileAtomic: async (target, data) => {
      credentialFs.writes += 1;
      const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
      if (credentialFs.failWrite?.(text)) {
        throw Object.assign(new Error('EIO: injected write failure'), { code: 'EIO' });
      }
      await writeFileAtomic(target, text, {
        fs: memory,
        sleep: async () => undefined,
        tempPath: (file) => `${file}.pending.tmp`,
      });
    },
  };
  return credentialFs;
}

const v2File = (entries: Record<string, string>): string =>
  JSON.stringify({ version: 2, entries });

function entriesOnDisk(credentialFs: MemoryCredentialFs): Map<string, string> {
  const text = credentialFs.memory.files.get(FILE);
  if (text === undefined) {
    return new Map();
  }
  const parsed = parseSecretsFile(text);
  if (!parsed.ok) {
    throw new Error(`the store left an unreadable file (${parsed.problem})`);
  }
  return parsed.contents.entries;
}

const idArb = fc.constantFrom(
  'provider:custom_deepseek',
  'kernel:custom_deepseek',
  'provider:openai',
  'kernel:anthropic',
  'provider:custom_gateway-2'
);

/** "sk-" occurs in neither Base64, JSON syntax nor the ids, so a match in the file is a leak. */
const keyArb = fc
  .string({ unit: 'grapheme', minLength: 1, maxLength: 40 })
  .map((suffix) => `sk-${suffix}`);

const isInvalidJson = (text: string): boolean => {
  try {
    JSON.parse(text);
    return false;
  } catch {
    return true;
  }
};

// Feature: mathmodel-parity-and-beyond, Property 8: 加密不可用时不落盘
describe('Property 8: 加密不可用时不落盘', () => {
  it('keeps keys in memory only and forgets them after a restart', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.option(
          fc.dictionary(
            idArb,
            fc.string({ maxLength: 20 }).map((suffix) => `stored-${suffix}`),
            { maxKeys: 3 }
          ),
          { nil: undefined }
        ),
        fc.array(fc.record({ id: idArb, value: keyArb }), { minLength: 1, maxLength: 6 }),
        async (existing, saves) => {
          const cipher = fakeCipher(false);
          const initial =
            existing &&
            v2File(
              Object.fromEntries(
                Object.entries(existing).map(([id, plaintext]) => [id, enc(plaintext)])
              )
            );
          const credentialFs = memoryCredentialFs(initial);
          const store = createCredentialStore({ file: FILE, crypto: cipher, fs: credentialFs });

          const latest = new Map<string, string>();
          for (const { id, value } of saves) {
            expect(await store.save(id, value)).toEqual({ outcome: 'memory-only' });
            latest.set(id, value);
          }

          const text = credentialFs.memory.files.get(FILE) ?? '';
          expect(text).not.toContain('raw:');
          for (const { value } of saves) {
            expect(text).not.toContain(value);
            expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
            expect(text).not.toContain(Buffer.from(value, 'utf8').toString('base64'));
          }
          // What stays on disk is what was there, minus the keys this session replaced.
          const kept = Object.entries(existing ?? {}).filter(([id]) => !latest.has(id));
          expect(entriesOnDisk(credentialFs)).toEqual(
            new Map(kept.map(([id, plaintext]) => [id, enc(plaintext)]))
          );
          for (const [id, value] of latest) {
            expect(store.get(id)).toBe(value);
          }
          expect(store.status()).toMatchObject({
            persistent: false,
            corrupted: false,
            memoryOnlyEntries: latest.size,
          });

          const restarted = createCredentialStore({ file: FILE, crypto: cipher, fs: credentialFs });
          for (const id of latest.keys()) {
            expect(restarted.get(id)).toBeNull();
          }
          for (const [id, plaintext] of kept) {
            expect(restarted.get(id)).toBe(plaintext);
          }
        }
      ),
      pbtParams
    );
  });
});

type MigrationFault = 'none' | 'encrypt' | 'write-first' | 'write-commit' | 'read-back';

const faultArb = fc.constantFrom<MigrationFault>(
  'none',
  'encrypt',
  'write-first',
  'write-commit',
  'read-back'
);
const nameArb = fc.stringMatching(/^[a-z0-9_]{1,12}$/);

// Feature: mathmodel-parity-and-beyond, Property 9: raw 条目逐条迁移
describe('Property 9: raw 条目逐条迁移', () => {
  it('migrates raw entries one by one and keeps every entry whose migration failed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.record({ name: nameArb, fault: faultArb }), {
          selector: (spec) => spec.name,
          maxLength: 6,
        }),
        fc.uniqueArray(nameArb, { maxLength: 3 }),
        fc.boolean(),
        async (rawSpecs, encNames, legacyLayout) => {
          const rawKey = (name: string) => `sk-raw-${name}-密钥🔑`;
          const encKey = (name: string) => `sk-enc-${name}`;
          const initialEntries: Record<string, string> = {};
          for (const { name } of rawSpecs) {
            initialEntries[`provider:${name}`] = raw(rawKey(name));
          }
          for (const name of encNames) {
            initialEntries[`kernel:${name}`] = enc(encKey(name));
          }
          const credentialFs = memoryCredentialFs(
            legacyLayout ? JSON.stringify(initialEntries) : v2File(initialEntries)
          );

          const cipher = fakeCipher(true);
          for (const { name, fault } of rawSpecs) {
            if (fault === 'encrypt') {
              cipher.failEncrypt.add(rawKey(name));
            } else if (fault === 'read-back') {
              cipher.garbleDecrypt.add(rawKey(name));
            }
          }
          credentialFs.failWrite = (text) => {
            const parsed = parseSecretsFile(text);
            return rawSpecs.some(({ name, fault }) => {
              const sealed = enc(rawKey(name));
              if (fault === 'write-first') {
                return text.includes(sealed.slice('enc:'.length));
              }
              return (
                fault === 'write-commit' &&
                parsed.ok &&
                parsed.contents.entries.get(`provider:${name}`) === sealed
              );
            });
          };

          const store = createCredentialStore({ file: FILE, crypto: cipher, fs: credentialFs });
          const result = await store.migrateRawEntries();

          const failing = rawSpecs.filter(({ fault }) => fault !== 'none');
          expect(result).toEqual({
            migrated: rawSpecs.length - failing.length,
            failed: failing.length,
          });
          const entries = entriesOnDisk(credentialFs);
          expect([...entries.keys()].sort()).toEqual(Object.keys(initialEntries).sort());
          for (const { name, fault } of rawSpecs) {
            const stored = entries.get(`provider:${name}`) ?? '';
            if (fault === 'none') {
              expect(stored.startsWith('enc:')).toBe(true);
              expect(unsealStored(stored)).toBe(rawKey(name));
            } else {
              expect(stored).toBe(raw(rawKey(name)));
            }
          }
          for (const name of encNames) {
            expect(entries.get(`kernel:${name}`)).toBe(enc(encKey(name)));
          }
          expect(store.status()).toMatchObject({
            legacyEntries: failing.length,
            lastMigration: result,
          });

          // The next start retries what is left, and every key still reads back meanwhile.
          credentialFs.failWrite = null;
          const restarted = createCredentialStore({
            file: FILE,
            crypto: fakeCipher(true),
            fs: credentialFs,
          });
          for (const { name } of rawSpecs) {
            expect(restarted.get(`provider:${name}`)).toBe(rawKey(name));
          }
          for (const name of encNames) {
            expect(restarted.get(`kernel:${name}`)).toBe(encKey(name));
          }
          expect(await restarted.migrateRawEntries()).toEqual({
            migrated: failing.length,
            failed: 0,
          });
          expect(restarted.status().legacyEntries).toBe(0);
        }
      ),
      pbtParams
    );
  });
});

const SAMPLE_FILE = v2File({ 'kernel:custom_deepseek': enc('sk-a'), 'provider:x': raw('sk-b') });

const corruptFileArb = fc
  .oneof(
    fc.string({ unit: 'grapheme', maxLength: 60 }),
    fc
      .uint8Array({ minLength: 1, maxLength: 40 })
      .map((bytes) => Buffer.from(bytes).toString('utf8')),
    fc.integer({ min: 0, max: SAMPLE_FILE.length - 1 }).map((end) => SAMPLE_FILE.slice(0, end))
  )
  .filter(isInvalidJson);

const operationArb = fc.oneof(
  fc.record({
    kind: fc.constant('save' as const),
    id: idArb,
    value: keyArb,
    encryption: fc.boolean(),
  }),
  fc.record({ kind: fc.constant('delete' as const), id: idArb, encryption: fc.boolean() }),
  fc.record({ kind: fc.constant('migrate' as const), encryption: fc.boolean() }),
  fc.record({ kind: fc.constant('reload' as const), encryption: fc.boolean() })
);

// Feature: mathmodel-parity-and-beyond, Property 11: 损坏密钥文件不被写入
describe('Property 11: 损坏密钥文件不被写入', () => {
  it('never writes a secrets file that is not valid JSON', async () => {
    await fc.assert(
      fc.asyncProperty(
        corruptFileArb,
        fc.array(operationArb, { maxLength: 8 }),
        async (initial, operations) => {
          const credentialFs = memoryCredentialFs(initial);
          const cipher = fakeCipher(true);
          const store = createCredentialStore({ file: FILE, crypto: cipher, fs: credentialFs });

          for (const operation of operations) {
            cipher.enabled = operation.encryption;
            if (operation.kind === 'save') {
              const result = await store.save(operation.id, operation.value);
              if (operation.encryption) {
                expect(result).toMatchObject({
                  outcome: 'failed',
                  error: { code: 'SECRETS_FILE_CORRUPTED' },
                });
              } else {
                expect(result).toEqual({ outcome: 'memory-only' });
              }
            } else if (operation.kind === 'delete') {
              expect(await store.delete(operation.id)).toMatchObject({ ok: false });
            } else if (operation.kind === 'migrate') {
              expect(await store.migrateRawEntries()).toEqual({ migrated: 0, failed: 0 });
            } else {
              await store.reload();
            }
          }

          expect(credentialFs.writes).toBe(0);
          expect(credentialFs.memory.files.get(FILE)).toBe(initial);
          expect([...credentialFs.memory.files.keys()]).toEqual([FILE]);
          expect(store.status().corrupted).toBe(true);
        }
      ),
      pbtParams
    );
  });
});

describe('createCredentialStore', () => {
  it('encrypts a key when secure storage is available and reads it back after a restart', async () => {
    const credentialFs = memoryCredentialFs();
    const cipher = fakeCipher(true);
    const store = createCredentialStore({ file: FILE, crypto: cipher, fs: credentialFs });

    expect(await store.save('kernel:custom_deepseek', 'sk-encrypted-密钥')).toEqual({
      outcome: 'encrypted',
    });

    const text = credentialFs.memory.files.get(FILE) ?? '';
    expect(text).not.toContain('sk-encrypted');
    expect(JSON.parse(text)).toEqual({
      version: 2,
      entries: { 'kernel:custom_deepseek': enc('sk-encrypted-密钥') },
    });
    const restarted = createCredentialStore({ file: FILE, crypto: cipher, fs: credentialFs });
    expect(restarted.get('kernel:custom_deepseek')).toBe('sk-encrypted-密钥');
    expect(restarted.status()).toMatchObject({ persistent: true, corrupted: false });
  });

  it('upgrades a version 1 file on the first write and keeps its other entries', async () => {
    const credentialFs = memoryCredentialFs(
      JSON.stringify({ 'provider:openai': enc('sk-openai'), 'kernel:old': raw('sk-old') })
    );
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });

    expect(store.get('kernel:old')).toBe('sk-old');
    expect(store.status().legacyEntries).toBe(1);
    await store.save('kernel:new', 'sk-new');

    expect(JSON.parse(credentialFs.memory.files.get(FILE) ?? '')).toEqual({
      version: 2,
      entries: {
        'provider:openai': enc('sk-openai'),
        'kernel:old': raw('sk-old'),
        'kernel:new': enc('sk-new'),
      },
    });
  });

  it('keeps the previous file and the previous key when the write fails', async () => {
    const initial = v2File({ 'kernel:custom_deepseek': enc('sk-old-key') });
    const credentialFs = memoryCredentialFs(initial);
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });
    credentialFs.memory.fault = { op: 'rename', code: 'EIO', times: 1 };

    const result = await store.save('kernel:custom_deepseek', 'sk-new-key');

    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'ATOMIC_WRITE_FAILED' } });
    expect(credentialFs.memory.files.get(FILE)).toBe(initial);
    expect([...credentialFs.memory.files.keys()]).toEqual([FILE]);
    expect(store.get('kernel:custom_deepseek')).toBe('sk-old-key');
  });

  it('does not keep a memory-only key when the stale copy on disk cannot be removed', async () => {
    const initial = v2File({ 'kernel:custom_deepseek': enc('sk-old-key') });
    const credentialFs = memoryCredentialFs(initial);
    const store = createCredentialStore({
      file: FILE,
      crypto: fakeCipher(false),
      fs: credentialFs,
    });
    credentialFs.failWrite = () => true;

    const result = await store.save('kernel:custom_deepseek', 'sk-new-key');

    expect(result).toMatchObject({ outcome: 'failed', error: { code: 'ATOMIC_WRITE_FAILED' } });
    expect(credentialFs.memory.files.get(FILE)).toBe(initial);
    expect(store.get('kernel:custom_deepseek')).toBe('sk-old-key');
  });

  it.each([
    ['a newer version', '{"version":3,"entries":{}}'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a non-string entry', '{"version":2,"entries":{"kernel:a":1}}'],
    ['an empty file', ''],
  ])('treats %s as a damaged file and leaves it alone', async (_label, initial) => {
    const credentialFs = memoryCredentialFs(initial);
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });

    expect(await store.save('kernel:a', 'sk-value')).toMatchObject({
      outcome: 'failed',
      error: { code: 'SECRETS_FILE_CORRUPTED' },
    });
    expect(store.status().corrupted).toBe(true);
    expect(credentialFs.memory.files.get(FILE)).toBe(initial);
    expect(credentialFs.writes).toBe(0);
  });

  it('writes again once the user deletes the damaged file', async () => {
    const credentialFs = memoryCredentialFs('{"entries": ');
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });
    expect(store.status().corrupted).toBe(true);

    credentialFs.memory.files.delete(FILE);
    await store.reload();

    expect(store.status().corrupted).toBe(false);
    expect(await store.save('kernel:a', 'sk-after-repair')).toEqual({ outcome: 'encrypted' });
  });

  it('counts a raw entry that is not valid Base64 as failed and leaves it as it is', async () => {
    const initial = v2File({ 'kernel:broken': 'raw:not base64!', 'kernel:fine': raw('sk-fine') });
    const credentialFs = memoryCredentialFs(initial);
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });

    expect(await store.migrateRawEntries()).toEqual({ migrated: 1, failed: 1 });
    const entries = entriesOnDisk(credentialFs);
    expect(entries.get('kernel:broken')).toBe('raw:not base64!');
    expect(unsealStored(entries.get('kernel:fine') ?? '')).toBe('sk-fine');
  });

  it('does not migrate while secure storage is unavailable', async () => {
    const initial = v2File({ 'kernel:legacy': raw('sk-legacy') });
    const credentialFs = memoryCredentialFs(initial);
    const store = createCredentialStore({
      file: FILE,
      crypto: fakeCipher(false),
      fs: credentialFs,
    });

    expect(await store.migrateRawEntries()).toEqual({ migrated: 0, failed: 0 });
    expect(store.status()).toMatchObject({ legacyEntries: 1, lastMigration: null });
    expect(credentialFs.memory.files.get(FILE)).toBe(initial);
  });

  it('runs concurrent saves one after another so none of them is lost', async () => {
    const credentialFs = memoryCredentialFs();
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });

    await Promise.all([
      store.save('kernel:a', 'sk-a-value'),
      store.save('kernel:b', 'sk-b-value'),
      store.save('provider:c', 'sk-c-value'),
    ]);

    expect([...entriesOnDisk(credentialFs).keys()].sort()).toEqual([
      'kernel:a',
      'kernel:b',
      'provider:c',
    ]);
  });

  it('reports an entry it cannot decrypt as missing', () => {
    const credentialFs = memoryCredentialFs(v2File({ 'kernel:a': 'enc:AAAA' }));
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });

    expect(store.get('kernel:a')).toBeNull();
  });

  it('remembers every key value it handled, for masking logs', async () => {
    const credentialFs = memoryCredentialFs(v2File({ 'kernel:legacy': raw('sk-legacy-value') }));
    const store = createCredentialStore({
      file: FILE,
      crypto: fakeCipher(false),
      fs: credentialFs,
    });

    await store.save('kernel:session', 'sk-session-value');

    expect(store.sensitiveValues()).toEqual(
      expect.arrayContaining(['sk-legacy-value', 'sk-session-value'])
    );
  });

  it('deletes an entry from the file and from memory', async () => {
    const credentialFs = memoryCredentialFs(v2File({ 'kernel:a': enc('sk-a-value') }));
    const store = createCredentialStore({ file: FILE, crypto: fakeCipher(), fs: credentialFs });

    expect(await store.delete('kernel:a')).toEqual({ ok: true });
    expect(store.get('kernel:a')).toBeNull();
    expect(entriesOnDisk(credentialFs).size).toBe(0);
  });
});

describe('nodeCredentialFs', () => {
  it('creates the directory, writes a private file and reads it back', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-store-test-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'nested', '密钥 文件.json');

    expect(nodeCredentialFs.readFile(file)).toBeNull();
    const store = createCredentialStore({ file, crypto: fakeCipher(), fs: nodeCredentialFs });
    expect(await store.save('kernel:a', 'sk-real-disk')).toEqual({ outcome: 'encrypted' });

    expect(nodeCredentialFs.readFile(file)).not.toContain('sk-real-disk');
    expect(fs.readdirSync(path.dirname(file))).toEqual([path.basename(file)]);
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    const restarted = createCredentialStore({ file, crypto: fakeCipher(), fs: nodeCredentialFs });
    expect(restarted.get('kernel:a')).toBe('sk-real-disk');
  });
});

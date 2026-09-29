import { describe, expect, it, vi } from 'vitest';
import {
  createCredentialIpcHandlers,
  createKernelKeyIpcHandlers,
  MAX_CREDENTIAL_LENGTH,
  registerCredentialIpc,
  UNEXPECTED_ERROR,
} from './credentialIpc';
import {
  createCredentialStore,
  type CredentialCrypto,
  type CredentialFileSystem,
  type CredentialStore,
  type CredentialStoreStatus,
} from './credentialStore';
import { maskSecret } from './secretMask';

const SECRET = 'sk-live-0123456789abcdef';

const STATUS: CredentialStoreStatus = {
  path: '/userData/agent-kernel-secrets.json',
  persistent: true,
  corrupted: false,
  legacyEntries: 0,
  memoryOnlyEntries: 0,
  lastMigration: null,
};

/** A store whose every method is a spy; `sensitiveValues` knows the test key. */
function fakeStore(overrides: Partial<CredentialStore> = {}): CredentialStore {
  return {
    isPersistent: () => true,
    save: vi.fn(async () => ({ outcome: 'encrypted' as const })),
    get: () => null,
    delete: vi.fn(async () => ({ ok: true as const })),
    migrateRawEntries: vi.fn(async () => ({ migrated: 0, failed: 0 })),
    reload: vi.fn(async () => undefined),
    status: () => ({ ...STATUS }),
    sensitiveValues: () => [SECRET],
    ...overrides,
  };
}

const cipher: CredentialCrypto = {
  available: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf8').reverse(),
  decrypt: (ciphertext) => Buffer.from(ciphertext).reverse().toString('utf8'),
};

function memoryFs(initial?: string): CredentialFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial !== undefined) {
    files.set(STATUS.path, initial);
  }
  return {
    files,
    readFile: (file) => files.get(file) ?? null,
    writeFileAtomic: async (file, data) => {
      files.set(file, typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    },
  };
}

describe('credential-save', () => {
  it.each([
    ['a non-string id', 42, SECRET],
    ['an id without a namespace', 'custom_deepseek', SECRET],
    ['an id with a path in it', 'provider:../../etc', SECRET],
    ['a non-string value', 'provider:custom_deepseek', { key: SECRET }],
    ['an empty value', 'provider:custom_deepseek', ''],
    ['a blank value', 'provider:custom_deepseek', '   '],
    ['an oversized value', 'provider:custom_deepseek', 'k'.repeat(MAX_CREDENTIAL_LENGTH + 1)],
  ])('rejects %s without touching the store', async (_label, id, value) => {
    const store = fakeStore();

    const result = await createCredentialIpcHandlers(store).save(id, value);

    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(store.save).not.toHaveBeenCalled();
  });

  it.each(['encrypted', 'memory-only'] as const)('reports a key saved as %s', async (outcome) => {
    const store = fakeStore({ save: vi.fn(async () => ({ outcome })) });

    const result = await createCredentialIpcHandlers(store).save('kernel:openai', SECRET);

    expect(result).toEqual({ ok: true, data: { outcome } });
    expect(store.save).toHaveBeenCalledWith('kernel:openai', SECRET);
  });

  it('masks the key in the error of a failed save', async () => {
    const store = fakeStore({
      save: vi.fn(async () => ({
        outcome: 'failed' as const,
        error: { code: 'ENCRYPTION_FAILED' as const, cause: new Error(`refused ${SECRET}`) },
      })),
    });

    const result = await createCredentialIpcHandlers(store).save('kernel:openai', SECRET);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.code).toBe('ENCRYPTION_FAILED');
    expect(result.error.message).not.toContain(SECRET);
    expect(result.error.message).toContain(maskSecret(SECRET));
  });

  it('turns an exception into a masked error instead of a rejected call', async () => {
    const store = fakeStore({
      save: vi.fn(async () => {
        throw new Error(`keychain locked while saving ${SECRET}`);
      }),
    });

    const result = await createCredentialIpcHandlers(store).save('kernel:openai', SECRET);

    expect(result).toMatchObject({ ok: false, error: { code: UNEXPECTED_ERROR } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it('reports a damaged secrets file as such', async () => {
    const store = createCredentialStore({
      file: STATUS.path,
      crypto: cipher,
      fs: memoryFs('{"version"'),
    });

    const result = await createCredentialIpcHandlers(store).save('kernel:openai', SECRET);

    expect(result).toMatchObject({ ok: false, error: { code: 'SECRETS_FILE_CORRUPTED' } });
  });
});

describe('credential-status', () => {
  it('reads the file again so a repaired secrets file is picked up', async () => {
    const fs = memoryFs('not json');
    const handlers = createCredentialIpcHandlers(
      createCredentialStore({ file: STATUS.path, crypto: cipher, fs })
    );
    expect(await handlers.status()).toMatchObject({ ok: true, data: { corrupted: true } });

    fs.files.delete(STATUS.path);

    expect(await handlers.status()).toEqual({
      ok: true,
      data: { ...STATUS, corrupted: false },
    });
  });

  it('reports that keys stay in memory while secure storage is unavailable', async () => {
    const store = createCredentialStore({
      file: STATUS.path,
      crypto: { ...cipher, available: () => false },
      fs: memoryFs(),
    });
    const handlers = createCredentialIpcHandlers(store);

    expect(await handlers.save('kernel:openai', SECRET)).toEqual({
      ok: true,
      data: { outcome: 'memory-only' },
    });
    expect(await handlers.status()).toMatchObject({
      ok: true,
      data: { persistent: false, memoryOnlyEntries: 1 },
    });
  });
});

describe('credential-migrate', () => {
  it('returns how many legacy entries were migrated and how many failed', async () => {
    const legacy = `raw:${Buffer.from(SECRET, 'utf8').toString('base64')}`;
    const fs = memoryFs(JSON.stringify({ 'kernel:a': legacy, 'kernel:b': 'raw:not base64' }));
    const handlers = createCredentialIpcHandlers(
      createCredentialStore({ file: STATUS.path, crypto: cipher, fs })
    );

    expect(await handlers.migrate()).toEqual({ ok: true, data: { migrated: 1, failed: 1 } });
    expect(await handlers.status()).toMatchObject({
      ok: true,
      data: { legacyEntries: 1, lastMigration: { migrated: 1, failed: 1 } },
    });
    expect(fs.files.get(STATUS.path)).not.toContain(legacy);
  });
});

describe('kernel key channels', () => {
  const manager = () => ({
    rememberProviderKey: vi.fn(async () => ({ outcome: 'memory-only' as const })),
    setKernelKey: vi.fn(async () => ({ outcome: 'encrypted' as const })),
    clearKernelKey: vi.fn(async () => ({ ok: true as const })),
    forgetProviderKey: vi.fn(async () => ({
      ok: false as const,
      error: { code: 'SECRETS_FILE_CORRUPTED' as const },
    })),
  });

  it('passes valid calls through and reports their outcome', async () => {
    const kernel = manager();
    const handlers = createKernelKeyIpcHandlers(fakeStore(), kernel);

    expect(await handlers.rememberProviderKey('custom_deepseek', SECRET)).toEqual({
      ok: true,
      data: { outcome: 'memory-only' },
    });
    expect(await handlers.setKernelKey('custom_deepseek', SECRET)).toEqual({
      ok: true,
      data: { outcome: 'encrypted' },
    });
    expect(await handlers.clearKernelKey('custom_deepseek')).toEqual({ ok: true, data: null });
    expect(await handlers.forgetProviderKey('custom_deepseek')).toMatchObject({
      ok: false,
      error: { code: 'SECRETS_FILE_CORRUPTED' },
    });
    expect(kernel.setKernelKey).toHaveBeenCalledWith('custom_deepseek', SECRET);
  });

  it('rejects malformed provider ids and keys', async () => {
    const kernel = manager();
    const handlers = createKernelKeyIpcHandlers(fakeStore(), kernel);

    expect(await handlers.setKernelKey('', SECRET)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT' },
    });
    expect(await handlers.setKernelKey('custom deepseek', SECRET)).toMatchObject({ ok: false });
    expect(await handlers.rememberProviderKey('custom_deepseek', 7)).toMatchObject({ ok: false });
    expect(await handlers.clearKernelKey(null)).toMatchObject({ ok: false });
    expect(kernel.setKernelKey).not.toHaveBeenCalled();
    expect(kernel.rememberProviderKey).not.toHaveBeenCalled();
    expect(kernel.clearKernelKey).not.toHaveBeenCalled();
  });
});

describe('registerCredentialIpc', () => {
  it('registers the three credential channels', async () => {
    const handle = vi.fn();
    const store = fakeStore();

    registerCredentialIpc({ handle }, store);

    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'credential-save',
      'credential-status',
      'credential-migrate',
    ]);
    const save = handle.mock.calls[0][1] as (event: unknown, ...args: unknown[]) => unknown;
    expect(await save({}, 'kernel:openai', SECRET)).toEqual({
      ok: true,
      data: { outcome: 'encrypted' },
    });
  });
});

/**
 * IPC for the desktop credential store (requirement 2). The renderer can save keys and read
 * the state of the store, but never read a key back. Every handler validates its arguments
 * and returns an `IpcResult` whose error message went through `toIpcError`, so no key value
 * leaves the main process (requirement 1.10).
 */
import type { IpcMain } from 'electron';
import type { AgentKernelManager } from './agentKernel';
import type {
  CredentialErrorCode,
  CredentialStore,
  CredentialStoreStatus,
  DeleteResult,
  MigrationResult,
  SaveResult,
} from './credentialStore';
import { describeError, toIpcError, type IpcError, type IpcResult } from './ipcResult';

export interface CredentialSaveData {
  /** `memory-only`: kept for this session only, because the OS offers no secure storage. */
  outcome: 'encrypted' | 'memory-only';
}

export type CredentialSaveResult = IpcResult<CredentialSaveData>;

/** Thrown exceptions that no store operation reports by itself. */
export const UNEXPECTED_ERROR = 'UNEXPECTED';

/** `<namespace>:<name>`, e.g. `provider:custom_deepseek` or `kernel:openai`. */
const CREDENTIAL_ID = /^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9_.-]{1,200}$/;
/** Provider ids as goose generates them (`custom_<name>`) plus the built-in ones. */
const PROVIDER_ID = /^[A-Za-z0-9_.-]{1,200}$/;
/** API keys are far shorter; the cap keeps a runaway caller from bloating the secrets file. */
export const MAX_CREDENTIAL_LENGTH = 16 * 1024;

const FAILURE_TEXT: Record<CredentialErrorCode, string> = {
  SECRETS_FILE_CORRUPTED:
    'The secrets file cannot be read; nothing is written to it until it is repaired or deleted',
  ATOMIC_WRITE_FAILED: 'Writing the secrets file failed; the previous file is unchanged',
  ENCRYPTION_FAILED: 'The system secure storage could not encrypt the key',
  INVALID_INPUT: 'Invalid credential id or value',
};

const isCredentialId = (id: unknown): id is string =>
  typeof id === 'string' && CREDENTIAL_ID.test(id);

const isProviderId = (id: unknown): id is string => typeof id === 'string' && PROVIDER_ID.test(id);

const isCredentialValue = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_CREDENTIAL_LENGTH;

function credentialFailure(
  store: CredentialStore,
  code: CredentialErrorCode,
  cause?: unknown
): { ok: false; error: IpcError } {
  const detail =
    cause === undefined ? FAILURE_TEXT[code] : `${FAILURE_TEXT[code]}: ${describeError(cause)}`;
  return { ok: false, error: toIpcError(code, detail, store.sensitiveValues()) };
}

export function toCredentialSaveResult(
  store: CredentialStore,
  result: SaveResult
): CredentialSaveResult {
  return result.outcome === 'failed'
    ? credentialFailure(store, result.error.code, result.error.cause)
    : { ok: true, data: { outcome: result.outcome } };
}

export function toCredentialDeleteResult(
  store: CredentialStore,
  result: DeleteResult
): IpcResult<null> {
  return result.ok
    ? { ok: true, data: null }
    : credentialFailure(store, result.error.code, result.error.cause);
}

/** Turns an exception into a masked error result instead of a rejected IPC call. */
async function guarded<T>(
  store: CredentialStore,
  task: () => Promise<IpcResult<T>>
): Promise<IpcResult<T>> {
  try {
    return await task();
  } catch (error) {
    return { ok: false, error: toIpcError(UNEXPECTED_ERROR, error, store.sensitiveValues()) };
  }
}

export interface CredentialIpcHandlers {
  save: (id: unknown, value: unknown) => Promise<CredentialSaveResult>;
  status: () => Promise<IpcResult<CredentialStoreStatus>>;
  migrate: () => Promise<IpcResult<MigrationResult>>;
}

export function createCredentialIpcHandlers(store: CredentialStore): CredentialIpcHandlers {
  return {
    save: (id, value) =>
      guarded(store, async (): Promise<CredentialSaveResult> => {
        if (!isCredentialId(id) || !isCredentialValue(value)) {
          return credentialFailure(store, 'INVALID_INPUT');
        }
        return toCredentialSaveResult(store, await store.save(id, value));
      }),
    status: () =>
      guarded(store, async (): Promise<IpcResult<CredentialStoreStatus>> => {
        // Picks up a secrets file the user repaired or deleted since it was last read (2.7).
        await store.reload();
        return { ok: true, data: store.status() };
      }),
    migrate: () =>
      guarded(
        store,
        async (): Promise<IpcResult<MigrationResult>> => ({
          ok: true,
          data: await store.migrateRawEntries(),
        })
      ),
  };
}

type KernelKeyManager = Pick<
  AgentKernelManager,
  'rememberProviderKey' | 'setKernelKey' | 'clearKernelKey' | 'forgetProviderKey'
>;

export interface KernelKeyIpcHandlers {
  rememberProviderKey: (providerId: unknown, apiKey: unknown) => Promise<CredentialSaveResult>;
  setKernelKey: (providerId: unknown, apiKey: unknown) => Promise<CredentialSaveResult>;
  clearKernelKey: (providerId: unknown) => Promise<IpcResult<null>>;
  forgetProviderKey: (providerId: unknown) => Promise<IpcResult<null>>;
}

/** The agent kernel key channels, which save into the same store as `credential-save`. */
export function createKernelKeyIpcHandlers(
  store: CredentialStore,
  manager: KernelKeyManager
): KernelKeyIpcHandlers {
  const save =
    (action: (providerId: string, apiKey: string) => Promise<SaveResult>) =>
    (providerId: unknown, apiKey: unknown): Promise<CredentialSaveResult> =>
      guarded(store, async (): Promise<CredentialSaveResult> => {
        if (!isProviderId(providerId) || !isCredentialValue(apiKey)) {
          return credentialFailure(store, 'INVALID_INPUT');
        }
        return toCredentialSaveResult(store, await action(providerId, apiKey));
      });

  const remove =
    (action: (providerId: string) => Promise<DeleteResult>) =>
    (providerId: unknown): Promise<IpcResult<null>> =>
      guarded(store, async (): Promise<IpcResult<null>> => {
        if (!isProviderId(providerId)) {
          return credentialFailure(store, 'INVALID_INPUT');
        }
        return toCredentialDeleteResult(store, await action(providerId));
      });

  return {
    rememberProviderKey: save(manager.rememberProviderKey),
    setKernelKey: save(manager.setKernelKey),
    clearKernelKey: remove(manager.clearKernelKey),
    forgetProviderKey: remove(manager.forgetProviderKey),
  };
}

/** Registers `credential-save`, `credential-status` and `credential-migrate`. */
export function registerCredentialIpc(ipc: Pick<IpcMain, 'handle'>, store: CredentialStore): void {
  const handlers = createCredentialIpcHandlers(store);
  ipc.handle('credential-save', (_event, id: unknown, value: unknown) => handlers.save(id, value));
  ipc.handle('credential-status', () => handlers.status());
  ipc.handle('credential-migrate', () => handlers.migrate());
}

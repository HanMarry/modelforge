/**
 * IPC for the Feishu connector settings (requirement 15.3). App ID and App Secret are kept in
 * the desktop CredentialStore and only ever surfaced as masks; the enable flag and the open_id
 * whitelist are kept in a plain JSON file under the user data directory.
 *
 * `feishu-undelivered` reports whether a session was marked "飞书回复未送达" (requirement 15.2);
 * marks made while the app runs are pushed on `FEISHU_UNDELIVERED_CHANNEL`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IpcMain } from 'electron';
import type { CredentialStore } from '../../utils/credentialStore';
import { maskSecret } from '../../utils/secretMask';
import { describeError, toIpcError, type IpcResult } from '../../utils/ipcResult';
import { normalizeWhitelist } from './routing';
import type { FeishuLinkState } from './larkChannel';

const FEISHU_APP_ID = 'feishu:app_id';
const FEISHU_APP_SECRET = 'feishu:app_secret';

/** Push event: a session was just marked as having an undelivered Feishu reply. */
export const FEISHU_UNDELIVERED_CHANNEL = 'feishu-undelivered-changed';

export interface FeishuConfig {
  enabled: boolean;
  appIdMasked: string | null;
  appSecretMasked: string | null;
  whitelist: string[];
}

export interface FeishuSaveConfig {
  enabled?: boolean;
  appId?: string;
  appSecret?: string;
  whitelist?: string[];
}

export interface FeishuStatus {
  /** Whether the connector is actually running (not just enabled in settings). */
  started: boolean;
  link: FeishuLinkState;
}

export interface FeishuUndeliveredMark {
  /** ISO 8601 time of the latest reply that could not be delivered. */
  markedAt: string;
}

export interface FeishuUndeliveredEvent extends FeishuUndeliveredMark {
  sessionId: string;
}

export interface FeishuController {
  start: (config: { appId: string; appSecret: string; whitelist: string[] }) => Promise<void>;
  stop: () => Promise<void>;
  /** Whether the connector is actually running (not just enabled in settings). */
  isStarted: () => boolean;
  status: () => FeishuStatus;
}

interface FeishuState {
  enabled: boolean;
  whitelist: string[];
}

const defaultState = (): FeishuState => ({ enabled: false, whitelist: [] });

function maskValue(value: string | null): string | null {
  return value ? maskSecret(value) : null;
}

export function registerFeishuIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: {
    store: CredentialStore;
    file: string;
    controller: FeishuController;
    /** The undelivered mark of a session, if any. */
    undelivered: (sessionId: string) => FeishuUndeliveredMark | null;
    /** Saved settings start the connector once this resolves (the CredentialStore needs it). */
    ready?: Promise<unknown>;
    log?: (m: string) => void;
  }
): void {
  const { store, controller, log = () => {} } = deps;

  const readState = (): FeishuState => {
    try {
      const raw = fs.readFileSync(deps.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<FeishuState>;
      return {
        enabled: parsed.enabled === true,
        whitelist: Array.isArray(parsed.whitelist) ? normalizeWhitelist(parsed.whitelist) : [],
      };
    } catch {
      return defaultState();
    }
  };

  const writeState = (state: FeishuState): void => {
    fs.mkdirSync(path.dirname(deps.file), { recursive: true });
    fs.writeFileSync(deps.file, JSON.stringify(state, null, 2), 'utf8');
  };

  const masked = (id: string): string | null => maskValue(store.get(id));

  const currentConfig = (): FeishuConfig => {
    const state = readState();
    return {
      enabled: state.enabled,
      appIdMasked: masked(FEISHU_APP_ID),
      appSecretMasked: masked(FEISHU_APP_SECRET),
      whitelist: state.whitelist,
    };
  };

  const startIfEnabled = async (): Promise<void> => {
    const state = readState();
    const appId = store.get(FEISHU_APP_ID);
    const appSecret = store.get(FEISHU_APP_SECRET);
    if (state.enabled && appId && appSecret) {
      await controller.start({ appId, appSecret, whitelist: state.whitelist });
    } else if (state.enabled) {
      log('feishu enabled but App ID/Secret missing; not starting');
    }
  };

  ipc.handle('feishu-get-config', (): FeishuConfig => currentConfig());

  ipc.handle('feishu-save-config', async (_event, patch: FeishuSaveConfig) =>
    (async (): Promise<IpcResult<FeishuConfig>> => {
      const state = readState();
      if (typeof patch.enabled === 'boolean') {
        state.enabled = patch.enabled;
      }
      if (Array.isArray(patch.whitelist)) {
        state.whitelist = normalizeWhitelist(patch.whitelist);
      }
      writeState(state);

      if (typeof patch.appId === 'string' && patch.appId.trim()) {
        await store.save(FEISHU_APP_ID, patch.appId.trim());
      }
      if (typeof patch.appSecret === 'string' && patch.appSecret.trim()) {
        await store.save(FEISHU_APP_SECRET, patch.appSecret.trim());
      }

      await controller.stop();
      if (state.enabled) {
        await startIfEnabled();
      }
      return { ok: true, data: currentConfig() };
    })().catch((error) => ({
      ok: false as const,
      error: toIpcError('UNEXPECTED', describeError(error), store.sensitiveValues()),
    }))
  );

  ipc.handle('feishu-status', async () =>
    (async (): Promise<IpcResult<FeishuStatus>> => {
      return { ok: true, data: controller.status() };
    })().catch((error) => ({
      ok: false as const,
      error: toIpcError('UNEXPECTED', describeError(error), store.sensitiveValues()),
    }))
  );

  ipc.handle('feishu-undelivered', async (_event, sessionId: unknown) =>
    (async (): Promise<IpcResult<FeishuUndeliveredMark | null>> => {
      if (typeof sessionId !== 'string' || !sessionId) {
        return {
          ok: false,
          error: toIpcError('INVALID_ARGUMENT', 'sessionId is required', store.sensitiveValues()),
        };
      }
      return { ok: true, data: deps.undelivered(sessionId) };
    })().catch((error) => ({
      ok: false as const,
      error: toIpcError('UNEXPECTED', describeError(error), store.sensitiveValues()),
    }))
  );

  void (deps.ready ?? Promise.resolve())
    .then(startIfEnabled)
    .catch((error) => log(`starting from saved settings failed: ${describeError(error)}`));
}

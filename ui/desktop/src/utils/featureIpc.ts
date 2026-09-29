/**
 * Shared plumbing for the layer C feature IPC modules (spec mathmodel-parity-and-beyond, stage 2):
 * runs and artifacts, paper check, run comparison, task resume, mock review and learning path.
 * Each feature registers its channels in its own module; main.ts builds one `FeatureIpcDeps` and
 * passes it to every `register<Feature>Ipc`. Owned by the C0 skeleton: feature branches do not
 * edit this file (see layer-c-contract-desktop.md).
 */
import { toIpcError, type IpcResult } from './ipcResult';

export interface FeatureIpcDeps {
  /** Key values masked in every error message that leaves the main process (requirement 1.10). */
  sensitiveValues: () => string[];
  /** `app.getPath('userData')`, e.g. for `learning-progress.json`. */
  userDataDir: string;
  /** Sends a push event to every regular renderer window. */
  broadcast: (channel: string, payload: unknown) => void;
}

/** Error code of a channel that is registered but not implemented yet. */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

/** The uniform result of a placeholder handler; feature branches replace it channel by channel. */
export function notImplemented(channel: string, deps: FeatureIpcDeps): IpcResult<never> {
  const message = `${channel} is not implemented yet`;
  return { ok: false, error: toIpcError(NOT_IMPLEMENTED, message, deps.sensitiveValues()) };
}

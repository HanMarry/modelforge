import type {
  ConfirmOverwriteRequest_unstable,
  ConfirmOverwriteResponse_unstable,
} from '@aaif/goose-acp-client';

/**
 * Handles the Kernel's `_goose/unstable/tasks/confirm-overwrite` request (spec
 * mathmodel-parity-and-beyond, task 25.4): a resumed step is about to overwrite output files that
 * already exist. The request lists each file's Project-relative path, size and modification time.
 * Only `confirm` lets the step run; on `cancel` the task stays 已暂停 and no file changes
 * (requirement 22.6). The Kernel only sends it because `acpConnection.ts` declares
 * `overwriteConfirmRequests`. Contract:
 * `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 *
 * Until branch `mp/s2-c1-resume` installs a handler that asks the user, every overwrite is
 * cancelled.
 */

export type OverwriteConfirmHandler = (
  request: ConfirmOverwriteRequest_unstable
) => Promise<ConfirmOverwriteResponse_unstable>;

/** The default handler: keeps every file. */
export const cancelOverwrite: OverwriteConfirmHandler = async () => ({ action: 'cancel' });

let currentHandler: OverwriteConfirmHandler = cancelOverwrite;

/**
 * Installs `handler` (for example while the resume dialog is mounted) and returns the function
 * that puts the previous handler back.
 */
export function setOverwriteConfirmHandler(handler: OverwriteConfirmHandler): () => void {
  const previousHandler = currentHandler;
  currentHandler = handler;
  return () => {
    if (currentHandler === handler) {
      currentHandler = previousHandler;
    }
  };
}

/** Anything but an explicit `confirm`, including a failing handler, keeps the files. */
export async function requestAcpOverwriteConfirm(
  request: ConfirmOverwriteRequest_unstable
): Promise<ConfirmOverwriteResponse_unstable> {
  try {
    const response = await currentHandler(request);
    return { action: response?.action === 'confirm' ? 'confirm' : 'cancel' };
  } catch (error) {
    console.error('The confirm-overwrite handler failed; keeping the files:', error);
    return { action: 'cancel' };
  }
}

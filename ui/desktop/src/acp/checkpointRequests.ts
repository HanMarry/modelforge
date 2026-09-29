import type {
  EnsureCheckpointRequest_unstable,
  EnsureCheckpointResponse_unstable,
} from '@aaif/goose-acp-client';

/**
 * Handles the Kernel's `_goose/unstable/session/checkpoint/ensure` request by
 * asking the main process to snapshot the project. A failure throws so the ACP
 * request is answered with an error, which blocks the pending write tool.
 */
export async function requestAcpCheckpointEnsure(
  request: EnsureCheckpointRequest_unstable
): Promise<EnsureCheckpointResponse_unstable> {
  const result = await window.electron.checkpointEnsure(
    request.workingDir,
    request.sessionId,
    request.turn
  );
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`);
  }
  return { checkpointId: result.value.checkpointId };
}

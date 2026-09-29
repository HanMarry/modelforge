/**
 * Renderer API for comparing two runs (requirement 21, task 24.3). Implemented by
 * `bridges/runCompareBridge.ts`, served by `utils/compare/runCompareIpc.ts`; owned by
 * `mp/s2-c1-compare`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { RunComparison } from './runCompare';

export interface RunCompareRequest {
  /** Both runs must belong to this Project (21.1). */
  projectDir: string;
  runIdA: string;
  runIdB: string;
}

export interface RunCompareApi {
  runsCompare: (request: RunCompareRequest) => Promise<IpcResult<RunComparison>>;
}

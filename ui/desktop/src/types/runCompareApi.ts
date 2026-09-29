/**
 * Renderer API for comparing two runs (requirement 21, task 24.3). Implemented by
 * `bridges/runCompareBridge.ts`, served by `utils/compare/runCompareIpc.ts`; owned by
 * `mp/s2-c1-compare`.
 */
import type { IpcResult } from '../utils/ipcResult';
import type { RunComparison, RunMeta, RunMetaProblem } from './runCompare';
import type { RunFailure, RunRecord, RunRecordProblem } from './runRecord';

export interface RunCompareRequest {
  /** Both runs must belong to this Project (21.1). */
  projectDir: string;
  runIdA: string;
  runIdB: string;
}

/**
 * A marker shown on one side of the comparison (requirement 21.5): `failed` when the exit code
 * is not 0 or an Artifact of the run is `执行失败`, `stale` when an Artifact of the run is
 * `已过期`.
 */
export type RunCompareFlag = 'failed' | 'stale';

/** How `.modelforge/artifacts.json` was found; only `present` gives stale markers and verdicts. */
export type ArtifactIndexState = 'present' | 'missing' | 'invalid';

export interface RunCompareSide {
  record: RunRecord;
  /** From `<runId>.meta.json`; `null` when the file is absent or invalid. */
  meta: RunMeta | null;
  /** Set when the `.meta.json` file exists but cannot be used. */
  metaProblem: RunMetaProblem | null;
  /** In the order `failed`, `stale`; empty when neither applies. */
  flags: RunCompareFlag[];
  /** Failure kind to show with `failed`: the record's own, else the one of a failed Artifact. */
  failure: RunFailure | null;
  /** Latest time an output of this run was marked verified; `null` when none was. */
  verifiedAt: string | null;
}

/** `RunComparison` plus both sides, so the view needs a single round trip. */
export interface RunCompareResult extends RunComparison {
  a: RunCompareSide;
  b: RunCompareSide;
  artifactIndex: ArtifactIndexState;
}

/** One Run_Record of the Project, as listed for picking the two runs. */
export interface RunCompareCandidate {
  runId: string;
  command: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  failure: RunFailure | null;
  /** Method from the run's `.meta.json`; `null` when absent or invalid. */
  method: string | null;
}

export interface RunCompareCandidates {
  /** Newest first (run ids start with the local start time). */
  runs: RunCompareCandidate[];
  /** Record files that could not be read; the other records still load (requirement 16.5). */
  problems: RunRecordProblem[];
}

export interface RunCompareApi {
  runsCompare: (request: RunCompareRequest) => Promise<IpcResult<RunCompareResult>>;
  /** Run_Records of `projectDir`, read by this feature itself (`runs-list` belongs to runs). */
  runsCompareList: (projectDir: string) => Promise<IpcResult<RunCompareCandidates>>;
}

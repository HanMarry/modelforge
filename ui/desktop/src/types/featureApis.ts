/**
 * The layer C feature APIs that `preload.ts` adds to `window.electron` (spec
 * mathmodel-parity-and-beyond, stage 2). Each feature owns its own `types/<feature>Api.ts`; this
 * file only combines them and belongs to the C0 skeleton (see layer-c-contract-desktop.md).
 */
import type { LearningApi } from './learningApi';
import type { PaperCheckApi } from './paperCheckApi';
import type { ReviewApi } from './reviewApi';
import type { RunCompareApi } from './runCompareApi';
import type { RunsApi } from './runsApi';
import type { TaskResumeApi } from './taskResumeApi';

export type FeatureApis = RunsApi &
  PaperCheckApi &
  RunCompareApi &
  TaskResumeApi &
  ReviewApi &
  LearningApi;

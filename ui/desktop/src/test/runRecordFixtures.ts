/**
 * Run_Record fixtures for the tests of the runs and Artifact_Status I/O layer
 * (`utils/runs/*.test.ts`, `components/workspace/ProjectPanel.test.tsx`).
 */
import { createHash } from 'node:crypto';
import type { RunRecord } from '../types/runRecord';

export const RUN_ID = '20260920T101530123-a1b2c3';
/** Started a second after `RUN_ID`. */
export const LATER_RUN_ID = '20260920T101531123-d4e5f6';

export const INPUT_TEXT = 'x,y\n1,2\n';
export const CODE_TEXT = 'print(1)\n';
export const OUTPUT_TEXT = 'a\n1\n';

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A successful run of `code/q1.py` that read `data/in.csv` and wrote `results/out.csv`. */
export function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    inputs: [{ path: 'data/in.csv', sha256: sha256(INPUT_TEXT) }],
    inputsTruncated: false,
    code: { path: 'code/q1.py', sha256: sha256(CODE_TEXT) },
    config: { provider: 'openai', model: 'gpt-test', runtime: 'Python 3.12.1' },
    command: 'python code/q1.py',
    dependencies: [{ name: 'numpy', version: '2.1.0' }],
    seed: '42',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs: [{ path: 'results/out.csv', sha256: sha256(OUTPUT_TEXT) }],
    outputsTruncated: false,
    ...overrides,
  };
}

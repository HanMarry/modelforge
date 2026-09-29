import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import type { CompareRow } from '../../types/runCompare';
import type {
  RunCompareCandidate,
  RunCompareCandidates,
  RunCompareResult,
  RunCompareSide,
} from '../../types/runCompareApi';
import type { RunFailure, RunRecordProblem } from '../../types/runRecord';
import type { IpcError } from '../../utils/ipcResult';
import { cn } from '../../utils';
import {
  buildCompareTask,
  COMPARE_TASK_TIMEOUT_SECONDS,
  formatDuration,
  formatRunTimestamp,
  runDurationSeconds,
} from '../../utils/compare/compareTask';
import type { CompareTaskReason } from '../../utils/compare/sendCompareTask';
import { COMPARE_MISSING } from '../../utils/runCompare';
import type { WorkspaceFeaturePanelProps } from './featurePanelProps';

const messages = defineMessages({
  title: { id: 'runCompare.title', defaultMessage: 'Compare runs' },
  subtitle: {
    id: 'runCompare.subtitle',
    defaultMessage: 'Pick two runs of this project to see them side by side.',
  },
  refresh: { id: 'runCompare.refresh', defaultMessage: 'Refresh run records' },
  loading: { id: 'runCompare.loading', defaultMessage: 'Loading run records…' },
  listFailed: { id: 'runCompare.listFailed', defaultMessage: 'Could not load the run records.' },
  retry: { id: 'runCompare.retry', defaultMessage: 'Retry' },
  errorDetail: { id: 'runCompare.errorDetail', defaultMessage: 'Details: {detail}' },
  empty: {
    id: 'runCompare.empty',
    defaultMessage: 'No run records in this project yet. Runs of computation code appear here.',
  },
  problems: {
    id: 'runCompare.problems',
    defaultMessage: 'Run record files that could not be read: {count}',
  },
  problemItem: { id: 'runCompare.problemItem', defaultMessage: '{path} ({reason})' },
  problemSyntax: {
    id: 'runCompare.problemSyntax',
    defaultMessage: 'JSON error at line {line}, column {column}',
  },
  problemMissing: { id: 'runCompare.problemMissing', defaultMessage: 'missing: {fields}' },
  problemInvalid: { id: 'runCompare.problemInvalid', defaultMessage: 'invalid: {fields}' },
  runsLegend: { id: 'runCompare.runsLegend', defaultMessage: 'Run records' },
  selectHint: {
    id: 'runCompare.selectHint',
    defaultMessage: 'Select exactly two run records of the same project to compare them.',
  },
  selectedCount: { id: 'runCompare.selectedCount', defaultMessage: 'Selected: {count}' },
  compare: { id: 'runCompare.compare', defaultMessage: 'Compare' },
  comparing: { id: 'runCompare.comparing', defaultMessage: 'Comparing…' },
  compareFailed: {
    id: 'runCompare.compareFailed',
    defaultMessage: 'Could not compare these runs.',
  },
  field: { id: 'runCompare.field', defaultMessage: 'Item' },
  runA: { id: 'runCompare.runA', defaultMessage: 'Run A' },
  runB: { id: 'runCompare.runB', defaultMessage: 'Run B' },
  runId: { id: 'runCompare.runId', defaultMessage: 'Run ID' },
  method: { id: 'runCompare.method', defaultMessage: 'Method' },
  started: { id: 'runCompare.started', defaultMessage: 'Started' },
  ended: { id: 'runCompare.ended', defaultMessage: 'Ended' },
  duration: { id: 'runCompare.duration', defaultMessage: 'Duration' },
  exitCode: { id: 'runCompare.exitCode', defaultMessage: 'Exit code' },
  exitCodeValue: { id: 'runCompare.exitCodeValue', defaultMessage: 'Exit code {code}' },
  noExitCode: { id: 'runCompare.noExitCode', defaultMessage: 'No exit code' },
  verification: { id: 'runCompare.verification', defaultMessage: 'Verification' },
  verifiedAt: { id: 'runCompare.verifiedAt', defaultMessage: 'Verified at {time}' },
  unverified: { id: 'runCompare.unverified', defaultMessage: 'Not verified' },
  verificationUnknown: {
    id: 'runCompare.verificationUnknown',
    defaultMessage: 'Unknown, no artifact status yet',
  },
  params: { id: 'runCompare.params', defaultMessage: 'Parameters' },
  metrics: { id: 'runCompare.metrics', defaultMessage: 'Metrics' },
  noRows: {
    id: 'runCompare.noRows',
    defaultMessage:
      'Neither run recorded parameters or metrics. A script can write them to a .meta.json file next to the run record.',
  },
  differs: { id: 'runCompare.differs', defaultMessage: 'Values differ' },
  flagFailed: { id: 'runCompare.flagFailed', defaultMessage: 'Failed' },
  flagFailedReason: { id: 'runCompare.flagFailedReason', defaultMessage: 'Failed: {reason}' },
  flagStale: { id: 'runCompare.flagStale', defaultMessage: 'Out of date' },
  failureNonZero: { id: 'runCompare.failureNonZero', defaultMessage: 'non-zero exit code' },
  failureTimeout: { id: 'runCompare.failureTimeout', defaultMessage: 'timed out' },
  failureCancelled: { id: 'runCompare.failureCancelled', defaultMessage: 'cancelled by user' },
  metaProblem: {
    id: 'runCompare.metaProblem',
    defaultMessage:
      'The .meta.json of {runId} could not be read, so its method, parameters and metrics are missing.',
  },
  artifactIndexInvalid: {
    id: 'runCompare.artifactIndexInvalid',
    defaultMessage:
      'The artifact status file could not be read, so out-of-date markers are missing.',
  },
  inputMismatch: {
    id: 'runCompare.inputMismatch',
    defaultMessage: 'Input data differs; the comparison may be invalid.',
  },
  inputMismatchFiles: {
    id: 'runCompare.inputMismatchFiles',
    defaultMessage: 'Input files that differ:',
  },
  inputsMatch: {
    id: 'runCompare.inputsMatch',
    defaultMessage: 'Both runs read the same input files.',
  },
  inputsTruncated: {
    id: 'runCompare.inputsTruncated',
    defaultMessage: 'An input list was cut at 1000 files; files beyond that were not compared.',
  },
  generate: { id: 'runCompare.generate', defaultMessage: 'Generate comparison paragraph' },
  generating: {
    id: 'runCompare.generating',
    defaultMessage: 'Writing the paragraph in the current chat, up to {seconds} seconds…',
  },
  generated: {
    id: 'runCompare.generated',
    defaultMessage: 'The comparison paragraph is in the current chat.',
  },
  composed: {
    id: 'runCompare.composed',
    defaultMessage: 'The writing task was added to the chat input. Send it to start.',
  },
  busy: {
    id: 'runCompare.busy',
    defaultMessage: 'The current chat is still working. Try again when it finishes.',
  },
  failedKernelUnavailable: {
    id: 'runCompare.failedKernelUnavailable',
    defaultMessage: 'Paragraph not generated: the Kernel is not available.',
  },
  failedTimeout: {
    id: 'runCompare.failedTimeout',
    defaultMessage:
      'Paragraph not generated: the Kernel did not finish within {seconds} seconds.',
  },
  failedKernelError: {
    id: 'runCompare.failedKernelError',
    defaultMessage: 'Paragraph not generated: the Kernel returned an error.',
  },
});

const FAILURE_MESSAGES = {
  kernelUnavailable: messages.failedKernelUnavailable,
  timeout: messages.failedTimeout,
  kernelError: messages.failedKernelError,
  busy: messages.busy,
};

const control =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info transition-colors motion-reduce:transition-none disabled:cursor-not-allowed disabled:opacity-50';

interface ListState {
  projectDir: string;
  loading: boolean;
  data: RunCompareCandidates | null;
  error: IpcError | null;
}

type ComparisonState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; result: RunCompareResult }
  | { status: 'error'; error: IpcError };

type GenerationState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done' }
  | { status: 'composed' }
  | { status: 'failed'; reason: CompareTaskReason; detail: string };

interface Selection {
  projectDir: string;
  /** In the order the user picked them: the first is run A, the second run B. */
  runIds: string[];
}

function ipcFailure(error: unknown): IpcError {
  return { code: 'IPC_FAILED', message: error instanceof Error ? error.message : String(error) };
}

function isFailedRun(run: Pick<RunCompareCandidate, 'exitCode' | 'failure'>): boolean {
  return run.exitCode !== 0 || run.failure !== null;
}

/**
 * Run comparison tab (requirement 21, task 24.3). It is a workspace tab rather than a popover of
 * `ProjectPanel` (layer-c-contract-desktop.md), so it lists the Project's runs itself through
 * `runs-compare-list` and lets the user pick exactly two.
 */
export default function RunComparePanel({
  workingDir,
  active,
  isAgentActive,
  onCompose,
}: WorkspaceFeaturePanelProps) {
  const intl = useIntl();
  const hintId = useId();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // The panel is mounted inside the visible chat session; the Hub has no session yet.
  const sessionId = location.pathname === '/pair' ? searchParams.get('resumeSessionId') : null;

  const [list, setList] = useState<ListState>({
    projectDir: workingDir,
    loading: false,
    data: null,
    error: null,
  });
  const [selection, setSelection] = useState<Selection>({ projectDir: workingDir, runIds: [] });
  const [comparison, setComparison] = useState<ComparisonState>({ status: 'idle' });
  const [generation, setGeneration] = useState<GenerationState>({ status: 'idle' });
  const listSequence = useRef(0);
  const compareSequence = useRef(0);
  const generationSequence = useRef(0);

  const loadList = useCallback(async () => {
    if (!workingDir) return;
    const id = ++listSequence.current;
    setList((current) =>
      current.projectDir === workingDir
        ? { ...current, loading: true, error: null }
        : { projectDir: workingDir, loading: true, data: null, error: null }
    );
    let next: ListState;
    try {
      const result = await window.electron.runsCompareList(workingDir);
      next = result.ok
        ? { projectDir: workingDir, loading: false, data: result.data, error: null }
        : { projectDir: workingDir, loading: false, data: null, error: result.error };
    } catch (error) {
      next = { projectDir: workingDir, loading: false, data: null, error: ipcFailure(error) };
    }
    if (listSequence.current === id) setList(next);
  }, [workingDir]);

  // Reload whenever the tab is shown again and when the agent starts or stops, since a turn may
  // have added runs.
  useEffect(() => {
    if (active) void loadList();
  }, [active, isAgentActive, loadList]);

  // A different Project starts from scratch: runs of another Project can never be compared.
  useEffect(() => {
    compareSequence.current += 1;
    generationSequence.current += 1;
    setSelection({ projectDir: workingDir, runIds: [] });
    setComparison({ status: 'idle' });
    setGeneration({ status: 'idle' });
  }, [workingDir]);

  const currentList = list.projectDir === workingDir ? list : null;
  const runs = currentList?.data?.runs ?? [];
  const known = new Set(runs.map((run) => run.runId));
  const selected: string[] =
    selection.projectDir !== workingDir
      ? []
      : currentList?.data
        ? selection.runIds.filter((runId) => known.has(runId))
        : selection.runIds;
  // Requirement 21.4: exactly two records, both of this Project.
  const canCompare = selection.projectDir === workingDir && selected.length === 2;
  const comparing = comparison.status === 'loading';
  const generating = generation.status === 'running';

  const toggle = (runId: string) => {
    compareSequence.current += 1;
    generationSequence.current += 1;
    setSelection({
      projectDir: workingDir,
      runIds: selected.includes(runId)
        ? selected.filter((id) => id !== runId)
        : [...selected, runId],
    });
    setComparison({ status: 'idle' });
    setGeneration({ status: 'idle' });
  };

  const compare = async () => {
    if (!canCompare) return;
    const [runIdA, runIdB] = selected;
    const id = ++compareSequence.current;
    generationSequence.current += 1;
    setComparison({ status: 'loading' });
    setGeneration({ status: 'idle' });
    let next: ComparisonState;
    try {
      const result = await window.electron.runsCompare({ projectDir: workingDir, runIdA, runIdB });
      next = result.ok
        ? { status: 'ready', result: result.data }
        : { status: 'error', error: result.error };
    } catch (error) {
      next = { status: 'error', error: ipcFailure(error) };
    }
    if (compareSequence.current === id) setComparison(next);
  };

  const generate = async () => {
    if (comparison.status !== 'ready' || generating) return;
    const task = buildCompareTask(comparison.result);
    if (!sessionId) {
      onCompose(task);
      setGeneration({ status: 'composed' });
      return;
    }
    const id = ++generationSequence.current;
    setGeneration({ status: 'running' });
    let next: GenerationState;
    try {
      // Loaded on demand so the workspace panel does not pull the ACP client into its imports.
      const { sendCompareTask } = await import('../../utils/compare/sendCompareTask');
      const outcome = await sendCompareTask(sessionId, task);
      next = outcome.ok
        ? { status: 'done' }
        : { status: 'failed', reason: outcome.reason, detail: outcome.detail };
    } catch (error) {
      next = { status: 'failed', reason: 'kernelError', detail: ipcFailure(error).message };
    }
    // Requirement 21.6: the view and the selection stay; the button is enabled again.
    if (generationSequence.current === id) setGeneration(next);
  };

  const failureLabel = (failure: RunFailure) => {
    switch (failure) {
      case '非零退出码':
        return intl.formatMessage(messages.failureNonZero);
      case '超时':
        return intl.formatMessage(messages.failureTimeout);
      case '用户取消':
        return intl.formatMessage(messages.failureCancelled);
    }
    return failure;
  };

  const describeProblem = (problem: RunRecordProblem) => {
    const reasons: string[] = [];
    if (problem.parseErrorAt) {
      reasons.push(intl.formatMessage(messages.problemSyntax, problem.parseErrorAt));
    }
    if (problem.missing.length > 0) {
      reasons.push(
        intl.formatMessage(messages.problemMissing, { fields: problem.missing.join(', ') })
      );
    }
    if (problem.invalid.length > 0) {
      reasons.push(
        intl.formatMessage(messages.problemInvalid, { fields: problem.invalid.join(', ') })
      );
    }
    return intl.formatMessage(messages.problemItem, {
      path: problem.path,
      reason: reasons.join('; '),
    });
  };

  const exitCodeText = (exitCode: number | null) =>
    exitCode === null ? intl.formatMessage(messages.noExitCode) : String(exitCode);

  // Requirement 21.5: the marker sits on the side it belongs to; the rest of the view stays.
  const renderFlags = (side: RunCompareSide) => {
    if (side.flags.length === 0) return null;
    return (
      <span className="mt-1 flex flex-wrap gap-1">
        {side.flags.includes('failed') && (
          <span className="rounded border border-border-danger px-1.5 py-0.5 text-[11px] font-medium text-text-danger">
            {side.failure
              ? intl.formatMessage(messages.flagFailedReason, {
                  reason: failureLabel(side.failure),
                })
              : intl.formatMessage(messages.flagFailed)}
          </span>
        )}
        {side.flags.includes('stale') && (
          <span className="rounded border border-border-warning px-1.5 py-0.5 text-[11px] font-medium text-text-warning">
            {intl.formatMessage(messages.flagStale)}
          </span>
        )}
      </span>
    );
  };

  const summaryRows = (result: RunCompareResult) => {
    const verdict = (side: RunCompareSide) => {
      if (side.verifiedAt) {
        return intl.formatMessage(messages.verifiedAt, {
          time: formatRunTimestamp(side.verifiedAt),
        });
      }
      return result.artifactIndex === 'present'
        ? intl.formatMessage(messages.unverified)
        : intl.formatMessage(messages.verificationUnknown);
    };
    const duration = (side: RunCompareSide) => {
      const seconds = runDurationSeconds(side.record.startedAt, side.record.endedAt);
      return seconds === null ? COMPARE_MISSING : formatDuration(seconds);
    };
    const rows: Array<{ label: string; a: string; b: string; mono?: boolean }> = [
      {
        label: intl.formatMessage(messages.runId),
        a: result.a.record.runId,
        b: result.b.record.runId,
        mono: true,
      },
      {
        label: intl.formatMessage(messages.method),
        a: result.a.meta?.method ?? COMPARE_MISSING,
        b: result.b.meta?.method ?? COMPARE_MISSING,
      },
      {
        label: intl.formatMessage(messages.started),
        a: formatRunTimestamp(result.a.record.startedAt),
        b: formatRunTimestamp(result.b.record.startedAt),
      },
      {
        label: intl.formatMessage(messages.ended),
        a: formatRunTimestamp(result.a.record.endedAt),
        b: formatRunTimestamp(result.b.record.endedAt),
      },
      {
        label: intl.formatMessage(messages.duration),
        a: duration(result.a),
        b: duration(result.b),
      },
      {
        label: intl.formatMessage(messages.exitCode),
        a: exitCodeText(result.a.record.exitCode),
        b: exitCodeText(result.b.record.exitCode),
      },
      {
        label: intl.formatMessage(messages.verification),
        a: verdict(result.a),
        b: verdict(result.b),
      },
    ];
    return rows;
  };

  const renderEntryRows = (rows: CompareRow[], kind: CompareRow['kind']) => {
    const own = rows.filter((row) => row.kind === kind);
    if (own.length === 0) return null;
    return (
      <>
        <tr>
          <th
            scope="colgroup"
            colSpan={3}
            className="bg-background-secondary px-2 py-1.5 text-left font-medium"
          >
            {intl.formatMessage(kind === 'param' ? messages.params : messages.metrics)}
          </th>
        </tr>
        {own.map((row) => (
          <tr
            key={`${kind}:${row.name}`}
            className={cn(
              'border-t border-border-primary',
              row.highlight && 'bg-background-info/15'
            )}
          >
            <th scope="row" className="break-all px-2 py-1.5 text-left font-normal">
              {row.highlight && (
                <span aria-hidden="true" className="mr-1 font-semibold text-text-info">
                  ≠
                </span>
              )}
              {row.name}
              {row.highlight && (
                <span className="sr-only"> ({intl.formatMessage(messages.differs)})</span>
              )}
            </th>
            <td className={cn('break-all px-2 py-1.5', !row.a.present && 'text-text-tertiary')}>
              {row.a.text}
            </td>
            <td className={cn('break-all px-2 py-1.5', !row.b.present && 'text-text-tertiary')}>
              {row.b.text}
            </td>
          </tr>
        ))}
      </>
    );
  };

  const renderGenerationStatus = () => {
    if (generation.status === 'running') {
      return (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {intl.formatMessage(messages.generating, { seconds: COMPARE_TASK_TIMEOUT_SECONDS })}
        </p>
      );
    }
    if (generation.status === 'done' || generation.status === 'composed') {
      return (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {intl.formatMessage(generation.status === 'done' ? messages.generated : messages.composed)}
        </p>
      );
    }
    if (generation.status === 'failed') {
      return (
        <div
          role="alert"
          className="mt-2 rounded-md border border-border-danger p-2 text-xs leading-relaxed"
        >
          <p>
            {intl.formatMessage(FAILURE_MESSAGES[generation.reason], {
              seconds: COMPARE_TASK_TIMEOUT_SECONDS,
            })}
          </p>
          {generation.detail && (
            <p className="mt-1 break-all text-text-secondary">
              {intl.formatMessage(messages.errorDetail, { detail: generation.detail })}
            </p>
          )}
        </div>
      );
    }
    if (isAgentActive) {
      return (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {intl.formatMessage(messages.busy)}
        </p>
      );
    }
    return null;
  };

  const renderComparison = (result: RunCompareResult) => {
    const truncated = result.a.record.inputsTruncated || result.b.record.inputsTruncated;
    const metaProblems = [result.a, result.b].filter((side) => side.metaProblem !== null);
    return (
      <div className="mt-5">
        {/* Requirement 21.2: stays at the top of the view while it is open. */}
        {result.inputMismatch.length > 0 ? (
          <div
            role="alert"
            className="sticky top-0 z-10 mb-3 rounded-lg border border-border-warning bg-background-primary p-3 text-xs leading-relaxed"
          >
            <p className="flex items-center gap-1.5 font-medium text-text-warning">
              <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0" />
              {intl.formatMessage(messages.inputMismatch)}
            </p>
            <p className="mt-1">{intl.formatMessage(messages.inputMismatchFiles)}</p>
            <ul className="mt-1 list-disc pl-5">
              {result.inputMismatch.map((file) => (
                <li key={file} className="break-all font-mono">
                  {file}
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mb-3 flex items-center gap-1.5 text-xs text-text-secondary">
            <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0" />
            {intl.formatMessage(messages.inputsMatch)}
          </p>
        )}
        {truncated && (
          <p className="mb-2 text-xs text-text-secondary">
            {intl.formatMessage(messages.inputsTruncated)}
          </p>
        )}
        {result.artifactIndex === 'invalid' && (
          <p className="mb-2 text-xs text-text-secondary">
            {intl.formatMessage(messages.artifactIndexInvalid)}
          </p>
        )}
        {metaProblems.map((side) => (
          <p key={side.record.runId} className="mb-2 text-xs text-text-secondary">
            {intl.formatMessage(messages.metaProblem, { runId: side.record.runId })}
          </p>
        ))}

        <div className="overflow-x-auto rounded-lg border border-border-primary">
          <table className="w-full table-fixed text-xs">
            <thead className="bg-background-secondary">
              <tr>
                <th scope="col" className="w-1/4 px-2 py-2 text-left font-medium">
                  {intl.formatMessage(messages.field)}
                </th>
                <th scope="col" className="px-2 py-2 text-left align-top font-medium">
                  {intl.formatMessage(messages.runA)}
                  {renderFlags(result.a)}
                </th>
                <th scope="col" className="px-2 py-2 text-left align-top font-medium">
                  {intl.formatMessage(messages.runB)}
                  {renderFlags(result.b)}
                </th>
              </tr>
            </thead>
            <tbody>
              {summaryRows(result).map((row) => (
                <tr key={row.label} className="border-t border-border-primary">
                  <th scope="row" className="px-2 py-1.5 text-left font-normal text-text-secondary">
                    {row.label}
                  </th>
                  <td className={cn('break-all px-2 py-1.5', row.mono && 'font-mono')}>{row.a}</td>
                  <td className={cn('break-all px-2 py-1.5', row.mono && 'font-mono')}>{row.b}</td>
                </tr>
              ))}
              {renderEntryRows(result.rows, 'param')}
              {renderEntryRows(result.rows, 'metric')}
            </tbody>
          </table>
        </div>
        {result.rows.length === 0 && (
          <p className="mt-2 text-xs text-text-secondary">{intl.formatMessage(messages.noRows)}</p>
        )}

        <div className="mt-4">
          <button
            type="button"
            className={`${control} flex w-full items-center justify-center gap-1.5 border border-border-primary px-3 py-2 text-sm hover:bg-background-tertiary`}
            disabled={generating || isAgentActive}
            aria-busy={generating}
            onClick={() => void generate()}
          >
            {generating && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {intl.formatMessage(messages.generate)}
          </button>
          {renderGenerationStatus()}
        </div>
      </div>
    );
  };

  const problems = currentList?.data?.problems ?? [];

  return (
    <section
      className="flex h-full min-h-0 flex-col text-text-primary"
      aria-label={intl.formatMessage(messages.title)}
      data-testid="run-compare-panel"
    >
      <div className="border-b border-border-primary px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">
              {intl.formatMessage(messages.title)}
            </h2>
            <p className="mt-1 text-xs leading-relaxed">{intl.formatMessage(messages.subtitle)}</p>
          </div>
          <button
            type="button"
            className={`${control} shrink-0 p-2 hover:bg-background-tertiary`}
            aria-label={intl.formatMessage(messages.refresh)}
            title={intl.formatMessage(messages.refresh)}
            disabled={currentList?.loading === true}
            onClick={() => void loadList()}
          >
            <RefreshCw
              aria-hidden="true"
              className={cn(
                'h-4 w-4',
                currentList?.loading && 'animate-spin motion-reduce:animate-none'
              )}
            />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {currentList?.error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-border-danger p-3 text-sm leading-relaxed"
          >
            <p>{intl.formatMessage(messages.listFailed)}</p>
            <p className="mt-1 break-all text-xs text-text-secondary">
              {intl.formatMessage(messages.errorDetail, { detail: currentList.error.message })}
            </p>
            <button
              type="button"
              className={`${control} mt-2 px-2 py-1.5 underline`}
              disabled={currentList.loading}
              onClick={() => void loadList()}
            >
              {intl.formatMessage(messages.retry)}
            </button>
          </div>
        )}
        {currentList?.loading && !currentList.data && (
          <p role="status" className="py-4 text-sm">
            {intl.formatMessage(messages.loading)}
          </p>
        )}
        {currentList?.data && runs.length === 0 && (
          <p className="py-4 text-sm leading-relaxed">{intl.formatMessage(messages.empty)}</p>
        )}
        {problems.length > 0 && (
          <details className="mb-3 text-xs">
            <summary className="cursor-pointer text-text-secondary">
              {intl.formatMessage(messages.problems, { count: problems.length })}
            </summary>
            <ul className="mt-1 space-y-0.5 pl-4">
              {problems.map((problem) => (
                <li key={problem.path} className="break-all font-mono text-[11px]">
                  {describeProblem(problem)}
                </li>
              ))}
            </ul>
          </details>
        )}

        {runs.length > 0 && (
          <>
            <fieldset>
              <legend className="mb-2 text-xs font-medium">
                {intl.formatMessage(messages.runsLegend)}
              </legend>
              <ul className="space-y-1">
                {runs.map((run) => {
                  const position = selected.indexOf(run.runId);
                  return (
                    <li key={run.runId}>
                      <label
                        className={cn(
                          'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5',
                          position >= 0
                            ? 'border-border-primary bg-background-tertiary'
                            : 'border-transparent hover:bg-background-tertiary/60'
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={position >= 0}
                          disabled={generating || comparing}
                          onChange={() => toggle(run.runId)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block break-all font-mono text-xs">{run.runId}</span>
                          <span className="block truncate text-[11px] text-text-secondary">
                            {run.method ?? run.command}
                          </span>
                          <span className="block text-[11px] text-text-tertiary">
                            {formatRunTimestamp(run.startedAt)} ·{' '}
                            {run.exitCode === null
                              ? intl.formatMessage(messages.noExitCode)
                              : intl.formatMessage(messages.exitCodeValue, {
                                  code: String(run.exitCode),
                                })}
                          </span>
                        </span>
                        {isFailedRun(run) && (
                          <span className="shrink-0 rounded border border-border-danger px-1 text-[11px] text-text-danger">
                            {run.failure
                              ? failureLabel(run.failure)
                              : intl.formatMessage(messages.flagFailed)}
                          </span>
                        )}
                        {selected.length === 2 && position >= 0 && (
                          <span className="shrink-0 rounded bg-text-primary px-1.5 text-[11px] font-medium text-background-primary">
                            {position === 0 ? 'A' : 'B'}
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </fieldset>

            <div className="mt-3">
              {!canCompare && (
                <p id={hintId} className="mb-2 text-xs leading-relaxed text-text-secondary">
                  {intl.formatMessage(messages.selectHint)}{' '}
                  {intl.formatMessage(messages.selectedCount, { count: selected.length })}
                </p>
              )}
              <button
                type="button"
                className={`${control} flex w-full items-center justify-center gap-1.5 bg-text-primary px-3 py-2 text-sm text-background-primary`}
                disabled={!canCompare || comparing || generating}
                aria-describedby={canCompare ? undefined : hintId}
                onClick={() => void compare()}
              >
                {comparing && (
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  />
                )}
                {intl.formatMessage(comparing ? messages.comparing : messages.compare)}
              </button>
            </div>
          </>
        )}

        {comparison.status === 'error' && (
          <div
            role="alert"
            className="mt-4 rounded-lg border border-border-danger p-3 text-sm leading-relaxed"
          >
            <p>{intl.formatMessage(messages.compareFailed)}</p>
            <p className="mt-1 break-all text-xs text-text-secondary">
              {intl.formatMessage(messages.errorDetail, { detail: comparison.error.message })}
            </p>
          </div>
        )}
        {comparison.status === 'ready' && renderComparison(comparison.result)}
      </div>
    </section>
  );
}

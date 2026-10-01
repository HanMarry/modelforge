import { useEffect, useState } from 'react';
import { AlertTriangle, ShieldCheck, X } from 'lucide-react';
import type { MessageDescriptor } from 'react-intl';
import { defineMessages, useIntl } from '../../i18n';
import type {
  ArtifactEntry,
  ArtifactIndex,
  StaleReasonKind,
  VerifyRejectReason,
} from '../../types/artifactStatus';
import type { RunFailure } from '../../types/runRecord';
import type { ArtifactFileCheck, ArtifactFileState, ArtifactInspection } from '../../types/runsApi';
import { SEED_UNSET } from '../../utils/runRecord';
import { ARTIFACT_STATUS_LABELS } from './ArtifactStatusBadge';

const messages = defineMessages({
  title: { id: 'runs.detailsTitle', defaultMessage: 'Result details' },
  close: { id: 'runs.close', defaultMessage: 'Close' },
  status: { id: 'runs.status', defaultMessage: 'Status' },
  loading: { id: 'runs.loading', defaultMessage: 'Loading the run record…' },
  loadFailed: {
    id: 'runs.loadFailed',
    defaultMessage: 'Could not load the run record. Close this and try again.',
  },
  noRecord: { id: 'runs.noRecord', defaultMessage: 'No run record' },
  modifiedOutside: {
    id: 'runs.modifiedOutside',
    defaultMessage: 'This file was changed outside ModelForge after the run that produced it.',
  },
  reasonsTitle: { id: 'runs.reasonsTitle', defaultMessage: 'Why it is out of date' },
  reasonInputChanged: { id: 'runs.reasonInputChanged', defaultMessage: 'Input changed: {path}' },
  reasonCodeChanged: { id: 'runs.reasonCodeChanged', defaultMessage: 'Code changed: {path}' },
  reasonOutputModified: {
    id: 'runs.reasonOutputModified',
    defaultMessage: 'Changed outside ModelForge: {path}',
  },
  reasonMissing: { id: 'runs.reasonMissing', defaultMessage: 'Missing: {path}' },
  reasonUnreadable: { id: 'runs.reasonUnreadable', defaultMessage: 'Cannot be read: {path}' },
  reasonRecordMissing: {
    id: 'runs.reasonRecordMissing',
    defaultMessage: 'Run record missing or unreadable: {path}',
  },
  runId: { id: 'runs.runId', defaultMessage: 'Run ID' },
  command: { id: 'runs.command', defaultMessage: 'Command' },
  exitCode: { id: 'runs.exitCode', defaultMessage: 'Exit code' },
  exitCodeNone: { id: 'runs.exitCodeNone', defaultMessage: 'None' },
  failure: { id: 'runs.failure', defaultMessage: 'Failure' },
  failureNonZero: { id: 'runs.failureNonZero', defaultMessage: 'Non-zero exit code' },
  failureTimeout: { id: 'runs.failureTimeout', defaultMessage: 'Timed out' },
  failureCancelled: { id: 'runs.failureCancelled', defaultMessage: 'Cancelled by the user' },
  startedAt: { id: 'runs.startedAt', defaultMessage: 'Started' },
  endedAt: { id: 'runs.endedAt', defaultMessage: 'Ended' },
  seed: { id: 'runs.seed', defaultMessage: 'Random seed' },
  seedUnset: { id: 'runs.seedUnset', defaultMessage: 'Not set' },
  code: { id: 'runs.code', defaultMessage: 'Code' },
  inputs: { id: 'runs.inputs', defaultMessage: 'Inputs' },
  noInputs: { id: 'runs.noInputs', defaultMessage: 'No input files recorded' },
  thisFile: { id: 'runs.thisFile', defaultMessage: 'This file' },
  recordedHash: { id: 'runs.recordedHash', defaultMessage: 'Recorded SHA-256: {hash}' },
  fileMatch: { id: 'runs.fileMatch', defaultMessage: 'Matches the record' },
  fileChanged: { id: 'runs.fileChanged', defaultMessage: 'Changed since the run' },
  fileMissing: { id: 'runs.fileMissing', defaultMessage: 'Missing' },
  fileUnreadable: { id: 'runs.fileUnreadable', defaultMessage: 'Cannot be read' },
  fileUnrecorded: { id: 'runs.fileUnrecorded', defaultMessage: 'No recorded hash' },
  verifiedAt: {
    id: 'runs.verifiedAt',
    defaultMessage: 'Verified at {time} against run {runId}',
  },
  markVerified: { id: 'runs.markVerified', defaultMessage: 'Mark as verified' },
  verifyFailed: {
    id: 'runs.verifyFailed',
    defaultMessage: 'Could not save the verification. Try again.',
  },
  rejectNotTracked: {
    id: 'runs.rejectNotTracked',
    defaultMessage: 'Not marked: this file is not tracked as a result yet.',
  },
  rejectNotGenerated: {
    id: 'runs.rejectNotGenerated',
    defaultMessage: 'Not marked: only a result with the status Generated can be verified. This one is {status}.',
  },
  rejectRecordMissing: {
    id: 'runs.rejectRecordMissing',
    defaultMessage: 'Not marked: the run record of this result is missing or cannot be read.',
  },
  rejectRunFailed: {
    id: 'runs.rejectRunFailed',
    defaultMessage: 'Not marked: the run that produced this result did not exit with code 0.',
  },
});

const REASON_MESSAGES: Record<StaleReasonKind, MessageDescriptor> = {
  'input-changed': messages.reasonInputChanged,
  'code-changed': messages.reasonCodeChanged,
  'output-modified': messages.reasonOutputModified,
  missing: messages.reasonMissing,
  unreadable: messages.reasonUnreadable,
  'record-missing': messages.reasonRecordMissing,
};

const FILE_STATE_MESSAGES: Record<ArtifactFileState, MessageDescriptor> = {
  match: messages.fileMatch,
  changed: messages.fileChanged,
  missing: messages.fileMissing,
  unreadable: messages.fileUnreadable,
  unrecorded: messages.fileUnrecorded,
};

const FAILURE_MESSAGES: Record<RunFailure, MessageDescriptor> = {
  '非零退出码': messages.failureNonZero,
  '超时': messages.failureTimeout,
  '用户取消': messages.failureCancelled,
};

const REJECT_MESSAGES: Record<VerifyRejectReason, MessageDescriptor> = {
  'not-tracked': messages.rejectNotTracked,
  'not-generated': messages.rejectNotGenerated,
  'run-record-missing': messages.rejectRecordMissing,
  'run-failed': messages.rejectRunFailed,
};

const control =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info transition-colors motion-reduce:transition-none disabled:cursor-wait disabled:opacity-50';

/** Whether the Artifact itself no longer matches its recorded output hash (requirement 17.4). */
export function isModifiedOutside(entry: ArtifactEntry | null | undefined): boolean {
  return (
    !!entry &&
    entry.status === '已过期' &&
    entry.staleReasons.some(
      (reason) => reason.kind === 'output-modified' && reason.path === entry.path
    )
  );
}

interface ArtifactDetailsDialogProps {
  workingDir: string;
  /** Project-relative path of the selected Artifact. */
  path: string;
  /** Its entry in the Project's index, if any; a new entry reloads the details. */
  entry: ArtifactEntry | null;
  onClose: () => void;
  /** Receives the index after a successful "标记已验证". */
  onIndexChange: (index: ArtifactIndex) => void;
}

function FileCheckRow({ check, label }: { check: ArtifactFileCheck; label: string }) {
  const intl = useIntl();
  const matches = check.state === 'match';
  return (
    <li className="py-1.5">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-all font-mono text-xs">
          <span className="sr-only">{label}: </span>
          <span>{check.path}</span>
        </span>
        <span className={`shrink-0 text-xs ${matches ? '' : 'text-text-danger'}`}>
          {intl.formatMessage(FILE_STATE_MESSAGES[check.state])}
        </span>
      </div>
      {check.recorded && (
        <p className="mt-0.5 break-all font-mono text-[11px] text-text-secondary">
          {intl.formatMessage(messages.recordedHash, { hash: check.recorded })}
        </p>
      )}
    </li>
  );
}

/**
 * The details of one Artifact (requirements 16.7, 17.2, 17.4, 17.5, 17.7, 17.8): its status and
 * why it is out of date, the Run_Record that produced it with the current state of its code and
 * inputs, the verification, and "标记已验证" with the reason when that is refused.
 */
export default function ArtifactDetailsDialog({
  workingDir,
  path,
  entry,
  onClose,
  onIndexChange,
}: ArtifactDetailsDialogProps) {
  const intl = useIntl();
  const [inspection, setInspection] = useState<ArtifactInspection | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [rejected, setRejected] = useState<VerifyRejectReason | null>(null);
  const [verifyFailed, setVerifyFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    window.electron
      .artifactsInspect(workingDir, path)
      .then((result) => {
        if (cancelled) return;
        if (result.ok) {
          setInspection(result.data);
        } else {
          setLoadFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [workingDir, path, entry]);

  const current = inspection?.path === path ? inspection : null;
  // The panel's index is pushed on every change, so it is the newer of the two.
  const shown = entry ?? current?.entry ?? null;
  const record = current?.record ?? null;
  const code = current?.files.find((file) => file.role === 'code') ?? null;
  const inputs = current?.files.filter((file) => file.role === 'input') ?? [];
  const artifact = current?.files.find((file) => file.role === 'artifact') ?? null;
  const statusLabel = shown ? intl.formatMessage(ARTIFACT_STATUS_LABELS[shown.status]) : null;

  const verify = async () => {
    setVerifying(true);
    setRejected(null);
    setVerifyFailed(false);
    try {
      const result = await window.electron.artifactsVerify(workingDir, path);
      if (!result.ok) {
        setVerifyFailed(true);
        return;
      }
      // Verification runs a detection pass first, so the index is current either way.
      const outcome = result.data;
      onIndexChange(outcome.index);
      if (!outcome.ok) {
        setRejected(outcome.reason);
      }
    } catch {
      setVerifyFailed(true);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={intl.formatMessage(messages.title)}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-6"
    >
      <div className="flex max-h-full w-full max-w-md flex-col rounded-xl border border-border-secondary bg-background-primary">
        <div className="flex items-center justify-between border-b border-border-secondary px-4 py-3">
          <h2 className="text-sm font-semibold text-text-primary">
            {intl.formatMessage(messages.title)}
          </h2>
          <button
            type="button"
            aria-label={intl.formatMessage(messages.close)}
            className={`${control} p-1 text-text-tertiary hover:text-text-primary`}
            onClick={onClose}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-text-primary">
          <div>
            <p className="break-all font-mono text-xs">{path}</p>
            {statusLabel && (
              <p className="mt-1 text-xs">
                {intl.formatMessage(messages.status)}: {statusLabel}
              </p>
            )}
          </div>

          {isModifiedOutside(shown) && (
            <p className="flex items-start gap-2 rounded-md border border-border-danger px-3 py-2 text-xs text-text-danger">
              <AlertTriangle aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {intl.formatMessage(messages.modifiedOutside)}
            </p>
          )}

          {shown && shown.staleReasons.length > 0 && (
            <section>
              <h3 className="text-xs font-medium">{intl.formatMessage(messages.reasonsTitle)}</h3>
              <ul className="mt-1 space-y-1">
                {shown.staleReasons.map((reason) => (
                  <li
                    key={`${reason.kind}:${reason.path}`}
                    className="break-all text-xs text-text-danger"
                  >
                    {intl.formatMessage(REASON_MESSAGES[reason.kind], { path: reason.path })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {loadFailed && (
            <p role="alert" className="text-xs text-text-danger">
              {intl.formatMessage(messages.loadFailed)}
            </p>
          )}
          {!current && !loadFailed && (
            <p role="status" className="text-xs">
              {intl.formatMessage(messages.loading)}
            </p>
          )}
          {current && !record && (
            <p className="rounded-md border border-border-primary px-3 py-2 text-xs">
              {intl.formatMessage(messages.noRecord)}
            </p>
          )}

          {record && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
              <dt className="text-text-secondary">{intl.formatMessage(messages.runId)}</dt>
              <dd className="break-all font-mono">{record.runId}</dd>
              <dt className="text-text-secondary">{intl.formatMessage(messages.command)}</dt>
              <dd className="break-all font-mono">{record.command}</dd>
              <dt className="text-text-secondary">{intl.formatMessage(messages.exitCode)}</dt>
              <dd className="font-mono">
                {record.exitCode === null
                  ? intl.formatMessage(messages.exitCodeNone)
                  : String(record.exitCode)}
              </dd>
              {record.failure && (
                <>
                  <dt className="text-text-secondary">{intl.formatMessage(messages.failure)}</dt>
                  <dd>{intl.formatMessage(FAILURE_MESSAGES[record.failure])}</dd>
                </>
              )}
              <dt className="text-text-secondary">{intl.formatMessage(messages.startedAt)}</dt>
              <dd className="font-mono">{record.startedAt}</dd>
              <dt className="text-text-secondary">{intl.formatMessage(messages.endedAt)}</dt>
              <dd className="font-mono">{record.endedAt}</dd>
              <dt className="text-text-secondary">{intl.formatMessage(messages.seed)}</dt>
              <dd className="break-all font-mono">
                {record.seed === SEED_UNSET ? intl.formatMessage(messages.seedUnset) : record.seed}
              </dd>
            </dl>
          )}

          {record && (
            <section>
              <h3 className="text-xs font-medium">{intl.formatMessage(messages.code)}</h3>
              <ul>
                {code ? (
                  <FileCheckRow check={code} label={intl.formatMessage(messages.code)} />
                ) : (
                  <li className="py-1.5 text-xs">{intl.formatMessage(messages.thisFile)}</li>
                )}
              </ul>
              <h3 className="mt-2 text-xs font-medium">{intl.formatMessage(messages.inputs)}</h3>
              {inputs.length === 0 ? (
                <p className="py-1.5 text-xs">{intl.formatMessage(messages.noInputs)}</p>
              ) : (
                <ul>
                  {inputs.map((input) => (
                    <FileCheckRow
                      key={input.path}
                      check={input}
                      label={intl.formatMessage(messages.inputs)}
                    />
                  ))}
                </ul>
              )}
              {artifact && (
                <>
                  <h3 className="mt-2 text-xs font-medium">
                    {intl.formatMessage(messages.thisFile)}
                  </h3>
                  <ul>
                    <FileCheckRow check={artifact} label={intl.formatMessage(messages.thisFile)} />
                  </ul>
                </>
              )}
            </section>
          )}

          {shown?.verification && (
            <p className="flex items-center gap-2 text-xs">
              <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              {intl.formatMessage(messages.verifiedAt, {
                time: shown.verification.verifiedAt,
                runId: shown.verification.runId,
              })}
            </p>
          )}

          {rejected && (
            <p role="alert" className="text-xs text-text-danger">
              {intl.formatMessage(REJECT_MESSAGES[rejected], { status: statusLabel ?? '' })}
            </p>
          )}
          {verifyFailed && (
            <p role="alert" className="text-xs text-text-danger">
              {intl.formatMessage(messages.verifyFailed)}
            </p>
          )}
        </div>
        {shown?.status !== '已验证' && (
          <div className="border-t border-border-secondary px-4 py-3">
            <button
              type="button"
              className={`${control} inline-flex items-center gap-1.5 bg-text-primary px-3 py-2 text-xs text-background-primary`}
              disabled={verifying}
              onClick={() => void verify()}
            >
              <ShieldCheck aria-hidden="true" className="h-3.5 w-3.5" />
              {intl.formatMessage(messages.markVerified)}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

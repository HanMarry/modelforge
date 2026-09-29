import type { IntlShape } from 'react-intl';
import type { StepStaleReason, TaskPlan } from '../../types/taskPlan';
import { taskResumeMessages as i18n } from './messages';

const SIZE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte'] as const;

/** `2.4 MB`, in the user's locale. */
export function formatSize(intl: IntlShape, bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return intl.formatNumber(value, {
    style: 'unit',
    unit: SIZE_UNITS[unit],
    unitDisplay: 'short',
    maximumFractionDigits: unit === 0 ? 0 : 1,
  });
}

/** A Run_Record or file timestamp in the user's locale; unparsable values are shown as they are. */
export function formatTime(intl: IntlShape, iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) {
    return iso;
  }
  return intl.formatDate(time, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Last segment of a Project path, for either separator. */
export function baseName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? dir;
}

/** The step's title, or its id when the title is empty or the step is unknown. */
export function stepLabel(plan: TaskPlan, stepId: string | null): string {
  if (stepId === null) {
    return '';
  }
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  return step && step.title.length > 0 ? step.title : stepId;
}

/**
 * One reason of requirement 22.5 in the words the prompt uses: 记录缺失 (record-missing,
 * record-truncated), 哈希不一致 and 文件缺失, plus the non-zero exit code of 22.2.
 */
export function describeStaleReason(intl: IntlShape, reason: StepStaleReason): string {
  switch (reason.kind) {
    case 'record-missing':
      return reason.runId === null
        ? intl.formatMessage(i18n.reasonNoRun)
        : intl.formatMessage(i18n.reasonRecordMissing, { runId: reason.runId });
    case 'record-truncated':
      return intl.formatMessage(i18n.reasonRecordTruncated, { runId: reason.runId });
    case 'run-failed':
      return intl.formatMessage(i18n.reasonRunFailed, { runId: reason.runId });
    case 'hash-mismatch':
      return intl.formatMessage(i18n.reasonHashMismatch, { path: reason.path });
    case 'file-missing':
      return intl.formatMessage(i18n.reasonFileMissing, { path: reason.path });
  }
}

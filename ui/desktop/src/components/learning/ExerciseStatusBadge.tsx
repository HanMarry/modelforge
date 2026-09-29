import { defineMessages, useIntl } from '../../i18n';
import { cn } from '../../utils';
import type { ExerciseRecord, ExerciseStatus } from '../../utils/learning/progress';

const i18n = defineMessages({
  notStarted: { id: 'learning.status.notStarted', defaultMessage: 'Not started' },
  failed: { id: 'learning.status.failed', defaultMessage: 'Not passed' },
  completed: { id: 'learning.status.completed', defaultMessage: 'Completed' },
  solutionViewed: { id: 'learning.status.solutionViewed', defaultMessage: 'Solution viewed' },
});

const STATUS_MESSAGE: Record<ExerciseStatus, typeof i18n.notStarted> = {
  未开始: i18n.notStarted,
  未通过: i18n.failed,
  已完成: i18n.completed,
};

const STATUS_CLASS: Record<ExerciseStatus, string> = {
  未开始: 'bg-background-secondary text-text-secondary',
  未通过: 'bg-red-500/10 text-red-600 dark:text-red-400',
  已完成: 'bg-green-500/10 text-green-700 dark:text-green-400',
};

/** Status of an exercise record, plus the "已查看解答" mark (requirement 20.7). */
export function ExerciseStatusBadge({ record }: { record: ExerciseRecord | undefined }) {
  const intl = useIntl();
  const status = record?.status ?? '未开始';
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <span className={cn('rounded px-1.5 py-0.5 text-[11px]', STATUS_CLASS[status])}>
        {intl.formatMessage(STATUS_MESSAGE[status])}
      </span>
      {record?.solutionViewed && (
        <span className="rounded bg-yellow-500/10 px-1.5 py-0.5 text-[11px] text-yellow-700 dark:text-yellow-400">
          {intl.formatMessage(i18n.solutionViewed)}
        </span>
      )}
    </span>
  );
}

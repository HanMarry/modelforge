import { defineMessages, useIntl } from '../../i18n';
import type { LearningCatalog } from '../../types/learningApi';
import { progressByGroup, type ExerciseRecord } from '../../utils/learning/progress';

const i18n = defineMessages({
  title: { id: 'learning.progress.title', defaultMessage: 'Progress by course group' },
  hint: {
    id: 'learning.progress.hint',
    defaultMessage: 'An exercise counts once every check item has passed.',
  },
  count: { id: 'learning.progress.count', defaultMessage: '{completed} / {total}' },
  percent: { id: 'learning.progress.percent', defaultMessage: '{percent}%' },
});

/** The profile page (requirement 20.4): completed / total exercises and the rounded percentage. */
export default function LearningProgressPanel({
  catalog,
  records,
}: {
  catalog: LearningCatalog;
  records: readonly ExerciseRecord[];
}) {
  const intl = useIntl();
  const groups = progressByGroup(records, catalog);

  return (
    <section className="max-w-2xl px-6 py-5">
      <h2 className="text-sm font-medium text-text-primary">{intl.formatMessage(i18n.title)}</h2>
      <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.hint)}</p>
      <ul className="mt-4 space-y-3">
        {groups.map((group) => {
          const labelId = `learning-progress-${group.groupId}`;
          return (
            <li key={group.groupId} className="rounded-lg border border-border-secondary px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span id={labelId} className="text-sm text-text-primary">
                  {group.title}
                </span>
                <span className="text-xs text-text-secondary">
                  {intl.formatMessage(i18n.count, {
                    completed: group.completed,
                    total: group.total,
                  })}
                  <span className="ml-2 font-medium text-text-primary">
                    {intl.formatMessage(i18n.percent, { percent: group.percent })}
                  </span>
                </span>
              </div>
              <div
                role="progressbar"
                aria-labelledby={labelId}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={group.percent}
                className="mt-2 h-1.5 overflow-hidden rounded-full bg-background-secondary"
              >
                <div
                  className="h-full rounded-full bg-text-primary"
                  style={{ width: `${group.percent}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

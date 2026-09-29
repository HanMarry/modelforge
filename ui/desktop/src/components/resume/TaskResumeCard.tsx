import { useId } from 'react';
import { Check, Circle, X } from 'lucide-react';
import { useIntl } from '../../i18n';
import type { ResumePlan } from '../../types/taskPlan';
import type { ResumableTask, TaskRunSummary } from '../../types/taskResumeApi';
import { cn } from '../../utils';
import { taskResumeMessages as i18n } from './messages';
import { baseName, describeStaleReason, formatTime, stepLabel } from './resumeFormat';

/** Reasons listed per plan before the rest is summed up. */
const MAX_LISTED_REASONS = 8;

/** Where a task is in "从失败点继续": nothing yet, checking hashes, plan shown, starting. */
export type TaskResumePhase = 'idle' | 'checking' | 'planned' | 'starting';

interface TaskResumeCardProps {
  task: ResumableTask;
  phase: TaskResumePhase;
  /** The plan `task-resume-continue` returned, once `phase` is `planned` or `starting`. */
  plan: ResumePlan | null;
  /** Another task is being resumed; this one waits. */
  disabled: boolean;
  onContinue: () => void;
  onDismiss: () => void;
  onStart: (plan: ResumePlan) => void;
  onBack: () => void;
}

function RunLine({ run }: { run: TaskRunSummary }) {
  const intl = useIntl();
  let detail: string;
  if (!run.recorded) {
    detail = intl.formatMessage(i18n.runMissing);
  } else {
    const times = intl.formatMessage(i18n.runTimes, {
      start: formatTime(intl, run.startedAt ?? ''),
      end: formatTime(intl, run.endedAt ?? ''),
    });
    const outcome =
      run.exitCode !== null
        ? intl.formatMessage(i18n.runExitCode, { code: String(run.exitCode) })
        : intl.formatMessage(i18n.runFailure, { failure: run.failure ?? '' });
    detail = `${times} · ${outcome}`;
  }
  return (
    <li className="text-xs text-text-secondary">
      <span className="font-mono text-text-primary">{run.runId}</span>
      {' · '}
      {detail}
    </li>
  );
}

export default function TaskResumeCard({
  task,
  phase,
  plan,
  disabled,
  onContinue,
  onDismiss,
  onStart,
  onBack,
}: TaskResumeCardProps) {
  const intl = useIntl();
  const headingId = useId();
  const failedIndex = task.steps.findIndex((step) => step.id === task.failedStep);
  const busy = phase === 'checking' || phase === 'starting';

  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-border-secondary px-3 py-2.5"
    >
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="truncate text-sm font-medium text-text-primary">
            {task.plan.title || task.plan.taskId}
          </h3>
          <p className="truncate text-xs text-text-secondary" title={task.projectDir}>
            {intl.formatMessage(i18n.project, { name: baseName(task.projectDir) })}
          </p>
        </div>
        <span className="flex-shrink-0 rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">
          {intl.formatMessage(
            task.plan.status === '已暂停' ? i18n.statusPaused : i18n.statusInterrupted
          )}
        </span>
        {task.plan.dismissed && (
          <span className="flex-shrink-0 rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
            {intl.formatMessage(i18n.dismissedBadge)}
          </span>
        )}
      </header>

      <ol className="mt-2 space-y-1.5">
        {task.steps.map((step, index) => {
          const failed = index === failedIndex;
          const state = step.completed
            ? i18n.stepCompleted
            : failed
              ? i18n.stepFailed
              : i18n.stepNotReached;
          const Icon = step.completed ? Check : failed ? X : Circle;
          return (
            <li key={step.id}>
              <div className="flex items-center gap-1.5 text-sm">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    'h-3.5 w-3.5 flex-shrink-0',
                    step.completed
                      ? 'text-text-success'
                      : failed
                        ? 'text-text-danger'
                        : 'text-text-tertiary'
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-text-primary">
                  {step.title || step.id}
                </span>
                <span
                  className={cn(
                    'flex-shrink-0 text-xs',
                    failed ? 'text-text-danger' : 'text-text-secondary'
                  )}
                >
                  {intl.formatMessage(state)}
                </span>
              </div>
              <ul className="ml-5 mt-0.5 space-y-0.5">
                {step.runs.length === 0 ? (
                  <li className="text-xs text-text-tertiary">{intl.formatMessage(i18n.noRuns)}</li>
                ) : (
                  step.runs.map((run) => <RunLine key={run.runId} run={run} />)
                )}
              </ul>
            </li>
          );
        })}
      </ol>

      {phase === 'checking' && (
        <p role="status" className="mt-2 text-xs text-text-secondary">
          {intl.formatMessage(i18n.checking)}
        </p>
      )}

      {plan && (phase === 'planned' || phase === 'starting') && (
        <div role="status" className="mt-2 space-y-1 rounded-lg bg-background-secondary px-3 py-2">
          {plan.resumeFrom === null ? (
            <p className="text-xs text-text-primary">{intl.formatMessage(i18n.planNothing)}</p>
          ) : (
            <>
              <p className="text-xs text-text-secondary">
                {plan.skip.length > 0
                  ? intl.formatMessage(i18n.planSkip, {
                      steps: plan.skip.map((id) => stepLabel(task.plan, id)).join(', '),
                    })
                  : intl.formatMessage(i18n.planSkipNone)}
              </p>
              <p className="text-xs text-text-primary">
                {intl.formatMessage(i18n.planFrom, {
                  step: stepLabel(task.plan, plan.resumeFrom),
                })}
              </p>
              {plan.staleReasons.length > 0 && (
                <div className="text-xs text-text-secondary">
                  <p>{intl.formatMessage(i18n.planReasons)}</p>
                  <ul className="ml-4 list-disc">
                    {plan.staleReasons.slice(0, MAX_LISTED_REASONS).map((reason, index) => (
                      <li key={index} className="break-all">
                        {describeStaleReason(intl, reason)}
                      </li>
                    ))}
                    {plan.staleReasons.length > MAX_LISTED_REASONS && (
                      <li>
                        {intl.formatMessage(i18n.moreReasons, {
                          count: plan.staleReasons.length - MAX_LISTED_REASONS,
                        })}
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-2.5 flex justify-end gap-2">
        {plan && (phase === 'planned' || phase === 'starting') ? (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={onBack}
              className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-background-tertiary disabled:opacity-50"
            >
              {intl.formatMessage(i18n.back)}
            </button>
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => onStart(plan)}
              className="rounded bg-background-info px-3 py-1 text-sm text-text-inverse hover:opacity-90 disabled:opacity-50"
            >
              {intl.formatMessage(plan.resumeFrom === null ? i18n.markCompleted : i18n.start)}
            </button>
          </>
        ) : (
          <>
            {!task.plan.dismissed && (
              <button
                type="button"
                disabled={busy || disabled}
                onClick={onDismiss}
                className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-background-tertiary disabled:opacity-50"
              >
                {intl.formatMessage(i18n.dismiss)}
              </button>
            )}
            <button
              type="button"
              disabled={busy || disabled}
              onClick={onContinue}
              className="rounded bg-background-info px-3 py-1 text-sm text-text-inverse hover:opacity-90 disabled:opacity-50"
            >
              {intl.formatMessage(i18n.continue)}
            </button>
          </>
        )}
      </div>
    </section>
  );
}

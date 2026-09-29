/**
 * App-level prompt for interrupted tasks (requirement 22, tasks 25.4, 25.5), mounted once in
 * `App.tsx` inside the router and outside the routes.
 *
 * - Right after startup it scans the Projects that are open (this window's working directory and
 *   the recent directories) through `task-resume-list` and opens when a task that was not
 *   dismissed is unfinished (22.1). Each task lists its steps with their Run_Records (run id,
 *   start and end time, exit code), the completed steps and the failure point.
 * - "从失败点继续" asks the main process for `planResume` on the current files, shows which steps
 *   are skipped, where the task starts again and why (22.2, 22.5), and on "开始" opens a new
 *   session in the Project and sends the plan to the Kernel (`_goose/unstable/tasks/resume`),
 *   which runs the task in that session. With nothing left to run the task is marked completed.
 * - "放弃恢复" writes `dismissed: true`; the task is not prompted again but stays reachable from
 *   the "未完成的任务" button, which opens the same list with dismissed tasks included (22.6).
 * - While mounted it answers the Kernel's `tasks/confirm-overwrite` with a dialog listing the
 *   files, their sizes and modification times (22.3); anything but "覆盖并继续" cancels.
 *
 * Other views can open the list with `window.dispatchEvent(new CustomEvent(OPEN_TASK_RESUME_EVENT))`.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { History, X } from 'lucide-react';
import type {
  ConfirmOverwriteRequest_unstable,
  ConfirmOverwriteResponse_unstable,
} from '@aaif/goose-acp-client';
import { setOverwriteConfirmHandler } from '../../acp/overwriteConfirm';
import { resumeTask, resumeTaskErrorCode } from '../../acp/taskResume';
import { AppEvents } from '../../constants/events';
import { useNavigation } from '../../hooks/useNavigation';
import { useIntl } from '../../i18n';
import { createSession } from '../../sessions';
import { toastError, toastSuccess } from '../../toasts';
import type { ResumePlan } from '../../types/taskPlan';
import type { ResumableTask, TaskResumeTarget } from '../../types/taskResumeApi';
import { errorMessage } from '../../utils/conversionUtils';
import { getInitialWorkingDir } from '../../utils/workingDir';
import { useConfig } from '../ConfigContext';
import { taskResumeMessages as i18n } from './messages';
import OverwriteConfirmDialog, { type OverwriteAnswer } from './OverwriteConfirmDialog';
import { stepLabel } from './resumeFormat';
import TaskResumeCard, { type TaskResumePhase } from './TaskResumeCard';

/** Opens the list of unfinished tasks, dismissed ones included (the task detail of 22.6). */
export const OPEN_TASK_RESUME_EVENT = 'modelforge:open-task-resume';

interface ActiveResume {
  key: string;
  phase: TaskResumePhase;
  plan: ResumePlan | null;
}

interface PendingOverwrite {
  request: ConfirmOverwriteRequest_unstable;
  resolve: (response: ConfirmOverwriteResponse_unstable) => void;
}

function taskKey(task: ResumableTask): string {
  return `${task.projectDir}\n${task.plan.taskId}`;
}

function targetOf(task: ResumableTask): TaskResumeTarget {
  return { projectDir: task.projectDir, taskId: task.plan.taskId };
}

/** This window's Project and the recently opened ones, each once. */
async function openProjectDirs(): Promise<string[]> {
  const dirs: string[] = [getInitialWorkingDir()];
  try {
    dirs.push(...(await window.electron.listRecentDirs()));
  } catch {
    // Without the recent directories only this window's Project is scanned.
  }
  return [...new Set(dirs.filter((dir) => typeof dir === 'string' && dir.length > 0))];
}

async function scanUnfinishedTasks(): Promise<ResumableTask[]> {
  const projectDirs = await openProjectDirs();
  if (projectDirs.length === 0) {
    return [];
  }
  const result = await window.electron.taskResumeList({ projectDirs, includeDismissed: true });
  if (!result.ok) {
    console.warn('[task-resume] could not scan for unfinished tasks:', result.error);
    return [];
  }
  return result.data;
}

export default function TaskResumePrompt() {
  const intl = useIntl();
  const setView = useNavigation();
  const { extensionsList } = useConfig();
  const titleId = useId();
  const [tasks, setTasks] = useState<ResumableTask[]>([]);
  const [open, setOpen] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [active, setActive] = useState<ActiveResume | null>(null);
  const [overwrite, setOverwrite] = useState<ConfirmOverwriteRequest_unstable | null>(null);
  const pendingOverwrite = useRef<PendingOverwrite | null>(null);
  // Tasks resumed from this window run in their session; they are not offered again here.
  const resumedKeys = useRef<Set<string>>(new Set());

  const keepOffered = useCallback(
    (found: ResumableTask[]) => found.filter((task) => !resumedKeys.current.has(taskKey(task))),
    []
  );

  // Startup scan (22.1).
  useEffect(() => {
    let cancelled = false;
    scanUnfinishedTasks()
      .then((found) => {
        if (cancelled) {
          return;
        }
        const offered = keepOffered(found);
        setTasks(offered);
        if (offered.some((task) => !task.plan.dismissed)) {
          setShowDismissed(false);
          setOpen(true);
        }
      })
      .catch((error) => console.warn('[task-resume] startup scan failed:', error));
    return () => {
      cancelled = true;
    };
  }, [keepOffered]);

  const refresh = useCallback(async () => {
    try {
      setTasks(keepOffered(await scanUnfinishedTasks()));
    } catch (error) {
      console.warn('[task-resume] rescan failed:', error);
    }
  }, [keepOffered]);

  const openDetail = useCallback(() => {
    setShowDismissed(true);
    setOpen(true);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    window.addEventListener(OPEN_TASK_RESUME_EVENT, openDetail);
    return () => window.removeEventListener(OPEN_TASK_RESUME_EVENT, openDetail);
  }, [openDetail]);

  // Overwrite confirmation for the Kernel (22.3); a newer question cancels an older one.
  useEffect(() => {
    const restore = setOverwriteConfirmHandler(
      (request) =>
        new Promise<ConfirmOverwriteResponse_unstable>((resolve) => {
          pendingOverwrite.current?.resolve({ action: 'cancel' });
          pendingOverwrite.current = { request, resolve };
          setOverwrite(request);
        })
    );
    return () => {
      restore();
      pendingOverwrite.current?.resolve({ action: 'cancel' });
      pendingOverwrite.current = null;
    };
  }, []);

  const answerOverwrite = useCallback((answer: OverwriteAnswer) => {
    pendingOverwrite.current?.resolve({ action: answer });
    pendingOverwrite.current = null;
    setOverwrite(null);
  }, []);

  const visibleTasks = useMemo(
    () => (showDismissed ? tasks : tasks.filter((task) => !task.plan.dismissed)),
    [tasks, showDismissed]
  );

  const failureMessage = (error: unknown): string => {
    switch (resumeTaskErrorCode(error)) {
      case 'STALE_RESUME_PLAN':
        return intl.formatMessage(i18n.errorStalePlan);
      case 'SESSION_BUSY':
        return intl.formatMessage(i18n.errorSessionBusy);
      default:
        return errorMessage(error, intl.formatMessage(i18n.failed));
    }
  };

  const showFailure = (title: string, error: unknown) => {
    toastError({ title, msg: errorMessage(error, title) });
  };

  const checkTask = async (task: ResumableTask) => {
    const key = taskKey(task);
    setActive({ key, phase: 'checking', plan: null });
    let plan: ResumePlan;
    try {
      const result = await window.electron.taskResumeContinue(targetOf(task));
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      plan = result.data;
    } catch (error) {
      setActive(null);
      showFailure(intl.formatMessage(i18n.failed), error);
      return;
    }
    setActive({ key, phase: 'planned', plan });
    if (plan.resumeFrom !== null) {
      // 22.5: the outputs of a step that fails the check are out of date. Artifact_Status is
      // kept by the runs feature; its staleness check marks them 已过期 once it is available.
      window.electron.artifactsCheckStale(task.projectDir).catch(() => undefined);
    }
  };

  const completeTask = async (task: ResumableTask, plan: ResumePlan) => {
    const key = taskKey(task);
    setActive({ key, phase: 'starting', plan });
    let checked: ResumePlan;
    try {
      const result = await window.electron.taskResumeComplete(targetOf(task));
      if (!result.ok) {
        throw new Error(result.error.message);
      }
      checked = result.data;
    } catch (error) {
      setActive({ key, phase: 'planned', plan });
      showFailure(intl.formatMessage(i18n.failed), error);
      return;
    }
    if (checked.resumeFrom !== null) {
      // A file changed since the check: show the new plan instead.
      setActive({ key, phase: 'planned', plan: checked });
      return;
    }
    setActive(null);
    toastSuccess({ title: intl.formatMessage(i18n.completed, { title: task.plan.title }) });
    const remaining = tasks.filter((candidate) => taskKey(candidate) !== key);
    setTasks(remaining);
    if (!remaining.some((candidate) => showDismissed || !candidate.plan.dismissed)) {
      setOpen(false);
    }
  };

  const startTask = async (task: ResumableTask, plan: ResumePlan) => {
    if (plan.resumeFrom === null) {
      await completeTask(task, plan);
      return;
    }
    const key = taskKey(task);
    setActive({ key, phase: 'starting', plan });
    try {
      // A new session in the Project; the Kernel runs the remaining steps there.
      const session = await createSession(task.projectDir, { allExtensions: extensionsList });
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED, { detail: { session } }));
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, { detail: { sessionId: session.id } })
      );
      setOpen(false);
      setView('pair', { disableAnimation: true, resumeSessionId: session.id });

      const outcome = await resumeTask(session.id, task.plan.taskId, plan);
      const title = task.plan.title;
      if (outcome === 'resumed') {
        resumedKeys.current.add(key);
        setTasks((current) => current.filter((candidate) => taskKey(candidate) !== key));
        toastSuccess({
          title: intl.formatMessage(i18n.resumed, {
            title,
            step: stepLabel(task.plan, plan.resumeFrom),
          }),
        });
      } else if (outcome === 'paused') {
        toastSuccess({ title: intl.formatMessage(i18n.paused, { title }) });
        await refresh();
      } else {
        toastSuccess({ title: intl.formatMessage(i18n.completed, { title }) });
        await refresh();
      }
    } catch (error) {
      toastError({ title: intl.formatMessage(i18n.failed), msg: failureMessage(error) });
    } finally {
      setActive(null);
    }
  };

  const dismissTask = async (task: ResumableTask) => {
    const key = taskKey(task);
    try {
      const result = await window.electron.taskResumeDismiss(targetOf(task));
      if (!result.ok) {
        throw new Error(result.error.message);
      }
    } catch (error) {
      showFailure(intl.formatMessage(i18n.dismissFailed), error);
      return;
    }
    const next = tasks.map((candidate) =>
      taskKey(candidate) === key
        ? { ...candidate, plan: { ...candidate.plan, dismissed: true } }
        : candidate
    );
    setTasks(next);
    if (!showDismissed && !next.some((candidate) => !candidate.plan.dismissed)) {
      setOpen(false);
    }
  };

  const overwriteStep = (request: ConfirmOverwriteRequest_unstable): string => {
    const task = tasks.find((candidate) => candidate.plan.taskId === request.taskId);
    return task ? stepLabel(task.plan, request.stepId) : request.stepId;
  };

  const close = () => {
    if (active?.phase !== 'starting') {
      setOpen(false);
      setActive(null);
    }
  };

  const dialogOpen = open && visibleTasks.length > 0;

  return (
    <>
      {dialogOpen && (
        <div
          className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              close();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="flex max-h-[85vh] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border-primary bg-background-primary"
          >
            <div className="flex items-start gap-3 bg-background-secondary px-4 py-3">
              <div className="min-w-0 flex-1">
                <h2 id={titleId} className="text-sm font-medium text-text-primary">
                  {intl.formatMessage(i18n.title)}
                </h2>
                <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.intro)}</p>
              </div>
              <button
                type="button"
                onClick={close}
                aria-label={intl.formatMessage(i18n.close)}
                className="rounded p-1 text-text-secondary hover:bg-background-tertiary"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
              {visibleTasks.map((task) => {
                const key = taskKey(task);
                const mine = active?.key === key ? active : null;
                return (
                  <TaskResumeCard
                    key={key}
                    task={task}
                    phase={mine?.phase ?? 'idle'}
                    plan={mine?.plan ?? null}
                    disabled={active !== null && active.key !== key}
                    onContinue={() => void checkTask(task)}
                    onDismiss={() => void dismissTask(task)}
                    onStart={(plan) => void startTask(task, plan)}
                    onBack={() => setActive(null)}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}

      {!dialogOpen && tasks.length > 0 && (
        <button
          type="button"
          onClick={openDetail}
          className="no-drag fixed left-1/2 top-1.5 z-40 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-primary bg-background-primary px-3 py-0.5 text-xs text-text-secondary hover:text-text-primary"
        >
          <History className="h-3.5 w-3.5" aria-hidden="true" />
          {intl.formatMessage(i18n.chip, { count: tasks.length })}
        </button>
      )}

      {overwrite && (
        <OverwriteConfirmDialog
          request={overwrite}
          stepTitle={overwriteStep(overwrite)}
          onAnswer={answerOverwrite}
        />
      )}
    </>
  );
}

import { useState } from 'react';
import { ArrowLeft, CheckCircle2, Circle, FolderOpen, MessageSquare, XCircle } from 'lucide-react';
import { AppEvents } from '../../constants/events';
import { useNavigation } from '../../hooks/useNavigation';
import { defineMessages, useIntl } from '../../i18n';
import { createSession } from '../../sessions';
import { toastError } from '../../toasts';
import type { LearningCheck, LearningExercise } from '../../types/learningApi';
import { errorMessage } from '../../utils/conversionUtils';
import type { IpcError } from '../../utils/ipcResult';
import {
  leaveLearningMode,
  startLearningChat,
  unlockLearningChats,
} from '../../utils/learning/learningChat';
import { learningSessionsFor } from '../../utils/learning/learningSessions';
import type { CheckOutcome, ExerciseRecord } from '../../utils/learning/progress';
import { CHECK_TIMEOUT, runLearningCheck } from '../../utils/learning/runCheck';
import { getInitialWorkingDir } from '../../utils/workingDir';
import { useConfig } from '../ConfigContext';
import { Button } from '../ui/button';
import { ConfirmationModal } from '../ui/ConfirmationModal';
import { ExerciseStatusBadge } from './ExerciseStatusBadge';

const i18n = defineMessages({
  close: { id: 'learning.exercise.close', defaultMessage: 'Close exercise' },
  statement: { id: 'learning.exercise.statement', defaultMessage: 'Exercise' },
  checks: { id: 'learning.exercise.checks', defaultMessage: 'Check items' },
  checkPassed: { id: 'learning.exercise.checkPassed', defaultMessage: 'Passed' },
  checkFailed: { id: 'learning.exercise.checkFailed', defaultMessage: 'Not passed: {reason}' },
  checkPending: { id: 'learning.exercise.checkPending', defaultMessage: 'Not checked yet' },
  subjective: { id: 'learning.exercise.subjective', defaultMessage: 'judged by the agent' },
  completedAt: { id: 'learning.exercise.completedAt', defaultMessage: 'Completed at {time}' },
  projectDir: { id: 'learning.exercise.projectDir', defaultMessage: 'Project folder' },
  projectDirHint: {
    id: 'learning.exercise.projectDirHint',
    defaultMessage: 'The folder that holds your exercise files; the checks read files from it.',
  },
  noProjectDir: { id: 'learning.exercise.noProjectDir', defaultMessage: 'No folder chosen' },
  chooseProjectDir: { id: 'learning.exercise.chooseProjectDir', defaultMessage: 'Choose folder' },
  submission: { id: 'learning.exercise.submission', defaultMessage: 'Your submission' },
  submissionPlaceholder: {
    id: 'learning.exercise.submissionPlaceholder',
    defaultMessage: 'Describe what you did and what you found. You can revise it and resubmit.',
  },
  submit: { id: 'learning.exercise.submit', defaultMessage: 'Submit for checking' },
  checking: { id: 'learning.exercise.checking', defaultMessage: 'Checking…' },
  recheck: { id: 'learning.exercise.recheck', defaultMessage: 'Check again' },
  needProjectDir: {
    id: 'learning.exercise.needProjectDir',
    defaultMessage: 'Choose the project folder that holds your exercise files first.',
  },
  checkTimeout: {
    id: 'learning.exercise.checkTimeout',
    defaultMessage:
      'The check did not finish within 60 seconds. The exercise status has not changed and your submission is kept.',
  },
  invalidProject: {
    id: 'learning.exercise.invalidProject',
    defaultMessage:
      'The project folder cannot be read. The exercise status has not changed and your submission is kept.',
  },
  checkError: {
    id: 'learning.exercise.checkError',
    defaultMessage:
      'The check failed: {message}. The exercise status has not changed and your submission is kept.',
  },
  learningMode: { id: 'learning.exercise.learningMode', defaultMessage: 'Learning mode' },
  learningModeHint: {
    id: 'learning.exercise.learningModeHint',
    defaultMessage:
      'In learning mode the agent answers with hints and questions instead of full solution code.',
  },
  learningModeActive: {
    id: 'learning.exercise.learningModeActive',
    defaultMessage: 'Chats in learning mode for this exercise: {count}',
  },
  practiceInChat: { id: 'learning.exercise.practiceInChat', defaultMessage: 'Practise in chat' },
  leaveLearningMode: {
    id: 'learning.exercise.leaveLearningMode',
    defaultMessage: 'Leave learning mode',
  },
  viewSolution: { id: 'learning.exercise.viewSolution', defaultMessage: 'View full solution' },
  confirmTitle: { id: 'learning.exercise.confirmTitle', defaultMessage: 'View the full solution?' },
  confirmMessage: {
    id: 'learning.exercise.confirmMessage',
    defaultMessage:
      'The agent will write the complete solution code in a new chat, and this exercise will be marked "Solution viewed" for good.',
  },
  confirm: { id: 'learning.exercise.confirm', defaultMessage: 'View solution' },
  cancel: { id: 'learning.exercise.cancel', defaultMessage: 'Cancel' },
  chatFailed: {
    id: 'learning.exercise.chatFailed',
    defaultMessage: 'Could not start a learning-mode chat',
  },
  unlockFailed: {
    id: 'learning.exercise.unlockFailed',
    defaultMessage: 'Could not unlock the solution',
  },
});

type Verdict = { state: 'passed' } | { state: 'failed'; reason: string } | { state: 'pending' };

function verdictFor(
  check: LearningCheck,
  outcome: CheckOutcome | null,
  record: ExerciseRecord | undefined
): Verdict {
  if (outcome) {
    const failure = outcome.failures.find((entry) => entry.checkId === check.id);
    return failure ? { state: 'failed', reason: failure.reason } : { state: 'passed' };
  }
  return record?.status === '已完成' ? { state: 'passed' } : { state: 'pending' };
}

export interface LearningExercisePageProps {
  exercise: LearningExercise;
  record: ExerciseRecord | undefined;
  onRecordChange: (record: ExerciseRecord) => void;
  onClose: () => void;
}

/**
 * One exercise (requirements 20.2, 20.3, 20.5–20.7): statement, check items with their verdicts,
 * submission and resubmission without limit, learning-mode chats, and "查看完整解答" behind a
 * second confirmation.
 */
export default function LearningExercisePage({
  exercise,
  record,
  onRecordChange,
  onClose,
}: LearningExercisePageProps) {
  const intl = useIntl();
  const setView = useNavigation();
  const { extensionsList } = useConfig();
  const [projectDir, setProjectDir] = useState(() => getInitialWorkingDir());
  const [submission, setSubmission] = useState(record?.lastSubmission ?? '');
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<CheckOutcome | null>(null);
  const [checkError, setCheckError] = useState<IpcError | null>(null);
  const [missingProjectDir, setMissingProjectDir] = useState(false);
  const [chats, setChats] = useState(() => learningSessionsFor(exercise.id));
  const [startingChat, setStartingChat] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unlocking, setUnlocking] = useState(false);

  const chooseProjectDir = async () => {
    const result = await window.electron.directoryChooser();
    if (!result.canceled && result.filePaths[0]) {
      setProjectDir(result.filePaths[0]);
      setMissingProjectDir(false);
    }
  };

  const submit = async () => {
    if (checking) return;
    if (!projectDir) {
      setMissingProjectDir(true);
      return;
    }
    setChecking(true);
    setCheckError(null);
    const run = await runLearningCheck(
      { exercise, projectDir, submission },
      { api: window.electron }
    );
    setChecking(false);
    if (run.ok) {
      setOutcome(run.outcome);
      onRecordChange(run.outcome.record);
    } else {
      setCheckError(run.error);
    }
  };

  const openChat = async (solutionUnlocked: boolean) => {
    setStartingChat(true);
    try {
      const { session, message } = await startLearningChat(
        exercise,
        projectDir || getInitialWorkingDir(),
        solutionUnlocked,
        { createSession: (dir) => createSession(dir, { allExtensions: extensionsList }) }
      );
      setChats(learningSessionsFor(exercise.id));
      const initialMessage = { msg: message, images: [] };
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED, { detail: { session } }));
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
          detail: { sessionId: session.id, initialMessage },
        })
      );
      setView('pair', { disableAnimation: true, resumeSessionId: session.id, initialMessage });
    } catch (error) {
      toastError({
        title: intl.formatMessage(i18n.chatFailed),
        msg: errorMessage(error, intl.formatMessage(i18n.chatFailed)),
      });
      setStartingChat(false);
    }
  };

  const confirmSolution = async () => {
    setUnlocking(true);
    const result = await window.electron
      .learningSolutionUnlock(exercise.id)
      .catch((error: unknown) => ({
        ok: false as const,
        error: { code: 'UNLOCK_FAILED', message: errorMessage(error, String(error)) },
      }));
    setUnlocking(false);
    setConfirmOpen(false);
    if (!result.ok) {
      toastError({ title: intl.formatMessage(i18n.unlockFailed), msg: result.error.message });
      return;
    }
    onRecordChange(result.data);
    await unlockLearningChats(exercise.id);
    await openChat(true);
  };

  const leave = async () => {
    await leaveLearningMode(exercise.id);
    setChats([]);
  };

  const close = () => {
    void leaveLearningMode(exercise.id);
    onClose();
  };

  const errorText = (error: IpcError): string => {
    if (error.code === CHECK_TIMEOUT) return intl.formatMessage(i18n.checkTimeout);
    if (error.code === 'INVALID_PROJECT') return intl.formatMessage(i18n.invalidProject);
    return intl.formatMessage(i18n.checkError, { message: error.message });
  };

  return (
    <article className="max-w-3xl px-6 py-5">
      <button
        onClick={close}
        className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {intl.formatMessage(i18n.close)}
      </button>

      <header className="mt-3 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-medium text-text-primary">{exercise.title}</h2>
        <ExerciseStatusBadge record={record} />
      </header>
      {record?.status === '已完成' && record.completedAt && (
        <p className="mt-1 text-xs text-text-secondary">
          {intl.formatMessage(i18n.completedAt, {
            time: intl.formatDate(record.completedAt, { dateStyle: 'medium', timeStyle: 'short' }),
          })}
        </p>
      )}

      <section className="mt-4">
        <h3 className="text-xs font-medium text-text-primary">
          {intl.formatMessage(i18n.statement)}
        </h3>
        <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-text-primary">
          {exercise.prompt}
        </p>
      </section>

      <section className="mt-5">
        <h3 className="text-xs font-medium text-text-primary">{intl.formatMessage(i18n.checks)}</h3>
        <ul className="mt-2 space-y-1.5">
          {exercise.checks.map((check) => {
            const verdict = verdictFor(check, outcome, record);
            return (
              <li
                key={check.id}
                data-testid={`learning-check-${check.id}`}
                className="flex items-start gap-2 text-sm"
              >
                {verdict.state === 'passed' && (
                  <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-green-600" />
                )}
                {verdict.state === 'failed' && (
                  <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" />
                )}
                {verdict.state === 'pending' && (
                  <Circle className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-tertiary" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="text-text-primary">{check.description}</span>
                  {check.kind === 'subjective' && (
                    <span className="ml-1 text-xs text-text-tertiary">
                      ({intl.formatMessage(i18n.subjective)})
                    </span>
                  )}
                  <span className="block text-xs text-text-secondary">
                    {verdict.state === 'passed' && intl.formatMessage(i18n.checkPassed)}
                    {verdict.state === 'failed' &&
                      intl.formatMessage(i18n.checkFailed, { reason: verdict.reason })}
                    {verdict.state === 'pending' && intl.formatMessage(i18n.checkPending)}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="mt-5 space-y-2">
        <h3 className="text-xs font-medium text-text-primary">
          {intl.formatMessage(i18n.projectDir)}
        </h3>
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.projectDirHint)}</p>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate rounded-lg border border-border-secondary bg-background-secondary px-2.5 py-1.5 text-xs text-text-secondary">
            {projectDir || intl.formatMessage(i18n.noProjectDir)}
          </span>
          <Button variant="outline" size="sm" onClick={chooseProjectDir}>
            <FolderOpen className="h-3.5 w-3.5" />
            {intl.formatMessage(i18n.chooseProjectDir)}
          </Button>
        </div>
        {missingProjectDir && (
          <p role="alert" className="text-xs text-red-500">
            {intl.formatMessage(i18n.needProjectDir)}
          </p>
        )}

        <label
          htmlFor={`learning-submission-${exercise.id}`}
          className="block pt-2 text-xs font-medium text-text-primary"
        >
          {intl.formatMessage(i18n.submission)}
        </label>
        <textarea
          id={`learning-submission-${exercise.id}`}
          value={submission}
          onChange={(event) => setSubmission(event.target.value)}
          placeholder={intl.formatMessage(i18n.submissionPlaceholder)}
          rows={5}
          className="w-full rounded-lg border border-border-secondary bg-background-default px-3 py-2 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={submit} disabled={checking}>
            {intl.formatMessage(checking ? i18n.checking : i18n.submit)}
          </Button>
        </div>
        {checkError && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2"
          >
            <p className="min-w-0 flex-1 text-xs text-red-600 dark:text-red-400">
              {errorText(checkError)}
            </p>
            <Button variant="outline" size="sm" onClick={submit} disabled={checking}>
              {intl.formatMessage(i18n.recheck)}
            </Button>
          </div>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border-secondary px-4 py-3">
        <h3 className="text-xs font-medium text-text-primary">
          {intl.formatMessage(i18n.learningMode)}
        </h3>
        <p className="mt-1 text-xs text-text-secondary">
          {intl.formatMessage(i18n.learningModeHint)}
        </p>
        {chats.length > 0 && (
          <p className="mt-1 text-xs text-text-primary">
            {intl.formatMessage(i18n.learningModeActive, { count: chats.length })}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => openChat(record?.solutionViewed ?? false)}
            disabled={startingChat}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            {intl.formatMessage(i18n.practiceInChat)}
          </Button>
          {chats.length > 0 && (
            <Button variant="ghost" size="sm" onClick={leave}>
              {intl.formatMessage(i18n.leaveLearningMode)}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmOpen(true)}
            disabled={startingChat || unlocking}
          >
            {intl.formatMessage(i18n.viewSolution)}
          </Button>
        </div>
      </section>

      <ConfirmationModal
        isOpen={confirmOpen}
        title={intl.formatMessage(i18n.confirmTitle)}
        message={intl.formatMessage(i18n.confirmMessage)}
        confirmLabel={intl.formatMessage(i18n.confirm)}
        cancelLabel={intl.formatMessage(i18n.cancel)}
        isSubmitting={unlocking}
        onConfirm={confirmSolution}
        onCancel={() => setConfirmOpen(false)}
      />
    </article>
  );
}

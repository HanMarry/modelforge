import { defineMessages } from '../../i18n';

/** Texts of the interrupted-task prompt (requirement 22, task 25.5). */
export const taskResumeMessages = defineMessages({
  title: { id: 'taskResume.title', defaultMessage: 'Unfinished tasks' },
  intro: {
    id: 'taskResume.intro',
    defaultMessage:
      'These tasks stopped before they finished. Continue from the failure point: steps whose Run_Records still match the files are skipped.',
  },
  close: { id: 'taskResume.close', defaultMessage: 'Close' },
  project: { id: 'taskResume.project', defaultMessage: 'Project: {name}' },
  statusPaused: { id: 'taskResume.statusPaused', defaultMessage: 'Paused' },
  statusInterrupted: { id: 'taskResume.statusInterrupted', defaultMessage: 'Interrupted' },
  dismissedBadge: { id: 'taskResume.dismissedBadge', defaultMessage: 'Not prompted again' },
  stepCompleted: { id: 'taskResume.stepCompleted', defaultMessage: 'Completed' },
  stepFailed: { id: 'taskResume.stepFailed', defaultMessage: 'Failure point' },
  stepNotReached: { id: 'taskResume.stepNotReached', defaultMessage: 'Not reached' },
  noRuns: { id: 'taskResume.noRuns', defaultMessage: 'No run recorded' },
  runTimes: { id: 'taskResume.runTimes', defaultMessage: '{start} – {end}' },
  runMissing: {
    id: 'taskResume.runMissing',
    defaultMessage: 'Run_Record missing or unreadable',
  },
  runExitCode: { id: 'taskResume.runExitCode', defaultMessage: 'exit code {code}' },
  runFailure: { id: 'taskResume.runFailure', defaultMessage: 'ended: {failure}' },
  continue: { id: 'taskResume.continue', defaultMessage: 'Continue from the failure point' },
  dismiss: { id: 'taskResume.dismiss', defaultMessage: 'Do not resume' },
  checking: {
    id: 'taskResume.checking',
    defaultMessage: 'Checking the steps against their Run_Records…',
  },
  planSkip: {
    id: 'taskResume.planSkip',
    defaultMessage: 'Skipped, still match the files: {steps}',
  },
  planSkipNone: { id: 'taskResume.planSkipNone', defaultMessage: 'No step can be skipped.' },
  planFrom: { id: 'taskResume.planFrom', defaultMessage: 'Runs again from: {step}' },
  planReasons: { id: 'taskResume.planReasons', defaultMessage: 'Why this step runs again:' },
  planNothing: {
    id: 'taskResume.planNothing',
    defaultMessage: 'Every step still matches its Run_Records; nothing needs to run again.',
  },
  moreReasons: { id: 'taskResume.moreReasons', defaultMessage: 'and {count} more' },
  start: { id: 'taskResume.start', defaultMessage: 'Start' },
  markCompleted: { id: 'taskResume.markCompleted', defaultMessage: 'Mark as completed' },
  back: { id: 'taskResume.back', defaultMessage: 'Back' },
  reasonNoRun: {
    id: 'taskResume.reasonNoRun',
    defaultMessage: 'Record missing: the step has no run',
  },
  reasonRecordMissing: {
    id: 'taskResume.reasonRecordMissing',
    defaultMessage: 'Record missing: {runId}',
  },
  reasonRecordTruncated: {
    id: 'taskResume.reasonRecordTruncated',
    defaultMessage: 'Record missing: {runId} lists only the first 1000 files',
  },
  reasonRunFailed: {
    id: 'taskResume.reasonRunFailed',
    defaultMessage: 'Run {runId} did not end with exit code 0',
  },
  reasonHashMismatch: {
    id: 'taskResume.reasonHashMismatch',
    defaultMessage: 'Hash mismatch: {path}',
  },
  reasonFileMissing: { id: 'taskResume.reasonFileMissing', defaultMessage: 'File missing: {path}' },
  chip: { id: 'taskResume.chip', defaultMessage: 'Unfinished tasks: {count}' },
  resumed: { id: 'taskResume.resumed', defaultMessage: 'Continuing “{title}” from “{step}”' },
  paused: {
    id: 'taskResume.paused',
    defaultMessage: '“{title}” stays paused; no file was changed',
  },
  completed: { id: 'taskResume.completed', defaultMessage: '“{title}” is marked as completed' },
  failed: { id: 'taskResume.failed', defaultMessage: 'Could not resume the task' },
  dismissFailed: {
    id: 'taskResume.dismissFailed',
    defaultMessage: 'Could not update the task plan',
  },
  errorStalePlan: {
    id: 'taskResume.errorStalePlan',
    defaultMessage: 'The task plan has changed; check the steps again.',
  },
  errorSessionBusy: {
    id: 'taskResume.errorSessionBusy',
    defaultMessage: 'The session is still running; try again when it has finished.',
  },
  overwriteTitle: {
    id: 'taskResume.overwriteTitle',
    defaultMessage: 'Overwrite existing outputs?',
  },
  overwriteBody: {
    id: 'taskResume.overwriteBody',
    defaultMessage:
      'Continuing from “{step}” runs the remaining steps again and overwrites these files. Nothing changes until you confirm.',
  },
  overwriteModified: { id: 'taskResume.overwriteModified', defaultMessage: 'modified {time}' },
  overwriteConfirm: { id: 'taskResume.overwriteConfirm', defaultMessage: 'Overwrite and continue' },
  overwriteCancel: { id: 'taskResume.overwriteCancel', defaultMessage: 'Cancel and stay paused' },
});

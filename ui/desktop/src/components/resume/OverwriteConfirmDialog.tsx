import { useId } from 'react';
import type { ConfirmOverwriteRequest_unstable } from '@aaif/goose-acp-client';
import { useIntl } from '../../i18n';
import { taskResumeMessages as i18n } from './messages';
import { formatSize, formatTime } from './resumeFormat';

export type OverwriteAnswer = 'confirm' | 'cancel';

interface OverwriteConfirmDialogProps {
  request: ConfirmOverwriteRequest_unstable;
  /** Title of the step the Kernel is about to run. */
  stepTitle: string;
  onAnswer: (answer: OverwriteAnswer) => void;
}

/**
 * The Kernel's `tasks/confirm-overwrite` question (requirement 22.3): the output files a resumed
 * task would overwrite, each with its Project path, size and modification time. Cancel is the
 * default; nothing changes unless the user confirms (22.6).
 */
export default function OverwriteConfirmDialog({
  request,
  stepTitle,
  onAnswer,
}: OverwriteConfirmDialogProps) {
  const intl = useIntl();
  const titleId = useId();
  const bodyId = useId();

  return (
    <div
      className="no-drag fixed inset-0 z-[60] flex items-center justify-center bg-black/40"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          onAnswer('cancel');
        }
      }}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="flex max-h-[85vh] w-[520px] max-w-[92vw] flex-col overflow-hidden rounded-2xl border border-border-primary bg-background-primary"
      >
        <h2 id={titleId} className="bg-background-secondary px-4 py-2 text-text-primary">
          {intl.formatMessage(i18n.overwriteTitle)}
        </h2>
        <p id={bodyId} className="px-4 pt-3 text-sm text-text-secondary">
          {intl.formatMessage(i18n.overwriteBody, { step: stepTitle })}
        </p>
        <ul className="mx-4 my-3 flex-1 space-y-1.5 overflow-y-auto">
          {request.files.map((file) => (
            <li
              key={file.path}
              className="rounded-lg border border-border-secondary px-3 py-1.5 text-sm"
            >
              <div className="break-all font-mono text-text-primary">{file.path}</div>
              <div className="text-xs text-text-secondary">
                {formatSize(intl, file.size)}
                {' · '}
                {intl.formatMessage(i18n.overwriteModified, {
                  time: formatTime(intl, file.modifiedAt),
                })}
              </div>
            </li>
          ))}
        </ul>
        <div className="flex justify-end gap-2 border-t border-border-primary px-4 py-3">
          <button
            type="button"
            autoFocus
            onClick={() => onAnswer('cancel')}
            className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-background-tertiary"
          >
            {intl.formatMessage(i18n.overwriteCancel)}
          </button>
          <button
            type="button"
            onClick={() => onAnswer('confirm')}
            className="rounded bg-background-info px-3 py-1 text-sm text-text-inverse hover:opacity-90"
          >
            {intl.formatMessage(i18n.overwriteConfirm)}
          </button>
        </div>
      </div>
    </div>
  );
}

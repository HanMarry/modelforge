import { FolderOpen, X } from 'lucide-react';
import type { WorkspaceEntry } from '../../types/workspaceApi';
import { defineMessages, useIntl } from '../../i18n';
import FilePreview from './preview/FilePreview';
import { usePreviewData } from './preview/usePreviewData';

const i18n = defineMessages({
  workspaceTab: { id: 'workspaceEditor.tab', defaultMessage: 'Files' },
  closeEditor: { id: 'workspaceEditor.close', defaultMessage: 'Close editor view' },
  openFileTitle: { id: 'workspaceEditor.openFileTitle', defaultMessage: 'Open a file' },
  openFileHint: {
    id: 'workspaceEditor.openFileHint',
    defaultMessage: 'Pick a file from the workspace tree on the right',
  },
});

interface WorkspaceEditorViewProps {
  activeFile: WorkspaceEntry | null;
  workingDir: string;
  onClose: () => void;
  onClearFile: () => void;
}

/** The centre column of editor view: one workspace tab plus the active file. */
export default function WorkspaceEditorView({
  activeFile,
  workingDir,
  onClose,
  onClearFile,
}: WorkspaceEditorViewProps) {
  const intl = useIntl();
  const preview = usePreviewData(activeFile);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col border-l border-border-primary bg-background-primary">
      <div className="flex items-center gap-1 border-b border-border-primary px-1 py-1">
        <span className="flex items-center gap-1.5 rounded bg-background-tertiary px-2 py-1 text-[11px] text-text-primary">
          {intl.formatMessage(i18n.workspaceTab)}
          <button
            type="button"
            onClick={onClose}
            title={intl.formatMessage(i18n.closeEditor)}
            className="rounded p-0.5 text-text-tertiary transition-colors hover:bg-background-primary hover:text-text-primary"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
        {activeFile && (
          <>
            <span className="mx-1 h-4 w-px bg-border-primary" />
            <span
              dir="auto"
              className="min-w-0 flex-1 truncate font-mono text-[11px] text-text-secondary"
              title={activeFile.path}
            >
              {activeFile.path.startsWith(workingDir)
                ? activeFile.path.slice(workingDir.length + 1)
                : activeFile.path}
            </span>
            <button
              type="button"
              onClick={onClearFile}
              className="rounded px-1.5 py-0.5 text-[10px] text-text-tertiary transition-colors hover:bg-background-tertiary hover:text-text-primary"
            >
              <X className="h-3 w-3" />
            </button>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeFile ? (
          <FilePreview
            entry={activeFile}
            kind={preview.kind}
            text={preview.text}
            imageDataUrl={preview.imageDataUrl}
            bytes={preview.bytes}
            loading={preview.loading}
            onRetry={preview.retry}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <FolderOpen className="h-7 w-7 text-text-tertiary" />
            <p className="text-xs text-text-primary">{intl.formatMessage(i18n.openFileTitle)}</p>
            <p className="text-[11px] text-text-tertiary">
              {intl.formatMessage(i18n.openFileHint)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

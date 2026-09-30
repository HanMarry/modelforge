import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { AlertCircle, Database, ExternalLink, FileSpreadsheet, Loader2 } from 'lucide-react';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { useChatContext } from '../../contexts/ChatContext';
import { getInitialWorkingDir } from '../../utils/workingDir';
import { seedComposer } from '../../utils/composerSeed';
import {
  kernelUnavailableReason,
  sendSessionTask,
  sessionTaskTarget,
  type SessionTaskReason,
} from '../../utils/sendSessionTask';
import {
  buildDatasetDescriptionTask,
  DATASET_TASK_TIMEOUT_SECONDS,
} from '../../utils/datasets/datasetTask';
import type { DataFileEntry, DataPreview } from '../../types/datasets';

const i18n = defineMessages({
  title: { id: 'datasets.title', defaultMessage: 'Datasets' },
  subtitle: { id: 'datasets.subtitle', defaultMessage: 'View and preview project data files' },
  empty: { id: 'datasets.empty', defaultMessage: 'No data files to preview in this project' },
  emptyFormats: {
    id: 'datasets.emptyFormats',
    defaultMessage: 'Supports .csv, .xlsx, .json, .parquet',
  },
  truncated: { id: 'datasets.truncated', defaultMessage: 'Showing first 1000 of {total}' },
  size: { id: 'datasets.size', defaultMessage: 'Size' },
  modified: { id: 'datasets.modified', defaultMessage: 'Modified' },
  fields: { id: 'datasets.fields', defaultMessage: 'Fields' },
  rows: { id: 'datasets.rows', defaultMessage: 'Rows' },
  preview: { id: 'datasets.preview', defaultMessage: 'Preview (first {count} rows)' },
  type: { id: 'datasets.type', defaultMessage: 'Type' },
  missing: { id: 'datasets.missing', defaultMessage: 'Missing' },
  tooLarge: { id: 'datasets.tooLarge', defaultMessage: 'File exceeds the 200 MB preview limit' },
  parseFailed: { id: 'datasets.parseFailed', defaultMessage: 'Unable to parse this file' },
  openExternally: { id: 'datasets.openExternally', defaultMessage: 'Open with system program' },
  sheet: { id: 'datasets.sheet', defaultMessage: 'Worksheet' },
  generateDescription: {
    id: 'datasets.generateDescription',
    defaultMessage: 'Generate data description',
  },
  noFileSelected: {
    id: 'datasets.noFileSelected',
    defaultMessage: 'Select a file to generate a description',
  },
  descriptionRunning: {
    id: 'datasets.descriptionRunning',
    defaultMessage: 'Describing {path} in the current chat, up to {minutes} minutes…',
  },
  descriptionDone: {
    id: 'datasets.descriptionDone',
    defaultMessage: 'The description of {path} is in the current chat.',
  },
  descriptionBusy: {
    id: 'datasets.descriptionBusy',
    defaultMessage:
      'The current chat is still working, so the task for {path} was not sent. Try again when it finishes.',
  },
  descriptionKernelUnavailable: {
    id: 'datasets.descriptionKernelUnavailable',
    defaultMessage: 'The task for {path} was not sent: the Kernel is not available.',
  },
  descriptionTimeout: {
    id: 'datasets.descriptionTimeout',
    defaultMessage:
      'No description for {path}: the Kernel did not finish within {minutes} minutes.',
  },
  descriptionKernelError: {
    id: 'datasets.descriptionKernelError',
    defaultMessage: 'No description for {path}: sending failed or the Kernel returned an error.',
  },
  errorDetail: { id: 'datasets.errorDetail', defaultMessage: 'Details: {detail}' },
  retry: { id: 'datasets.retry', defaultMessage: 'Retry' },
  openChat: { id: 'datasets.openChat', defaultMessage: 'Open chat' },
});

const FAILURE_MESSAGES = {
  kernelUnavailable: i18n.descriptionKernelUnavailable,
  timeout: i18n.descriptionTimeout,
  kernelError: i18n.descriptionKernelError,
  busy: i18n.descriptionBusy,
};

const TIMEOUT_MINUTES = Math.round(DATASET_TASK_TIMEOUT_SECONDS / 60);

/** State of "生成数据说明"; `path` is the Project-relative file the task is about. */
type DescriptionState =
  | { status: 'idle' }
  | { status: 'running'; path: string; sessionId: string | null }
  | { status: 'done'; path: string; sessionId: string }
  | { status: 'failed'; path: string; reason: SessionTaskReason; detail: string };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatModified(ms: number): string {
  const date = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function DatasetsView() {
  const intl = useIntl();
  const navigate = useNavigate();
  const hintId = useId();
  const root = getInitialWorkingDir();
  // The chat the user was last in, as for the apps page; the dataset page has no session itself.
  const currentSessionId = useChatContext()?.chat.sessionId ?? null;

  const [files, setFiles] = useState<DataFileEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<DataPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [activeSheet, setActiveSheet] = useState<string>('');
  const [description, setDescription] = useState<DescriptionState>({ status: 'idle' });
  const descriptionSequence = useRef(0);

  const refresh = async (): Promise<void> => {
    const result = await window.electron.datasetsList(root);
    if (result.ok) {
      setFiles(result.data.files);
      setTotal(result.data.total);
      setTruncated(result.data.truncated);
    } else {
      setFiles([]);
      setTotal(0);
    }
  };

  useEffect(() => {
    refresh();
    if (!root) return undefined;
    // Reload the list when files under the project change (requirement 10.1).
    const off = window.electron.onDatasetsChanged((changedRoot) => {
      if (changedRoot === root) void refresh();
    });
    void window.electron.datasetsWatch(root);
    return () => {
      off();
      void window.electron.datasetsUnwatch();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const selected = files.find((f) => f.relativePath === selectedPath) ?? null;
  const describing = description.status === 'running';

  const absolutePath = (relative: string): string =>
    root.endsWith('/') ? `${root}${relative}` : `${root}/${relative}`;

  const loadPreview = async (filePath: string, sheet?: string): Promise<void> => {
    setPreview(null);
    setPreviewError(null);
    const result = await window.electron.datasetsPreview({ root, filePath, sheet });
    if (result.ok) {
      setPreview(result.data);
      setActiveSheet(result.data.activeSheet);
    } else {
      setPreviewError(`${result.error.code}: ${result.error.message}`);
    }
  };

  useEffect(() => {
    if (selected) {
      loadPreview(absolutePath(selected.relativePath));
    } else {
      setPreview(null);
      setPreviewError(null);
    }
    // A finished or failed task belongs to the file it was about; a running one stays visible.
    setDescription((current) =>
      current.status === 'running' || current.status === 'idle' ? current : { status: 'idle' }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPath]);

  const openExternally = async (): Promise<void> => {
    if (selected) {
      await window.electron.workspaceOpenPath(absolutePath(selected.relativePath));
    }
  };

  const openChat = (sessionId: string): void => {
    navigate(`/pair?${new URLSearchParams({ resumeSessionId: sessionId }).toString()}`);
  };

  /**
   * Requirement 10.3, 10.6: the task goes straight to the current chat when it works in this
   * Project; the selection stays whatever the outcome, and a failure offers a retry.
   */
  const sendDescriptionTask = async (relativePath: string): Promise<void> => {
    if (describing) return;
    const task = buildDatasetDescriptionTask(relativePath);
    const sessionId = sessionTaskTarget(currentSessionId, root);
    const id = ++descriptionSequence.current;
    setDescription({ status: 'running', path: relativePath, sessionId });
    let next: DescriptionState;
    try {
      if (sessionId === null) {
        // No chat of this Project to send to: hand the task to the home composer instead.
        const unavailable = await kernelUnavailableReason();
        if (unavailable === null) {
          seedComposer(task, `dataset-desc-${Date.now()}`);
          navigate('/');
          return;
        }
        next = {
          status: 'failed',
          path: relativePath,
          reason: 'kernelUnavailable',
          detail: unavailable,
        };
      } else {
        const outcome = await sendSessionTask(sessionId, task, DATASET_TASK_TIMEOUT_SECONDS * 1000);
        next = outcome.ok
          ? { status: 'done', path: relativePath, sessionId }
          : {
              status: 'failed',
              path: relativePath,
              reason: outcome.reason,
              detail: outcome.detail,
            };
      }
    } catch (error) {
      next = {
        status: 'failed',
        path: relativePath,
        reason: 'kernelError',
        detail: errorText(error),
      };
    }
    if (descriptionSequence.current === id) setDescription(next);
  };

  const openChatButton = (sessionId: string) => (
    <button
      type="button"
      onClick={() => openChat(sessionId)}
      className="rounded-md text-xs text-text-primary underline underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info"
    >
      {intl.formatMessage(i18n.openChat)}
    </button>
  );

  const renderDescriptionStatus = () => {
    if (description.status === 'running') {
      return (
        <div
          role="status"
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary"
        >
          <span className="break-all">
            {intl.formatMessage(i18n.descriptionRunning, {
              path: description.path,
              minutes: TIMEOUT_MINUTES,
            })}
          </span>
          {description.sessionId !== null && openChatButton(description.sessionId)}
        </div>
      );
    }
    if (description.status === 'done') {
      return (
        <div
          role="status"
          className="mt-2 flex flex-wrap items-center gap-2 text-xs text-text-secondary"
        >
          <span className="break-all">
            {intl.formatMessage(i18n.descriptionDone, { path: description.path })}
          </span>
          {openChatButton(description.sessionId)}
        </div>
      );
    }
    if (description.status === 'failed') {
      const retryPath = description.path;
      return (
        <div
          role="alert"
          className="mt-2 rounded-lg border border-border-danger p-3 text-xs leading-relaxed"
        >
          <p className="break-all text-text-primary">
            {intl.formatMessage(FAILURE_MESSAGES[description.reason], {
              path: description.path,
              minutes: TIMEOUT_MINUTES,
            })}
          </p>
          {description.detail && (
            <p className="mt-1 break-all text-text-secondary">
              {intl.formatMessage(i18n.errorDetail, { detail: description.detail })}
            </p>
          )}
          <button
            type="button"
            onClick={() => void sendDescriptionTask(retryPath)}
            className="mt-2 rounded-md text-xs text-text-primary underline underline-offset-2 hover:text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info"
          >
            {intl.formatMessage(i18n.retry)}
          </button>
        </div>
      );
    }
    return null;
  };

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0">
        <div className="flex w-[320px] flex-shrink-0 flex-col border-r border-border-secondary min-h-0">
          <div className="px-4 pt-4 pb-3">
            <h1 className="text-sm font-medium text-text-primary">
              {intl.formatMessage(i18n.title)}
            </h1>
            <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.subtitle)}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {files.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
                <p className="mt-1 text-[11px] text-text-tertiary">
                  {intl.formatMessage(i18n.emptyFormats)}
                </p>
              </div>
            )}
            {truncated && (
              <p className="px-3 py-1 text-[11px] text-text-tertiary">
                {intl.formatMessage(i18n.truncated, { total })}
              </p>
            )}
            {files.map((file) => (
              <button
                type="button"
                key={file.relativePath}
                onClick={() => setSelectedPath(file.relativePath)}
                aria-pressed={selected?.relativePath === file.relativePath}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                  selected?.relativePath === file.relativePath
                    ? 'border-border-primary bg-background-tertiary'
                    : 'border-transparent hover:bg-background-tertiary/60'
                )}
              >
                <FileSpreadsheet className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">
                    {file.relativePath}
                  </span>
                  <span className="mt-0.5 block text-[11px] text-text-tertiary">
                    {formatSize(file.size)} · {formatModified(file.modifiedAt)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="max-w-4xl px-8 py-6">
            {selected && (
              <article>
                <header className="flex items-center gap-3">
                  <Database className="h-5 w-5 text-text-secondary" />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-medium text-text-primary">
                      {selected.relativePath}
                    </h2>
                    <p className="text-xs text-text-secondary">
                      {formatSize(selected.size)} · {formatModified(selected.modifiedAt)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={openExternally}
                    className="inline-flex items-center gap-1 rounded-lg border border-border-secondary px-3 py-1.5 text-xs text-text-primary hover:bg-background-tertiary"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {intl.formatMessage(i18n.openExternally)}
                  </button>
                </header>

                {previewError && (
                  <div className="mt-4 flex items-start gap-2 rounded-lg border border-border-secondary bg-background-secondary p-3">
                    <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-tertiary" />
                    <div>
                      <p className="text-xs text-text-secondary">{previewError}</p>
                      <button
                        type="button"
                        onClick={openExternally}
                        className="mt-1 text-xs text-text-primary underline underline-offset-2 hover:text-text-secondary"
                      >
                        {intl.formatMessage(i18n.openExternally)}
                      </button>
                    </div>
                  </div>
                )}

                {preview && (
                  <PreviewTable
                    preview={preview}
                    activeSheet={activeSheet}
                    onSheetChange={(s) => loadPreview(absolutePath(selected.relativePath), s)}
                  />
                )}
              </article>
            )}

            {/* Requirement 10.3: disabled until a file is selected. */}
            <section className={cn(selected && 'mt-5')}>
              <button
                type="button"
                onClick={() => {
                  if (selected) void sendDescriptionTask(selected.relativePath);
                }}
                disabled={!selected || describing}
                aria-busy={describing}
                aria-describedby={selected ? undefined : hintId}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-primary px-3 py-2 text-sm text-text-primary transition-colors hover:bg-background-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {describing && (
                  <Loader2
                    aria-hidden="true"
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  />
                )}
                {intl.formatMessage(i18n.generateDescription)}
              </button>
              {!selected && (
                <p id={hintId} className="mt-2 text-xs text-text-secondary">
                  {intl.formatMessage(i18n.noFileSelected)}
                </p>
              )}
              {renderDescriptionStatus()}
            </section>
          </div>
        </div>
      </div>
    </MainPanelLayout>
  );
}

function PreviewTable({
  preview,
  activeSheet,
  onSheetChange,
}: {
  preview: DataPreview;
  activeSheet: string;
  onSheetChange: (sheet: string) => void;
}) {
  const intl = useIntl();
  const columns = useMemo(() => preview.fields, [preview]);

  return (
    <div className="mt-4">
      {preview.sheetNames.length > 1 && (
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.sheet)}:</span>
          {preview.sheetNames.map((name) => (
            <button
              type="button"
              key={name}
              onClick={() => onSheetChange(name)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-xs',
                name === activeSheet
                  ? 'border-border-primary bg-background-tertiary text-text-primary'
                  : 'border-border-secondary text-text-secondary'
              )}
            >
              {name}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
        <div className="rounded-lg border border-border-secondary bg-background-secondary p-3">
          <span className="text-text-secondary">{intl.formatMessage(i18n.rows)}:</span>{' '}
          <span className="text-text-primary">{preview.totalRows}</span>
        </div>
        <div className="rounded-lg border border-border-secondary bg-background-secondary p-3">
          <span className="text-text-secondary">{intl.formatMessage(i18n.fields)}:</span>{' '}
          <span className="text-text-primary">{preview.fields.length}</span>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border-secondary">
        <table className="w-full text-left text-xs">
          <thead className="bg-background-secondary">
            <tr>
              {columns.map((field, i) => (
                <th
                  key={field}
                  className="whitespace-nowrap border-b border-border-secondary px-3 py-2"
                >
                  <div className="text-text-primary">{field}</div>
                  <div className="font-normal text-text-tertiary">
                    {preview.types[i]} · {intl.formatMessage(i18n.missing)}{' '}
                    {preview.missingCounts[i]}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.previewRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border-secondary last:border-0">
                {columns.map((field, colIndex) => (
                  <td key={field} className="whitespace-nowrap px-3 py-1.5 text-text-secondary">
                    {String(row[colIndex] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

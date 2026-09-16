import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, FileText, FolderOpen, RefreshCw, Search, Settings2 } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import type { ProjectSnapshot, ProjectStage, WorkspaceEntry } from '../../types/workspaceApi';
import { buildProjectAction, PROJECT_STAGES, type ProjectAction } from '../../utils/projectActions';
import { usePanelAutoRefresh } from '../../hooks/usePanelAutoRefresh';

const messages = defineMessages({
  title: { id: 'projectPanel.title', defaultMessage: 'Project materials' },
  subtitle: {
    id: 'projectPanel.subtitle',
    defaultMessage: 'Find your work. Decide what comes next.',
  },
  folder: { id: 'projectPanel.folder', defaultMessage: 'Choose project folder' },
  openFolder: { id: 'projectPanel.openFolder', defaultMessage: 'Open project folder' },
  empty: {
    id: 'projectPanel.empty',
    defaultMessage: 'Choose the folder containing your problem and data to start a project.',
  },
  refresh: { id: 'projectPanel.refresh', defaultMessage: 'Refresh materials' },
  loading: { id: 'projectPanel.loading', defaultMessage: 'Looking for project materials…' },
  error: {
    id: 'projectPanel.error',
    defaultMessage: 'Could not read this project. Check the folder is available, then retry.',
  },
  retry: { id: 'projectPanel.retry', defaultMessage: 'Retry' },
  partial: {
    id: 'projectPanel.partial',
    defaultMessage: 'Some folders were not scanned. Use Files to browse the rest.',
  },
  coverage: { id: 'projectPanel.coverage', defaultMessage: '{count} of 6 material types found' },
  caution: {
    id: 'projectPanel.caution',
    defaultMessage: 'Files are grouped for navigation. Their contents still need checking.',
  },
  missing: { id: 'projectPanel.missing', defaultMessage: 'No files found yet' },
  emptyFile: { id: 'projectPanel.emptyFile', defaultMessage: 'Empty file' },
  count: { id: 'projectPanel.count', defaultMessage: '{count} files' },
  expand: { id: 'projectPanel.expand', defaultMessage: 'Show all {count} files' },
  collapse: { id: 'projectPanel.collapse', defaultMessage: 'Show fewer' },
  added: {
    id: 'projectPanel.added',
    defaultMessage: 'Added to your draft. Review it in the chat input, then send when ready.',
  },
  environment: { id: 'projectPanel.environment', defaultMessage: 'Check running environment' },
  next: { id: 'projectPanel.next', defaultMessage: 'Suggested next step' },
  inputs: { id: 'projectPanel.inputs', defaultMessage: 'Problem & data' },
  plan: { id: 'projectPanel.plan', defaultMessage: 'Model plan' },
  code: { id: 'projectPanel.code', defaultMessage: 'Code & dependencies' },
  results: { id: 'projectPanel.results', defaultMessage: 'Computed results' },
  figures: { id: 'projectPanel.figures', defaultMessage: 'Figures' },
  paper: { id: 'projectPanel.paper', defaultMessage: 'Paper' },
  actionInputs: { id: 'projectPanel.actionInputs', defaultMessage: 'Inspect problem & data' },
  actionPlan: { id: 'projectPanel.actionPlan', defaultMessage: 'Prepare model plan' },
  actionCode: { id: 'projectPanel.actionCode', defaultMessage: 'Implement the model' },
  actionResults: { id: 'projectPanel.actionResults', defaultMessage: 'Reproduce results' },
  actionFigures: { id: 'projectPanel.actionFigures', defaultMessage: 'Prepare figures' },
  actionPaper: { id: 'projectPanel.actionPaper', defaultMessage: 'Improve the paper' },
  actionReview: { id: 'projectPanel.actionReview', defaultMessage: 'Review deliverables' },
});

const ACTION_LABELS = {
  inputs: messages.actionInputs,
  plan: messages.actionPlan,
  code: messages.actionCode,
  results: messages.actionResults,
  figures: messages.actionFigures,
  paper: messages.actionPaper,
  review: messages.actionReview,
};

const control =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info transition-colors motion-reduce:transition-none disabled:cursor-wait disabled:opacity-50';

interface ProjectPanelProps {
  workingDir: string;
  active?: boolean;
  isAgentActive?: boolean;
  onCompose: (text: string) => void;
  onOpenFile: (entry: WorkspaceEntry) => void;
  onWorkingDirChange?: (dir: string) => void | Promise<void>;
  onOpenEnvironment?: () => void;
}

export default function ProjectPanel({
  workingDir,
  active = true,
  isAgentActive = false,
  onCompose,
  onOpenFile,
  onWorkingDirChange,
  onOpenEnvironment,
}: ProjectPanelProps) {
  const intl = useIntl();
  const [loaded, setLoaded] = useState<{ directory: string; snapshot: ProjectSnapshot } | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [notice, setNotice] = useState(false);
  const [expanded, setExpanded] = useState<ProjectStage[]>([]);
  const sequence = useRef(0);
  const pending = useRef<{ id: number; directory: string } | null>(null);
  const snapshot = loaded?.directory === workingDir ? loaded.snapshot : null;

  const refresh = useCallback(async () => {
    if (!active || !workingDir || pending.current?.directory === workingDir) return;
    const id = ++sequence.current;
    pending.current = { id, directory: workingDir };
    setLoading(true);
    setError(false);
    try {
      const next = await window.electron.workspaceScanProject(workingDir);
      if (sequence.current === id) setLoaded({ directory: workingDir, snapshot: next });
    } catch {
      if (sequence.current === id) setError(true);
    } finally {
      if (pending.current?.id === id) pending.current = null;
      if (sequence.current === id) setLoading(false);
    }
  }, [workingDir, active]);

  useEffect(() => {
    void refresh();
    return () => {
      sequence.current += 1;
      pending.current = null;
    };
  }, [refresh, isAgentActive]);
  useEffect(() => {
    setNotice(false);
    setExpanded([]);
  }, [workingDir]);
  usePanelAutoRefresh(active && isAgentActive, () => void refresh(), 5000);

  const chooseFolder = async () => {
    try {
      const selected = await window.electron.directoryChooser();
      if (!selected.canceled && selected.filePaths[0])
        await onWorkingDirChange?.(selected.filePaths[0]);
    } catch {
      setError(true);
    }
  };
  const prepare = (action: ProjectAction) => {
    if (!snapshot) return;
    onCompose(buildProjectAction(action, snapshot));
    setNotice(true);
  };
  const foundStages = PROJECT_STAGES.filter((stage) =>
    snapshot?.artifacts.some((file) => file.stage === stage && file.size > 0)
  );
  const nextAction = PROJECT_STAGES.find((stage) => !foundStages.includes(stage)) ?? 'review';

  return (
    <section
      className="flex h-full min-h-0 flex-col text-text-primary"
      aria-label={intl.formatMessage(messages.title)}
    >
      <div className="border-b border-border-primary px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold tracking-tight">
              {intl.formatMessage(messages.title)}
            </h2>
            <p className="mt-1 text-xs leading-relaxed">{intl.formatMessage(messages.subtitle)}</p>
          </div>
          <button
            type="button"
            className={`${control} shrink-0 p-2 hover:bg-background-tertiary`}
            aria-label={intl.formatMessage(messages.refresh)}
            title={intl.formatMessage(messages.refresh)}
            disabled={loading || !workingDir}
            onClick={() => void refresh()}
          >
            <RefreshCw
              aria-hidden="true"
              className={`h-4 w-4 ${loading ? 'animate-spin motion-reduce:animate-none' : ''}`}
            />
          </button>
        </div>
        {workingDir && (
          <p title={workingDir} className="mt-3 break-all font-mono text-xs leading-relaxed">
            {workingDir}
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!workingDir ? (
          <div className="py-8 text-center">
            <FolderOpen aria-hidden="true" className="mx-auto mb-3 h-7 w-7" />
            <p className="text-sm leading-relaxed">{intl.formatMessage(messages.empty)}</p>
            {onWorkingDirChange && (
              <button
                type="button"
                className={`${control} mt-4 bg-text-primary px-4 py-2.5 text-sm text-background-primary`}
                onClick={() => void chooseFolder()}
              >
                {intl.formatMessage(messages.folder)}
              </button>
            )}
          </div>
        ) : null}
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-border-danger p-3 text-sm leading-relaxed"
          >
            <p>{intl.formatMessage(messages.error)}</p>
            <button
              type="button"
              className={`${control} mt-2 px-2 py-1.5 underline`}
              disabled={loading}
              onClick={() => void refresh()}
            >
              {intl.formatMessage(messages.retry)}
            </button>
          </div>
        )}
        {loading && !snapshot && (
          <p role="status" className="py-6 text-sm">
            {intl.formatMessage(messages.loading)}
          </p>
        )}
        {snapshot && (
          <>
            <div className="mb-5 rounded-lg border border-border-primary bg-background-secondary p-3">
              <p className="text-xs font-medium">{intl.formatMessage(messages.next)}</p>
              <button
                type="button"
                className={`${control} mt-2 flex w-full items-center justify-between gap-2 bg-text-primary px-3 py-2.5 text-left text-sm text-background-primary`}
                onClick={() => prepare(nextAction)}
              >
                {intl.formatMessage(ACTION_LABELS[nextAction])}
                <ArrowRight aria-hidden="true" className="h-4 w-4 shrink-0" />
              </button>
              <p className="mt-3 text-xs leading-relaxed">
                {intl.formatMessage(messages.coverage, { count: foundStages.length })}
              </p>
              <p className="mt-1 text-xs leading-relaxed">{intl.formatMessage(messages.caution)}</p>
            </div>
            {notice && (
              <p
                role="status"
                className="mb-4 rounded-md border border-border-info px-3 py-2 text-xs leading-relaxed"
              >
                {intl.formatMessage(messages.added)}
              </p>
            )}
            {(snapshot.limited || snapshot.unreadableDirectories > 0) && (
              <p role="status" className="mb-4 text-xs leading-relaxed">
                {intl.formatMessage(messages.partial)}
              </p>
            )}
            <ol className="space-y-5">
              {PROJECT_STAGES.map((stage, index) => {
                const files = snapshot.artifacts.filter((file) => file.stage === stage);
                const isExpanded = expanded.includes(stage);
                return (
                  <li key={stage}>
                    <div className="flex items-baseline gap-2 border-b border-border-primary pb-2">
                      <span className="font-mono text-xs tabular-nums">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <h3 className="flex-1 text-sm font-medium">
                        {intl.formatMessage(messages[stage])}
                      </h3>
                      <span className="text-xs tabular-nums">
                        {intl.formatMessage(messages.count, { count: files.length })}
                      </span>
                    </div>
                    {files.length === 0 && (
                      <p className="py-2 text-xs">{intl.formatMessage(messages.missing)}</p>
                    )}
                    {files.slice(0, isExpanded ? files.length : 3).map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        className={`${control} mt-1 flex w-full items-start gap-2 px-2 py-2 text-left hover:bg-background-tertiary`}
                        title={file.relativePath}
                        onClick={() => onOpenFile(file)}
                      >
                        <FileText aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 break-all font-mono text-xs leading-relaxed">
                          {file.relativePath}
                          {file.size === 0 && (
                            <span className="ml-2 font-sans">
                              ({intl.formatMessage(messages.emptyFile)})
                            </span>
                          )}
                        </span>
                      </button>
                    ))}
                    {files.length > 3 && (
                      <button
                        type="button"
                        className={`${control} px-2 py-1.5 text-xs underline`}
                        aria-expanded={isExpanded}
                        onClick={() =>
                          setExpanded((current) =>
                            isExpanded
                              ? current.filter((item) => item !== stage)
                              : [...current, stage]
                          )
                        }
                      >
                        {intl.formatMessage(isExpanded ? messages.collapse : messages.expand, {
                          count: files.length,
                        })}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`${control} mt-1 inline-flex items-center gap-1.5 px-2 py-1.5 text-xs hover:bg-background-tertiary`}
                      onClick={() => prepare(stage)}
                    >
                      <ArrowRight aria-hidden="true" className="h-3 w-3" />
                      {intl.formatMessage(ACTION_LABELS[stage])}
                    </button>
                  </li>
                );
              })}
            </ol>
            <button
              type="button"
              className={`${control} mt-6 flex w-full items-center gap-2 border border-border-primary px-3 py-2.5 text-sm hover:bg-background-tertiary`}
              onClick={() => prepare('review')}
            >
              <Search aria-hidden="true" className="h-4 w-4" />
              {intl.formatMessage(messages.actionReview)}
            </button>
          </>
        )}
      </div>
      {workingDir && (
        <div className="flex flex-wrap gap-2 border-t border-border-primary px-3 py-2">
          <button
            type="button"
            className={`${control} inline-flex items-center gap-1.5 px-2 py-2 text-xs hover:bg-background-tertiary`}
            onClick={() => {
              void window.electron
                .workspaceOpenPath(workingDir)
                .then((failure) => {
                  if (failure) setError(true);
                })
                .catch(() => setError(true));
            }}
          >
            <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
            {intl.formatMessage(messages.openFolder)}
          </button>
          {onOpenEnvironment && (
            <button
              type="button"
              className={`${control} inline-flex items-center gap-1.5 px-2 py-2 text-xs hover:bg-background-tertiary`}
              onClick={onOpenEnvironment}
            >
              <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
              {intl.formatMessage(messages.environment)}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  FileText,
  FolderOpen,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  X,
} from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import type { ArtifactIndex } from '../../types/artifactStatus';
import type { ProjectSnapshot, ProjectStage, WorkspaceEntry } from '../../types/workspaceApi';
import { getArtifactEntry } from '../../utils/artifactStatus';
import { buildProjectAction, PROJECT_STAGES, type ProjectAction } from '../../utils/projectActions';
import { usePanelAutoRefresh } from '../../hooks/usePanelAutoRefresh';
import CollabHostPanel from '../collab/CollabHostPanel';
import ArtifactDetailsDialog, { isModifiedOutside } from './ArtifactDetailsDialog';
import ArtifactStatusBadge from './ArtifactStatusBadge';

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
  collab: { id: 'projectPanel.collab', defaultMessage: 'Collaborate' },
  solution: { id: 'projectPanel.solution', defaultMessage: 'Reference approach' },
  solutionClose: { id: 'projectPanel.solutionClose', defaultMessage: 'Close' },
  solutionFailed: {
    id: 'projectPanel.solutionFailed',
    defaultMessage: 'Could not open the reference approach',
  },
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
  checkStale: { id: 'runs.checkStale', defaultMessage: 'Check for outdated results' },
  checkFailed: {
    id: 'runs.checkFailed',
    defaultMessage: 'Could not check the results. Try again.',
  },
  indexFailed: {
    id: 'runs.indexFailed',
    defaultMessage: 'Could not load the status of the results.',
  },
  modifiedOutsideHint: {
    id: 'runs.modifiedOutsideHint',
    defaultMessage: 'Changed outside ModelForge',
  },
  otherTitle: { id: 'runs.otherTitle', defaultMessage: 'Other tracked results' },
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
  const [showCollab, setShowCollab] = useState(false);
  const [solution, setSolution] = useState<{ question: string; content: string }[] | null>(null);
  const [solutionError, setSolutionError] = useState(false);
  const [artifacts, setArtifacts] = useState<{ directory: string; index: ArtifactIndex } | null>(
    null
  );
  const [artifactsFailed, setArtifactsFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [selectedArtifact, setSelectedArtifact] = useState<string | null>(null);
  const currentDir = useRef(workingDir);

  // The reference approach is read-only content from the bundled example (requirement 9.8).
  const openSolution = async (exampleId: string) => {
    setSolutionError(false);
    try {
      const result = await window.electron.exampleOpenSolution(exampleId);
      if (result.ok) {
        setSolution(result.data.sections);
      } else {
        setSolutionError(true);
      }
    } catch {
      setSolutionError(true);
    }
  };
  const sequence = useRef(0);
  const pending = useRef<{ id: number; directory: string } | null>(null);
  const snapshot = loaded?.directory === workingDir ? loaded.snapshot : null;
  const artifactIndex = artifacts?.directory === workingDir ? artifacts.index : null;
  const projectRoot = snapshot?.root ?? null;

  // Artifact_Status (requirements 16, 17): opening the Project runs a detection pass in the main
  // process; later changes arrive through `onArtifactsChanged`.
  const loadArtifacts = useCallback(async (directory: string) => {
    try {
      const result = await window.electron.artifactsGet(directory);
      if (currentDir.current !== directory) return;
      if (result.ok) {
        setArtifacts({ directory, index: result.data });
        setArtifactsFailed(false);
      } else {
        setArtifactsFailed(true);
      }
    } catch {
      if (currentDir.current === directory) setArtifactsFailed(true);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (!active || !workingDir || pending.current?.directory === workingDir) return;
    const id = ++sequence.current;
    pending.current = { id, directory: workingDir };
    setLoading(true);
    setError(false);
    try {
      const next = await window.electron.workspaceScanProject(workingDir);
      if (sequence.current === id) {
        setLoaded({ directory: workingDir, snapshot: next });
        void loadArtifacts(workingDir);
      }
    } catch {
      if (sequence.current === id) setError(true);
    } finally {
      if (pending.current?.id === id) pending.current = null;
      if (sequence.current === id) setLoading(false);
    }
  }, [workingDir, active, loadArtifacts]);

  useEffect(() => {
    currentDir.current = workingDir;
  }, [workingDir]);
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
    setSelectedArtifact(null);
    setArtifactsFailed(false);
    setCheckFailed(false);
  }, [workingDir]);
  useEffect(() => {
    if (!workingDir) return undefined;
    return window.electron.onArtifactsChanged((event) => {
      if (event.projectDir === workingDir || event.projectDir === projectRoot) {
        setArtifacts({ directory: workingDir, index: event.index });
      }
    });
  }, [workingDir, projectRoot]);
  usePanelAutoRefresh(active && isAgentActive, () => void refresh(), 5000);

  const checkStale = async () => {
    if (!workingDir) return;
    const directory = workingDir;
    setChecking(true);
    setCheckFailed(false);
    try {
      const result = await window.electron.artifactsCheckStale(directory);
      if (currentDir.current !== directory) return;
      if (result.ok) {
        setArtifacts({ directory, index: result.data });
        setArtifactsFailed(false);
      } else {
        setCheckFailed(true);
      }
    } catch {
      if (currentDir.current === directory) setCheckFailed(true);
    } finally {
      setChecking(false);
    }
  };
  const listedPaths = new Set(snapshot?.artifacts.map((file) => file.relativePath) ?? []);
  const otherEntries = artifactIndex
    ? Object.keys(artifactIndex.entries)
        .filter((path) => !listedPaths.has(path))
        .sort()
        .map((path) => artifactIndex.entries[path])
    : [];
  const selectedEntry =
    selectedArtifact && artifactIndex
      ? (getArtifactEntry(artifactIndex, selectedArtifact) ?? null)
      : null;
  const modifiedHint = (
    <p className="ml-7 mt-0.5 flex items-center gap-1 text-[11px] text-text-danger">
      <AlertTriangle aria-hidden="true" className="h-3 w-3 shrink-0" />
      {intl.formatMessage(messages.modifiedOutsideHint)}
    </p>
  );

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
            {artifactsFailed && !checkFailed && (
              <p className="mb-4 text-xs leading-relaxed text-text-danger">
                {intl.formatMessage(messages.indexFailed)}
              </p>
            )}
            {checkFailed && (
              <p role="alert" className="mb-4 text-xs leading-relaxed text-text-danger">
                {intl.formatMessage(messages.checkFailed)}
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
                    {files.slice(0, isExpanded ? files.length : 3).map((file) => {
                      const entry = artifactIndex
                        ? getArtifactEntry(artifactIndex, file.relativePath)
                        : undefined;
                      return (
                        <div key={file.path} className="mt-1">
                          <div className="flex items-start gap-1">
                            <button
                              type="button"
                              className={`${control} flex min-w-0 flex-1 items-start gap-2 px-2 py-2 text-left hover:bg-background-tertiary`}
                              title={file.relativePath}
                              onClick={() => onOpenFile(file)}
                            >
                              <FileText
                                aria-hidden="true"
                                className="mt-0.5 h-3.5 w-3.5 shrink-0"
                              />
                              <span className="min-w-0 break-all font-mono text-xs leading-relaxed">
                                {file.relativePath}
                                {file.size === 0 && (
                                  <span className="ml-2 font-sans">
                                    ({intl.formatMessage(messages.emptyFile)})
                                  </span>
                                )}
                              </span>
                            </button>
                            {entry && (
                              <span className="mt-1.5 shrink-0">
                                <ArtifactStatusBadge
                                  status={entry.status}
                                  path={entry.path}
                                  onSelect={setSelectedArtifact}
                                />
                              </span>
                            )}
                          </div>
                          {isModifiedOutside(entry) && modifiedHint}
                        </div>
                      );
                    })}
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
            {otherEntries.length > 0 && (
              <section className="mt-5">
                <h3 className="border-b border-border-primary pb-2 text-sm font-medium">
                  {intl.formatMessage(messages.otherTitle)}
                </h3>
                <ul>
                  {otherEntries.map((entry) => (
                    <li key={entry.path} className="mt-1">
                      <div className="flex items-start gap-2 px-2 py-1.5">
                        <span className="min-w-0 flex-1 break-all font-mono text-xs leading-relaxed">
                          {entry.path}
                        </span>
                        <ArtifactStatusBadge
                          status={entry.status}
                          path={entry.path}
                          onSelect={setSelectedArtifact}
                        />
                      </div>
                      {isModifiedOutside(entry) && modifiedHint}
                    </li>
                  ))}
                </ul>
              </section>
            )}
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
          <button
            type="button"
            className={`${control} inline-flex items-center gap-1.5 px-2 py-2 text-xs hover:bg-background-tertiary`}
            disabled={checking}
            onClick={() => void checkStale()}
          >
            <ShieldCheck
              aria-hidden="true"
              className={`h-3.5 w-3.5 ${checking ? 'animate-pulse motion-reduce:animate-none' : ''}`}
            />
            {intl.formatMessage(messages.checkStale)}
          </button>
          {snapshot?.exampleId && (
            <button
              type="button"
              className={`${control} inline-flex items-center gap-1.5 px-2 py-2 text-xs hover:bg-background-tertiary`}
              onClick={() => void openSolution(snapshot.exampleId as string)}
            >
              <BookOpen aria-hidden="true" className="h-3.5 w-3.5" />
              {intl.formatMessage(messages.solution)}
            </button>
          )}
          <button
            type="button"
            className={`${control} inline-flex items-center gap-1.5 px-2 py-2 text-xs hover:bg-background-tertiary`}
            onClick={() => setShowCollab(true)}
          >
            <Settings2 aria-hidden="true" className="h-3.5 w-3.5" />
            {intl.formatMessage(messages.collab)}
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
      {showCollab && (
        <CollabHostPanel workingDir={workingDir} onClose={() => setShowCollab(false)} />
      )}
      {selectedArtifact && workingDir && (
        <ArtifactDetailsDialog
          workingDir={workingDir}
          path={selectedArtifact}
          entry={selectedEntry}
          onClose={() => setSelectedArtifact(null)}
          onIndexChange={(index) => setArtifacts({ directory: workingDir, index })}
        />
      )}
      {(solution || solutionError) && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={intl.formatMessage(messages.solution)}
          className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-6"
        >
          <div className="flex max-h-full w-full max-w-md flex-col rounded-xl border border-border-secondary bg-background-primary">
            <div className="flex items-center justify-between border-b border-border-secondary px-4 py-3">
              <h2 className="text-sm font-semibold text-text-primary">
                {intl.formatMessage(messages.solution)}
              </h2>
              <button
                type="button"
                aria-label={intl.formatMessage(messages.solutionClose)}
                className={`${control} p-1 text-text-tertiary hover:text-text-primary`}
                onClick={() => {
                  setSolution(null);
                  setSolutionError(false);
                }}
              >
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {solutionError ? (
                <p className="text-xs text-text-danger">
                  {intl.formatMessage(messages.solutionFailed)}
                </p>
              ) : (
                solution?.map((section, index) => (
                  <section key={index} className="mb-4">
                    <h3 className="text-sm font-medium text-text-primary">{section.question}</h3>
                    <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-text-secondary">
                      {section.content}
                    </pre>
                  </section>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FileText,
  ClipboardList,
  FolderOpen,
  Frame,
  History,
  Terminal as TerminalIcon,
  Wand2,
  X,
} from 'lucide-react';
import type { WorkspaceEntry } from '../../types/workspaceApi';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import WorkspaceFilesPanel from './WorkspaceFilesPanel';
import VersionsPanel from './VersionsPanel';
import EnvironmentPanel from './EnvironmentPanel';
import FiguresPanel from './FiguresPanel';
import DiagramsPanel from './DiagramsPanel';
import ProjectPanel from './ProjectPanel';

export type WorkspaceTab =
  'project' | 'files' | 'versions' | 'environment' | 'figures' | 'diagrams';

const i18n = defineMessages({
  project: { id: 'workspacePanel.project', defaultMessage: 'Project' },
  files: { id: 'workspacePanel.files', defaultMessage: 'Files' },
  versions: { id: 'workspacePanel.versions', defaultMessage: 'Versions' },
  environment: { id: 'workspacePanel.environment', defaultMessage: 'Environment' },
  figures: { id: 'workspacePanel.figures', defaultMessage: 'Figures' },
  diagrams: { id: 'workspacePanel.diagrams', defaultMessage: 'Diagrams' },
  close: { id: 'workspacePanel.close', defaultMessage: 'Close panel' },
  resize: { id: 'workspacePanel.resize', defaultMessage: 'Drag to resize' },
  noWorkingDir: {
    id: 'workspacePanel.noWorkingDir',
    defaultMessage:
      'This session has no working directory yet. Pick one to browse files and run commands.',
  },
});

const TABS: { id: WorkspaceTab; icon: typeof FileText; labelKey: keyof typeof i18n }[] = [
  { id: 'project', icon: ClipboardList, labelKey: 'project' },
  { id: 'files', icon: FileText, labelKey: 'files' },
  { id: 'versions', icon: History, labelKey: 'versions' },
  { id: 'environment', icon: TerminalIcon, labelKey: 'environment' },
  { id: 'figures', icon: Wand2, labelKey: 'figures' },
  { id: 'diagrams', icon: Frame, labelKey: 'diagrams' },
];

const MIN_WIDTH = 320;
const MAX_WIDTH = 900;
const DEFAULT_WIDTH = 420;
const WIDTH_STORAGE_KEY = 'modelforge.workspacePanelWidth';

interface WorkspacePanelProps {
  tab: WorkspaceTab;
  onClose: () => void;
  workingDir: string;
  isOpen?: boolean;
  isAgentActive?: boolean;
  /** The centre editor column is open, so the tree only picks files. */
  isEditorOpen?: boolean;
  onOpenFile?: (entry: WorkspaceEntry) => void;
  onRevealFile: (entry: WorkspaceEntry) => void;
  onCompose: (text: string) => void;
  onWorkingDirChange?: (dir: string) => void | Promise<void>;
  onSelectTab: (tab: WorkspaceTab) => void;
}

export default function WorkspacePanel({
  tab,
  onClose,
  workingDir,
  isOpen = true,
  isAgentActive = false,
  isEditorOpen = false,
  onOpenFile,
  onRevealFile,
  onCompose,
  onWorkingDirChange,
  onSelectTab,
}: WorkspacePanelProps) {
  const intl = useIntl();
  const [width, setWidth] = useState(() => {
    const stored = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    return stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
  });
  const resizingRef = useRef(false);
  const [visitedTabs, setVisitedTabs] = useState<Set<WorkspaceTab>>(() => new Set([tab]));

  // Panels stay mounted once visited so switching tabs keeps the shell session alive.
  useEffect(() => {
    setVisitedTabs((current) => (current.has(tab) ? current : new Set(current).add(tab)));
  }, [tab]);

  useEffect(() => {
    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
  }, [width]);

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!resizingRef.current) return;
      const next = window.innerWidth - event.clientX;
      setWidth(Math.min(Math.max(next, MIN_WIDTH), MAX_WIDTH));
    };
    const handleUp = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, []);

  const startResize = useCallback(() => {
    resizingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const activeTab = TABS.find((entry) => entry.id === tab) ?? TABS[0];
  const ActiveIcon = activeTab.icon;

  return (
    <div
      className={cn('flex h-full min-h-0 shrink-0', !isOpen && 'hidden')}
      style={{
        // The editor column is the one that needs room, so the panel yields on narrow windows.
        width: isEditorOpen
          ? Math.min(width, Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.28)))
          : width,
      }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        aria-valuenow={width}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          setWidth((current) =>
            Math.min(
              MAX_WIDTH,
              Math.max(MIN_WIDTH, current + (event.key === 'ArrowLeft' ? 24 : -24))
            )
          );
        }}
        aria-label={intl.formatMessage(i18n.resize)}
        onMouseDown={startResize}
        className="w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-background-info/40 focus-visible:bg-background-info focus-visible:outline-none"
      />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-border-primary bg-background-primary">
        <div className="flex items-center gap-1.5 border-b border-border-primary px-2 py-1">
          <ActiveIcon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
          <span className="truncate text-[11px] text-text-secondary">
            {intl.formatMessage(i18n[activeTab.labelKey])}
          </span>
          <button
            type="button"
            onClick={onClose}
            title={intl.formatMessage(i18n.close)}
            aria-label={intl.formatMessage(i18n.close)}
            className="ml-auto rounded p-1 text-text-tertiary transition-colors hover:bg-background-tertiary hover:text-text-primary"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1">
          {visitedTabs.has('project') && (
            <div className={cn('h-full min-h-0', tab !== 'project' && 'hidden')}>
              <ProjectPanel
                workingDir={workingDir}
                active={isOpen && tab === 'project'}
                isAgentActive={isAgentActive}
                onCompose={onCompose}
                onOpenFile={onRevealFile}
                onWorkingDirChange={onWorkingDirChange}
                onOpenEnvironment={() => onSelectTab('environment')}
              />
            </div>
          )}
          {!workingDir ? (
            <div
              className={cn(
                'flex h-full flex-col items-center justify-center gap-2 px-4 text-center',
                tab === 'project' && 'hidden'
              )}
            >
              <FolderOpen className="h-6 w-6 text-text-tertiary" />
              <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.noWorkingDir)}</p>
            </div>
          ) : (
            <>
              {visitedTabs.has('files') && (
                <div className={cn('h-full min-h-0', tab !== 'files' && 'hidden')}>
                  <WorkspaceFilesPanel
                    workingDir={workingDir}
                    isAgentActive={isAgentActive}
                    isWide={width >= 720}
                    treeOnly={isEditorOpen}
                    onOpenFile={onOpenFile}
                  />
                </div>
              )}
              {visitedTabs.has('versions') && (
                <div className={cn('h-full min-h-0', tab !== 'versions' && 'hidden')}>
                  <VersionsPanel workingDir={workingDir} />
                </div>
              )}
              {visitedTabs.has('environment') && (
                <div className={cn('h-full min-h-0', tab !== 'environment' && 'hidden')}>
                  <EnvironmentPanel workingDir={workingDir} />
                </div>
              )}
              {visitedTabs.has('figures') && (
                <div className={cn('h-full min-h-0', tab !== 'figures' && 'hidden')}>
                  <FiguresPanel />
                </div>
              )}
              {visitedTabs.has('diagrams') && (
                <div className={cn('h-full min-h-0', tab !== 'diagrams' && 'hidden')}>
                  <DiagramsPanel workingDir={workingDir} isAgentActive={isAgentActive} />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

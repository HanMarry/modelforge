import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceEntry } from '../../types/workspaceApi';
import { AppEvents } from '../../constants/events';
import type { WorkspaceFileLocation } from './featurePanelProps';
import type { WorkspaceTab } from './WorkspacePanel';

/** The file in the editor column, with the line or page a finding points at, if any. */
export interface ActiveWorkspaceFile extends WorkspaceEntry {
  location?: WorkspaceFileLocation;
}

const OPEN_KEY = 'modelforge.workspacePanelOpen';
const TAB_KEY = 'modelforge.workspacePanelTab';

/** Every tab, in toolbar order; a stored tab outside this list falls back to `project`. */
const RESTORABLE_TABS: readonly WorkspaceTab[] = [
  'project',
  'files',
  'versions',
  'environment',
  'figures',
  'diagrams',
  'browser',
  'paperCheck',
  'review',
  'compare',
];

export interface WorkspacePanelState {
  /** Right-hand panel (tree, versions, environment, figures, diagrams). */
  isOpen: boolean;
  tab: WorkspaceTab;
  /** True once the panel has been opened, so the shell session can survive closing it. */
  isMounted: boolean;
  /**
   * Centre editor column. It is a separate column rather than a wider panel: the file tree
   * stays on the right while the preview gets real width.
   */
  isEditorOpen: boolean;
  activeFile: ActiveWorkspaceFile | null;
  openFile: (entry: WorkspaceEntry) => void;
  /**
   * Shows the file in the editor column. With a `location` (paper check and review findings)
   * the editor scrolls to that line or page and the current tab stays selected, so the list of
   * findings remains next to the file; without one the file tree is shown.
   */
  revealFile: (entry: WorkspaceEntry, location?: WorkspaceFileLocation) => void;
  clearActiveFile: () => void;
  setTab: (tab: WorkspaceTab) => void;
  selectTab: (tab: WorkspaceTab) => void;
  toggleEditor: () => void;
  openEditor: () => void;
  closeEditor: () => void;
  toggle: () => void;
  close: () => void;
}

/**
 * Panel state shared by the home hub and the chat view. Both read the same
 * localStorage keys, so opening the files panel from one place carries over to
 * the other, and only one of them is mounted at a time.
 */
export function useWorkspacePanel(enabled = true): WorkspacePanelState {
  const [isOpen, setIsOpen] = useState(() => window.localStorage.getItem(OPEN_KEY) === 'true');
  const [tab, setTabState] = useState<WorkspaceTab>(() => {
    const stored = window.localStorage.getItem(TAB_KEY);
    return stored && (RESTORABLE_TABS as readonly string[]).includes(stored)
      ? (stored as WorkspaceTab)
      : 'project';
  });
  const [isMounted, setIsMounted] = useState(isOpen);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [activeFile, setActiveFile] = useState<ActiveWorkspaceFile | null>(null);

  useEffect(() => {
    window.localStorage.setItem(OPEN_KEY, String(isOpen));
  }, [isOpen]);

  useEffect(() => {
    window.localStorage.setItem(TAB_KEY, tab);
  }, [tab]);

  const setTab = useCallback((next: WorkspaceTab) => setTabState(next), []);

  // Toolbar buttons only ever open or switch: a click that closes the panel reads as
  // "nothing happened". Closing is the dedicated toggle button's job.
  const selectTab = useCallback((next: WorkspaceTab) => {
    setIsMounted(true);
    setTabState(next);
    setIsOpen(true);
  }, []);

  const openFile = useCallback((entry: WorkspaceEntry) => {
    setActiveFile(entry);
  }, []);

  const clearActiveFile = useCallback(() => setActiveFile(null), []);

  /** Artifact cards in the transcript and findings lists reveal their file in the editor column. */
  const revealFile = useCallback((entry: WorkspaceEntry, location?: WorkspaceFileLocation) => {
    // A fresh object each time, so revealing the same place again scrolls there again.
    setActiveFile(location === undefined ? entry : { ...entry, location: { ...location } });
    setIsMounted(true);
    if (location === undefined) {
      setTabState('files');
    }
    setIsOpen(true);
    setIsEditorOpen(true);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleOpenFile = (event: Event) => {
      const detail = (
        event as CustomEvent<{ entry?: WorkspaceEntry; location?: WorkspaceFileLocation }>
      ).detail;
      if (detail?.entry) revealFile(detail.entry, detail.location);
    };
    window.addEventListener(AppEvents.OPEN_WORKSPACE_FILE, handleOpenFile);
    return () => window.removeEventListener(AppEvents.OPEN_WORKSPACE_FILE, handleOpenFile);
  }, [enabled, revealFile]);

  const toggleEditor = useCallback(() => {
    setIsMounted(true);
    setIsEditorOpen((current) => !current);
  }, []);

  /** File-tree clicks land in the editor when it is open, so opening it also reveals the tree. */
  const openEditor = useCallback(() => {
    setIsMounted(true);
    setTabState('files');
    setIsOpen(true);
    setIsEditorOpen(true);
  }, []);

  const closeEditor = useCallback(() => setIsEditorOpen(false), []);

  const toggle = useCallback(() => {
    setIsMounted(true);
    setIsOpen((current) => !current);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  return {
    isOpen,
    tab,
    isMounted,
    isEditorOpen,
    activeFile,
    openFile,
    revealFile,
    clearActiveFile,
    setTab,
    selectTab,
    toggleEditor,
    openEditor,
    closeEditor,
    toggle,
    close,
  };
}

import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceEntry } from '../../types/workspaceApi';
import { AppEvents } from '../../constants/events';
import type { WorkspaceTab } from './WorkspacePanel';

const OPEN_KEY = 'modelforge.workspacePanelOpen';
const TAB_KEY = 'modelforge.workspacePanelTab';

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
  activeFile: WorkspaceEntry | null;
  openFile: (entry: WorkspaceEntry) => void;
  revealFile: (entry: WorkspaceEntry) => void;
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
    return stored &&
      ['project', 'files', 'versions', 'environment', 'figures', 'diagrams'].includes(stored)
      ? (stored as WorkspaceTab)
      : 'project';
  });
  const [isMounted, setIsMounted] = useState(isOpen);
  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [activeFile, setActiveFile] = useState<WorkspaceEntry | null>(null);

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

  /** Artifact cards in the transcript reveal their file in the editor column. */
  const revealFile = useCallback((entry: WorkspaceEntry) => {
    setActiveFile(entry);
    setIsMounted(true);
    setTabState('files');
    setIsOpen(true);
    setIsEditorOpen(true);
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const handleOpenFile = (event: Event) => {
      const detail = (event as CustomEvent<{ entry?: WorkspaceEntry }>).detail;
      if (detail?.entry) revealFile(detail.entry);
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

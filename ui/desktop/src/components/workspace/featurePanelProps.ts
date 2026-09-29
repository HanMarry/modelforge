import type { WorkspaceEntry } from '../../types/workspaceApi';

/**
 * Where in a file a panel wants the editor to land (paper check and review findings). The editor
 * ignores it until the paper-check branch adds line and page jumps (layer-c-contract-desktop.md).
 */
export interface WorkspaceFileLocation {
  /** 1-based line in a source file. */
  line?: number;
  /** 1-based page in a PDF. */
  page?: number;
}

/**
 * Props `WorkspacePanel` passes to the layer C tabs (paper check, mock review, run comparison).
 * Owned by the C0 skeleton; the tabs themselves belong to their feature branches.
 */
export interface WorkspaceFeaturePanelProps {
  /** Project root; the tabs only mount once the session has one. */
  workingDir: string;
  /** The panel is open and this tab is the selected one. */
  active: boolean;
  isAgentActive: boolean;
  /** Opens the file in the editor column. */
  onOpenFile: (entry: WorkspaceEntry, location?: WorkspaceFileLocation) => void;
  /** Puts text into the chat composer. */
  onCompose: (text: string) => void;
}

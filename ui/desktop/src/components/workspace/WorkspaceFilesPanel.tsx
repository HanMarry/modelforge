import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  Eye,
  FileCode2,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Pencil,
  RefreshCw,
  Save,
  Search,
  SquareArrowOutUpRight,
} from 'lucide-react';
import type { WorkspaceEntry, WorkspaceFileReadResult } from '../../types/workspaceApi';
import { cn } from '../../utils';
import { usePanelAutoRefresh } from '../../hooks/usePanelAutoRefresh';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import FilePreview, { type PreviewBytes } from './preview/FilePreview';
import {
  extensionOf,
  isEditableKind,
  isImageExtension,
  previewKindFor,
} from './preview/previewKind';

const i18n = defineMessages({
  incompleteFile: {
    id: 'workspaceFiles.incompleteFile',
    defaultMessage:
      'Large file preview is read-only. Open it externally to edit the complete file.',
  },
  empty: {
    id: 'workspaceFiles.empty',
    defaultMessage: 'No files in this folder',
  },
  loadFailed: {
    id: 'workspaceFiles.loadFailed',
    defaultMessage: 'Failed to load folder',
  },
  binary: {
    id: 'workspaceFiles.binary',
    defaultMessage: 'Binary file - open it with an external program',
  },
  truncated: {
    id: 'workspaceFiles.truncated',
    defaultMessage: 'Showing the first portion of a large file',
  },
  back: {
    id: 'workspaceFiles.back',
    defaultMessage: 'Back to files',
  },
  edit: {
    id: 'workspaceFiles.edit',
    defaultMessage: 'Edit',
  },
  preview: {
    id: 'workspaceFiles.preview',
    defaultMessage: 'Preview',
  },
  save: {
    id: 'workspaceFiles.save',
    defaultMessage: 'Save',
  },
  saved: {
    id: 'workspaceFiles.saved',
    defaultMessage: 'Saved',
  },
  saveFailed: {
    id: 'workspaceFiles.saveFailed',
    defaultMessage: 'Save failed',
  },
  openWith: {
    id: 'workspaceFiles.openWith',
    defaultMessage: 'Open with',
  },
  copyPath: {
    id: 'workspaceFiles.copyPath',
    defaultMessage: 'Copy path',
  },
  copied: {
    id: 'workspaceFiles.copied',
    defaultMessage: 'Copied',
  },
  reveal: {
    id: 'workspaceFiles.reveal',
    defaultMessage: 'Show in file manager',
  },
  loading: {
    id: 'workspaceFiles.loading',
    defaultMessage: 'Loading…',
  },
  search: {
    id: 'workspaceFiles.search',
    defaultMessage: 'Search files',
  },
  noMatches: {
    id: 'workspaceFiles.noMatches',
    defaultMessage: 'No matching file',
  },
  openFileTitle: {
    id: 'workspaceFiles.openFileTitle',
    defaultMessage: 'Open a file',
  },
  openFileHint: {
    id: 'workspaceFiles.openFileHint',
    defaultMessage: 'Pick a file from the workspace tree on the left',
  },
  refresh: {
    id: 'workspaceFiles.refresh',
    defaultMessage: 'Refresh',
  },
});

function FileIcon({ entry }: { entry: WorkspaceEntry }) {
  const className = 'h-3.5 w-3.5 shrink-0';
  if (entry.isDirectory) {
    return <Folder className={cn(className, 'text-text-tertiary')} />;
  }
  const extension = extensionOf(entry.name);
  if (isImageExtension(entry.name)) {
    return <ImageIcon className={cn(className, 'text-text-info')} />;
  }
  if (extension === '.csv' || extension === '.xlsx' || extension === '.xls') {
    return <FileSpreadsheet className={cn(className, 'text-text-success')} />;
  }
  if (extension === '.py' || extension === '.ts' || extension === '.tsx' || extension === '.rs') {
    return <FileCode2 className={cn(className, 'text-text-info')} />;
  }
  return <FileText className={cn(className, 'text-text-secondary')} />;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativePath(rootDir: string, targetPath: string): string {
  const root = rootDir.replace(/[\\/]+$/, '');
  return targetPath.startsWith(root) ? targetPath.slice(root.length + 1) : targetPath;
}

interface TreeRowProps {
  entry: WorkspaceEntry;
  depth: number;
  expanded: Set<string>;
  childrenByDir: Map<string, WorkspaceEntry[]>;
  loadingDirs: Set<string>;
  onToggle: (entry: WorkspaceEntry) => void;
  onSelectFile: (entry: WorkspaceEntry) => void;
  selectedPath: string | null;
}

function TreeRow({
  entry,
  depth,
  expanded,
  childrenByDir,
  loadingDirs,
  onToggle,
  onSelectFile,
  selectedPath,
}: TreeRowProps) {
  const intl = useIntl();
  const isExpanded = expanded.has(entry.path);
  const children = childrenByDir.get(entry.path);

  return (
    <>
      <button
        type="button"
        onClick={() => (entry.isDirectory ? onToggle(entry) : onSelectFile(entry))}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors',
          selectedPath === entry.path
            ? 'bg-background-tertiary text-text-primary'
            : 'text-text-secondary hover:bg-background-tertiary/60 hover:text-text-primary'
        )}
        title={entry.path}
      >
        {entry.isDirectory ? (
          <ChevronRight
            className={cn('h-3 w-3 shrink-0 transition-transform', isExpanded && 'rotate-90')}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <FileIcon entry={entry} />
        <span className="truncate">{entry.name}</span>
        {!entry.isDirectory && (
          <span className="ml-auto shrink-0 font-mono text-[10px] text-text-tertiary">
            {formatSize(entry.size)}
          </span>
        )}
      </button>

      {entry.isDirectory && isExpanded && (
        <>
          {loadingDirs.has(entry.path) && (
            <div
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              className="py-1 text-xs text-text-tertiary"
            >
              {intl.formatMessage(i18n.loading)}
            </div>
          )}
          {children?.length === 0 && !loadingDirs.has(entry.path) && (
            <div
              style={{ paddingLeft: `${(depth + 1) * 12 + 8}px` }}
              className="py-1 text-xs text-text-tertiary"
            >
              {intl.formatMessage(i18n.empty)}
            </div>
          )}
          {children?.map((child) => (
            <TreeRow
              key={child.path}
              entry={child}
              depth={depth + 1}
              expanded={expanded}
              childrenByDir={childrenByDir}
              loadingDirs={loadingDirs}
              onToggle={onToggle}
              onSelectFile={onSelectFile}
              selectedPath={selectedPath}
            />
          ))}
        </>
      )}
    </>
  );
}

interface WorkspaceFilesPanelProps {
  workingDir: string;
  isAgentActive?: boolean;
  isWide?: boolean;
  /** Tree only: the centre editor column renders the preview instead. */
  treeOnly?: boolean;
  onOpenFile?: (entry: WorkspaceEntry) => void;
}

export default function WorkspaceFilesPanel({
  workingDir,
  isAgentActive = false,
  isWide = false,
  treeOnly = false,
  onOpenFile,
}: WorkspaceFilesPanelProps) {
  const intl = useIntl();
  const [childrenByDir, setChildrenByDir] = useState<Map<string, WorkspaceEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<WorkspaceEntry | null>(null);
  const [file, setFile] = useState<WorkspaceFileReadResult | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null);
  const [bytes, setBytes] = useState<PreviewBytes | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const selectionSequence = useRef(0);
  useEffect(() => {
    selectionSequence.current += 1;
    setSelected(null);
    setFile(null);
    setIsEditing(false);
    setPreviewLoading(false);
    return () => {
      selectionSequence.current += 1;
    };
  }, [workingDir]);
  const [filter, setFilter] = useState('');
  const [searchResults, setSearchResults] = useState<WorkspaceEntry[]>([]);
  const [searching, setSearching] = useState(false);

  const loadDirectory = useCallback(async (dirPath: string) => {
    setLoadingDirs((current) => new Set(current).add(dirPath));
    try {
      const entries = await window.electron.workspaceListDirectory(dirPath);
      setChildrenByDir((current) => new Map(current).set(dirPath, entries));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingDirs((current) => {
        const next = new Set(current);
        next.delete(dirPath);
        return next;
      });
    }
  }, []);

  const refresh = useCallback(() => {
    setChildrenByDir(new Map());
    setExpanded(new Set());
    void loadDirectory(workingDir);
  }, [loadDirectory, workingDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Debounced workspace-wide search: the tree only holds expanded directories, so
  // finding a file the user has never drilled into needs a real scan.
  useEffect(() => {
    const query = filter.trim();
    let cancelled = false;
    setSearchResults([]);
    if (!query) {
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const results = await window.electron.workspaceSearchFiles(workingDir, query);
        if (!cancelled) setSearchResults(results);
      } catch (searchError) {
        if (!cancelled)
          setError(searchError instanceof Error ? searchError.message : String(searchError));
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [filter, workingDir]);

  // Silent refresh keeps the expanded tree open, so the panel can follow the agent
  // without collapsing everything the user just drilled into.
  const refreshLoadedDirs = useCallback(async () => {
    const dirs = [workingDir, ...expanded];
    const results = await Promise.all(
      dirs.map(
        async (dirPath) => [dirPath, await window.electron.workspaceListDirectory(dirPath)] as const
      )
    );
    setChildrenByDir((current) => {
      const next = new Map(current);
      for (const [dirPath, entries] of results) next.set(dirPath, entries);
      return next;
    });
  }, [expanded, workingDir]);

  usePanelAutoRefresh(isAgentActive, () => void refreshLoadedDirs());

  const handleToggle = useCallback(
    (entry: WorkspaceEntry) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
          if (!childrenByDir.has(entry.path)) void loadDirectory(entry.path);
        }
        return next;
      });
    },
    [childrenByDir, loadDirectory]
  );

  const handleSelectFile = useCallback(
    async (entry: WorkspaceEntry) => {
      const request = ++selectionSequence.current;
      setSelected(entry);
      onOpenFile?.(entry);

      // The editor column owns loading and rendering while it is open.
      if (treeOnly) return;

      setIsEditing(false);
      setStatus(null);
      setImageDataUrl(null);
      setBytes(null);
      setFile(null);
      setPreviewLoading(true);

      try {
        const kind = previewKindFor(entry.name);

        if (kind === 'image') {
          const binary = await window.electron.workspaceReadBinary(entry.path);
          if (request !== selectionSequence.current) return;
          setImageDataUrl(binary.dataUrl);
          setBytes({ base64: null, size: binary.size, error: binary.error });
          setDraft('');
          return;
        }

        if (kind === 'pdf' || kind === 'spreadsheet' || kind === 'binary') {
          const data = await window.electron.workspaceReadBytes(entry.path);
          if (request !== selectionSequence.current) return;
          setBytes(data);
          setDraft('');
          return;
        }

        const result = await window.electron.workspaceReadFile(entry.path);
        if (request !== selectionSequence.current) return;
        setFile(result);
        setDraft(result?.content ?? '');
      } catch (readError) {
        if (request !== selectionSequence.current) return;
        setBytes({
          base64: null,
          size: entry.size,
          error: readError instanceof Error ? readError.message : String(readError),
        });
      } finally {
        if (request === selectionSequence.current) setPreviewLoading(false);
      }
    },
    [onOpenFile, treeOnly]
  );

  const handleSave = useCallback(async () => {
    if (!selected || !file || file.truncated || file.binary || file.error || previewLoading) return;
    const request = selectionSequence.current;
    const result = await window.electron.workspaceWriteFile(selected.path, draft);
    if (request !== selectionSequence.current) return;
    setStatus(result.ok ? intl.formatMessage(i18n.saved) : intl.formatMessage(i18n.saveFailed));
    if (result.ok) {
      setFile((current) => (current ? { ...current, content: draft } : current));
      setIsEditing(false);
    }
  }, [draft, file, intl, selected, previewLoading]);

  const rootEntries = childrenByDir.get(workingDir) ?? [];
  const kind = selected ? previewKindFor(selected.name) : 'text';
  const canEdit =
    isEditableKind(kind) &&
    Boolean(file && !file.truncated && !file.binary && !file.error) &&
    !previewLoading;

  const previewPane = selected ? (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1.5">
        {!isWide && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs text-text-secondary"
            onClick={() => {
              setSelected(null);
              setFile(null);
            }}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {intl.formatMessage(i18n.back)}
          </Button>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-text-primary" title={selected.path}>
          {selected.name}
        </span>
        {status && <span className="shrink-0 text-[10px] text-text-tertiary">{status}</span>}
        {canEdit && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-text-secondary"
              title={intl.formatMessage(isEditing ? i18n.preview : i18n.edit)}
              onClick={() => setIsEditing((current) => !current)}
            >
              {isEditing ? <Eye className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
            </Button>
            {isEditing && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-text-secondary"
                title={intl.formatMessage(i18n.save)}
                onClick={() => void handleSave()}
              >
                <Save className="h-3.5 w-3.5" />
              </Button>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.copyPath)}
          onClick={() => {
            void navigator.clipboard.writeText(selected.path);
            setStatus(intl.formatMessage(i18n.copied));
            window.setTimeout(() => setStatus(null), 1500);
          }}
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.reveal)}
          onClick={() => void window.electron.workspaceRevealPath(selected.path)}
        >
          <FolderOpen className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title="VS Code"
          onClick={() => void window.electron.workspaceOpenInEditor(selected.path, 'vscode')}
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </Button>
      </div>

      {file?.truncated && (
        <p
          role="status"
          className="border-b border-border-primary px-3 py-2 text-xs leading-relaxed text-text-primary"
        >
          {intl.formatMessage(i18n.incompleteFile)}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {isEditing ? (
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-background-primary p-3 font-mono text-xs text-text-primary focus:outline-none"
          />
        ) : (
          <FilePreview
            entry={selected}
            kind={kind}
            text={file}
            imageDataUrl={imageDataUrl}
            bytes={bytes}
            loading={previewLoading}
            onRetry={() => void handleSelectFile(selected)}
          />
        )}
      </div>
    </div>
  ) : (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <FileText className="h-7 w-7 text-text-tertiary" />
      <p className="text-xs text-text-primary">{intl.formatMessage(i18n.openFileTitle)}</p>
      <p className="text-[11px] text-text-tertiary">{intl.formatMessage(i18n.openFileHint)}</p>
    </div>
  );

  const treePane = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border-primary px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-text-tertiary" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={intl.formatMessage(i18n.search)}
            className="w-full rounded border border-border-secondary bg-background-primary py-0.5 pl-6 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.refresh)}
          onClick={refresh}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {filter.trim() ? (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {searching && searchResults.length === 0 && (
            <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.loading)}</p>
          )}
          {!searching && searchResults.length === 0 && (
            <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.noMatches)}</p>
          )}
          {searchResults.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => void handleSelectFile(entry)}
              title={entry.path}
              className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs text-text-secondary transition-colors hover:bg-background-tertiary/60 hover:text-text-primary"
            >
              <FileIcon entry={entry} />
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {relativePath(workingDir, entry.path)}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                {formatSize(entry.size)}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {error && <p className="p-3 text-xs text-red-500">{error}</p>}
          {!error && rootEntries.length === 0 && !loadingDirs.has(workingDir) && (
            <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
          )}
          {rootEntries.map((entry) => (
            <TreeRow
              key={entry.path}
              entry={entry}
              depth={0}
              expanded={expanded}
              childrenByDir={childrenByDir}
              loadingDirs={loadingDirs}
              onToggle={handleToggle}
              onSelectFile={(selectedEntry) => void handleSelectFile(selectedEntry)}
              selectedPath={selected?.path ?? null}
            />
          ))}
        </div>
      )}
    </div>
  );

  // With the editor column open the tree only picks files: it neither loads the file nor
  // replaces itself, so the tree stays put while the centre column shows the preview.
  if (treeOnly) {
    return <div className="flex h-full min-h-0 flex-col">{treePane}</div>;
  }

  // Wide panels get the editor layout: tree on the left, preview filling the rest.
  if (isWide) {
    return (
      <div className="flex h-full min-h-0">
        <div className="flex min-h-0 w-[230px] shrink-0 flex-col border-r border-border-primary">
          {treePane}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{previewPane}</div>
      </div>
    );
  }

  return <div className="flex h-full min-h-0 flex-col">{selected ? previewPane : treePane}</div>;
}

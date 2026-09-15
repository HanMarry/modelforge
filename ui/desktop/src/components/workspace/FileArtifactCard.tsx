import { useEffect, useState } from 'react';
import { FileSpreadsheet, FileText, Frame, Image as ImageIcon } from 'lucide-react';
import { AppEvents } from '../../constants/events';
import { defineMessages, useIntl } from '../../i18n';
import { extensionOf, isImageExtension } from './preview/previewKind';
import type { WorkspaceEntry } from '../../types/workspaceApi';

const i18n = defineMessages({
  open: { id: 'fileArtifact.open', defaultMessage: 'Open in the workspace editor' },
});

const MAX_THUMBNAIL_BYTES = 8 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(name: string) {
  const extension = extensionOf(name);
  if (isImageExtension(name)) return ImageIcon;
  if (extension === '.csv' || extension === '.tsv' || extension === '.xlsx') return FileSpreadsheet;
  if (extension === '.svg' || extension === '.drawio') return Frame;
  return FileText;
}

interface FileArtifactCardProps {
  path: string;
}

/**
 * Compact card for a file a tool call produced. Renders nothing when the path does not exist,
 * so heuristic path extraction never adds noise to the transcript.
 */
export default function FileArtifactCard({ path }: FileArtifactCardProps) {
  const intl = useIntl();
  const [entry, setEntry] = useState<WorkspaceEntry | null>(null);
  const [thumbnail, setThumbnail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stat = await window.electron.workspaceStat(path);
      if (cancelled || !stat.exists || stat.isDirectory) return;

      const name = path.split(/[\\/]/).pop() ?? path;
      setEntry({
        name,
        path,
        isDirectory: false,
        size: stat.size,
        modifiedAt: stat.modifiedAt,
      });

      if (isImageExtension(name) && stat.size <= MAX_THUMBNAIL_BYTES) {
        const binary = await window.electron.workspaceReadBinary(path);
        if (!cancelled) setThumbnail(binary.dataUrl);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [path]);

  if (!entry) return null;

  const Icon = iconFor(entry.name);

  return (
    <button
      type="button"
      title={intl.formatMessage(i18n.open)}
      onClick={() =>
        window.dispatchEvent(new CustomEvent(AppEvents.OPEN_WORKSPACE_FILE, { detail: { entry } }))
      }
      className="group flex w-40 flex-col overflow-hidden rounded-lg border border-border-primary bg-background-secondary/60 text-left transition-colors hover:border-border-secondary hover:bg-background-tertiary/60"
    >
      <div className="flex h-20 items-center justify-center overflow-hidden bg-background-primary/60">
        {thumbnail ? (
          <img src={thumbnail} alt={entry.name} className="max-h-full max-w-full object-contain" />
        ) : (
          <Icon className="h-6 w-6 text-text-tertiary group-hover:text-text-info" />
        )}
      </div>
      <div className="border-t border-border-primary px-2 py-1">
        <p dir="auto" className="truncate text-[11px] text-text-primary" title={entry.path}>
          {entry.name}
        </p>
        <p className="font-mono text-[10px] text-text-tertiary">{formatSize(entry.size)}</p>
      </div>
    </button>
  );
}

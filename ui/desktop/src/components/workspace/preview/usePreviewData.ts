import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceEntry, WorkspaceFileReadResult } from '../../../types/workspaceApi';
import { previewKindFor } from './previewKind';
import type { PreviewBytes } from './FilePreview';

export interface PreviewData {
  kind: ReturnType<typeof previewKindFor>;
  text: WorkspaceFileReadResult | null;
  imageDataUrl: string | null;
  bytes: PreviewBytes | null;
  loading: boolean;
}

const EMPTY: PreviewData = {
  kind: 'text',
  text: null,
  imageDataUrl: null,
  bytes: null,
  loading: false,
};

/**
 * Loads whatever a preview needs for one file: text for code/markdown/tables, raw bytes for
 * PDF/workbooks/binary, a data URL for images. Shared by the inline panel view and the
 * editor column so both render the same way.
 */
export function usePreviewData(entry: WorkspaceEntry | null): PreviewData & { retry: () => void } {
  const [data, setData] = useState<PreviewData>(EMPTY);
  const [loadedPath, setLoadedPath] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((current) => current + 1), []);

  useEffect(() => {
    if (!entry) {
      setData(EMPTY);
      setLoadedPath(null);
      return undefined;
    }

    let cancelled = false;
    const kind = previewKindFor(entry.name);
    setLoadedPath(entry.path);
    setData({ ...EMPTY, kind, loading: true });

    void (async () => {
      try {
        if (kind === 'image') {
          const binary = await window.electron.workspaceReadBinary(entry.path);
          if (cancelled) return;
          setData({
            kind,
            text: null,
            imageDataUrl: binary.dataUrl,
            bytes: { base64: null, size: binary.size, error: binary.error },
            loading: false,
          });
          return;
        }

        if (kind === 'pdf' || kind === 'spreadsheet' || kind === 'binary') {
          const bytes = await window.electron.workspaceReadBytes(entry.path);
          if (cancelled) return;
          setData({ kind, text: null, imageDataUrl: null, bytes, loading: false });
          return;
        }

        const text = await window.electron.workspaceReadFile(entry.path);
        if (cancelled) return;
        setData({ kind, text, imageDataUrl: null, bytes: null, loading: false });
      } catch (error) {
        if (cancelled) return;
        setData({
          ...EMPTY,
          kind,
          loading: false,
          bytes: {
            base64: null,
            size: entry.size,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entry, attempt]);

  return {
    ...(entry?.path === loadedPath
      ? data
      : { ...EMPTY, kind: entry ? previewKindFor(entry.name) : 'text', loading: Boolean(entry) }),
    retry,
  };
}

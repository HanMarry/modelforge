import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { WorkspaceEntry, WorkspaceFileReadResult } from '../../../types/workspaceApi';
import { syntaxThemeFor } from '../../../utils/syntaxTheme';
import { useIsDarkTheme } from '../../../hooks/useIsDarkTheme';
import MarkdownContent from '../../MarkdownContent';
import HexPreview from './HexPreview';
import NotebookPreview from './NotebookPreview';
import PdfPreview from './PdfPreview';
import SpreadsheetPreview from './SpreadsheetPreview';
import TablePreview from './TablePreview';
import { PRISM_LANGUAGES, extensionOf, type PreviewKind } from './previewKind';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  readFailed: {
    id: 'filePreview.readFailed',
    defaultMessage: 'Could not read this file. Check it still exists and try again.',
  },
  retry: { id: 'filePreview.retry', defaultMessage: 'Retry preview' },
  loading: { id: 'filePreview.loading', defaultMessage: 'Loading…' },
  unsupported: {
    id: 'filePreview.unsupported',
    defaultMessage: 'No preview for this file type - open it with an external program.',
  },
  truncated: {
    id: 'filePreview.truncated',
    defaultMessage: 'Showing the first portion of a large file',
  },
  binary: {
    id: 'filePreview.binary',
    defaultMessage: 'Binary file',
  },
});

/** Above this the syntax highlighter is skipped to keep scrolling responsive. */
const MAX_HIGHLIGHT_BYTES = 300 * 1024;

export interface PreviewBytes {
  base64: string | null;
  size: number;
  error: string | null;
}

interface FilePreviewProps {
  entry: WorkspaceEntry;
  kind: PreviewKind;
  text: WorkspaceFileReadResult | null;
  imageDataUrl: string | null;
  bytes: PreviewBytes | null;
  loading: boolean;
  onRetry?: () => void;
}

export default function FilePreview({
  entry,
  kind,
  text,
  imageDataUrl,
  bytes,
  loading,
  onRetry,
}: FilePreviewProps) {
  const intl = useIntl();
  const isDark = useIsDarkTheme();
  const syntaxTheme = syntaxThemeFor(isDark);

  if (loading) {
    return <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.loading)}</p>;
  }

  if (imageDataUrl && kind === 'image') {
    return (
      <div className="flex h-full items-start justify-center p-2">
        <img src={imageDataUrl} alt={entry.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }

  const readError = bytes?.error ?? text?.error;
  if (readError) {
    return (
      <div role="alert" className="p-4 text-sm text-text-primary">
        <p>{intl.formatMessage(i18n.readFailed)}</p>
        <p className="mt-2 break-words font-mono text-xs">{readError}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-3 rounded-md border border-border-primary px-3 py-2 hover:bg-background-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info"
          >
            {intl.formatMessage(i18n.retry)}
          </button>
        )}
      </div>
    );
  }

  if ((kind === 'pdf' || kind === 'spreadsheet') && bytes?.base64) {
    return kind === 'pdf' ? (
      <PdfPreview base64={bytes.base64} />
    ) : (
      <SpreadsheetPreview base64={bytes.base64} />
    );
  }

  if (kind === 'binary') {
    return bytes?.base64 ? (
      <HexPreview base64={bytes.base64} size={bytes.size} />
    ) : (
      <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.unsupported)}</p>
    );
  }

  const content = text?.content ?? '';
  const scroll = (node: React.ReactNode) => <div className="h-full overflow-auto">{node}</div>;

  if (kind === 'table') {
    return <TablePreview content={content} extension={extensionOf(entry.name)} />;
  }

  if (kind === 'notebook') {
    return scroll(<NotebookPreview content={content} />);
  }

  if (kind === 'markdown') {
    return scroll(
      <div className="p-3 text-sm">
        <MarkdownContent content={content} />
      </div>
    );
  }

  if (kind === 'code') {
    const language = PRISM_LANGUAGES[extensionOf(entry.name)];
    const canHighlight = Boolean(language) && content.length <= MAX_HIGHLIGHT_BYTES;
    if (canHighlight) {
      return scroll(
        <SyntaxHighlighter
          language={language}
          style={syntaxTheme}
          showLineNumbers
          customStyle={{
            margin: 0,
            padding: '0.75rem',
            background: 'transparent',
            fontSize: '12px',
            lineHeight: 1.5,
          }}
          lineNumberStyle={{ minWidth: '2.25em', opacity: 0.35 }}
        >
          {content}
        </SyntaxHighlighter>
      );
    }
  }

  return scroll(
    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-text-primary">
      {content}
    </pre>
  );
}

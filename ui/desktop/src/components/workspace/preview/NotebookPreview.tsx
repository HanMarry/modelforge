import { useMemo } from 'react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { syntaxThemeFor } from '../../../utils/syntaxTheme';
import { useIsDarkTheme } from '../../../hooks/useIsDarkTheme';
import MarkdownContent from '../../MarkdownContent';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  invalid: {
    id: 'notebookPreview.invalid',
    defaultMessage: 'This notebook could not be parsed',
  },
  cell: {
    id: 'notebookPreview.cell',
    defaultMessage: 'Cell {index}',
  },
  truncated: {
    id: 'notebookPreview.truncated',
    defaultMessage: 'Only the first {count} cells are shown',
  },
  empty: {
    id: 'notebookPreview.empty',
    defaultMessage: 'This notebook has no cells',
  },
});

const MAX_CELLS = 150;
const MAX_OUTPUT_CHARS = 4000;

interface NotebookOutput {
  output_type?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface NotebookCell {
  cell_type?: string;
  source?: string | string[];
  outputs?: NotebookOutput[];
}

interface NotebookDocument {
  cells?: NotebookCell[];
  metadata?: { language_info?: { name?: string } };
}

function joinSource(value: string | string[] | undefined): string {
  if (!value) return '';
  return Array.isArray(value) ? value.join('') : value;
}

function truncate(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text;
}

interface NotebookPreviewProps {
  content: string;
}

export default function NotebookPreview({ content }: NotebookPreviewProps) {
  const intl = useIntl();
  const isDark = useIsDarkTheme();
  const syntaxTheme = syntaxThemeFor(isDark);

  const document = useMemo<NotebookDocument | null>(() => {
    try {
      return JSON.parse(content) as NotebookDocument;
    } catch {
      return null;
    }
  }, [content]);

  if (!document) {
    return <p className="p-3 text-xs text-red-500">{intl.formatMessage(i18n.invalid)}</p>;
  }

  const cells = document.cells ?? [];
  if (cells.length === 0) {
    return <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>;
  }

  const language = document.metadata?.language_info?.name ?? 'python';

  return (
    <div className="flex flex-col gap-2 p-2">
      {cells.slice(0, MAX_CELLS).map((cell, index) => (
        <div key={index} className="rounded border border-border-primary">
          <div className="flex items-center gap-2 border-b border-border-primary bg-background-secondary px-2 py-0.5 text-[10px] text-text-tertiary">
            <span>{intl.formatMessage(i18n.cell, { index: index + 1 })}</span>
            <span className="font-mono">{cell.cell_type ?? 'code'}</span>
          </div>

          <div className="p-1">
            {cell.cell_type === 'markdown' ? (
              <div className="px-2 py-1 text-sm">
                <MarkdownContent content={joinSource(cell.source)} />
              </div>
            ) : (
              <SyntaxHighlighter
                language={language}
                style={syntaxTheme}
                customStyle={{
                  margin: 0,
                  padding: '0.5rem',
                  background: 'transparent',
                  fontSize: '12px',
                }}
              >
                {joinSource(cell.source)}
              </SyntaxHighlighter>
            )}
          </div>

          {(cell.outputs ?? []).map((output, outputIndex) => {
            const text = output.text ?? output.data?.['text/plain'];
            const image = output.data?.['image/png'];
            return (
              <div key={outputIndex} className="border-t border-border-primary px-2 py-1">
                {image && typeof image === 'string' && (
                  <img
                    src={`data:image/png;base64,${image.replace(/\n/g, '')}`}
                    alt={`output ${outputIndex + 1}`}
                    className="max-w-full"
                  />
                )}
                {!image && text && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-text-secondary">
                    {truncate(joinSource(text))}
                  </pre>
                )}
                {!image && !text && output.traceback && (
                  <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-red-500">
                    {truncate(output.traceback.join('\n'))}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {cells.length > MAX_CELLS && (
        <p className="px-1 text-[10px] text-text-tertiary">
          {intl.formatMessage(i18n.truncated, { count: MAX_CELLS })}
        </p>
      )}
    </div>
  );
}

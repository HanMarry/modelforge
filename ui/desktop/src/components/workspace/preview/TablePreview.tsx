import { useMemo } from 'react';
import { detectDelimiter, parseDelimited } from './previewKind';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  summary: {
    id: 'tablePreview.summary',
    defaultMessage: '{rows} rows × {cols} columns',
  },
  truncated: {
    id: 'tablePreview.truncated',
    defaultMessage: 'Showing the first {rows} rows and {cols} columns',
  },
  empty: {
    id: 'tablePreview.empty',
    defaultMessage: 'This table is empty',
  },
});

const MAX_ROWS = 2000;
const MAX_COLUMNS = 60;
const MAX_CELL_LENGTH = 240;

interface TablePreviewProps {
  content: string;
  extension: string;
}

export default function TablePreview({ content, extension }: TablePreviewProps) {
  const intl = useIntl();

  const { rows, columnCount, truncatedRows, truncatedColumns } = useMemo(() => {
    const delimiter = detectDelimiter(content, extension);
    const parsed = parseDelimited(content, delimiter, MAX_ROWS + 1);
    const truncatedRow = parsed.length > MAX_ROWS;
    const visibleRows = parsed.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS));
    const widest = parsed.reduce((max, row) => Math.max(max, row.length), 0);
    return {
      rows: visibleRows,
      columnCount: Math.min(widest, MAX_COLUMNS),
      truncatedRows: truncatedRow,
      truncatedColumns: widest > MAX_COLUMNS,
    };
  }, [content, extension]);

  if (rows.length === 0) {
    return <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>;
  }

  const [header, ...body] = rows;
  const isNumeric = (value: string) => value.trim() !== '' && !Number.isNaN(Number(value));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse font-mono text-[11px]">
          <thead className="sticky top-0 z-10 bg-background-secondary">
            <tr>
              <th className="border-b border-r border-border-primary px-2 py-1 text-right font-normal text-text-tertiary">
                #
              </th>
              {header.map((cell, index) => (
                <th
                  key={index}
                  title={cell}
                  className="max-w-[16rem] truncate border-b border-border-primary px-2 py-1 text-left font-semibold text-text-primary"
                >
                  {cell || `col ${index + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex} className={rowIndex % 2 === 1 ? 'bg-background-secondary/40' : ''}>
                <td className="border-b border-r border-border-primary/60 px-2 py-0.5 text-right text-text-tertiary">
                  {rowIndex + 2}
                </td>
                {header.map((_, columnIndex) => {
                  const cell = row[columnIndex] ?? '';
                  return (
                    <td
                      key={columnIndex}
                      title={cell.length > MAX_CELL_LENGTH ? cell : undefined}
                      className={`max-w-[16rem] truncate border-b border-border-primary/60 px-2 py-0.5 ${
                        isNumeric(cell) ? 'text-right text-text-primary' : 'text-text-secondary'
                      }`}
                    >
                      {cell.length > MAX_CELL_LENGTH ? `${cell.slice(0, MAX_CELL_LENGTH)}…` : cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-2 border-t border-border-primary px-2 py-1 text-[10px] text-text-tertiary">
        <span>{intl.formatMessage(i18n.summary, { rows: rows.length, cols: columnCount })}</span>
        {(truncatedRows || truncatedColumns) && (
          <span>{intl.formatMessage(i18n.truncated, { rows: MAX_ROWS, cols: MAX_COLUMNS })}</span>
        )}
      </div>
    </div>
  );
}

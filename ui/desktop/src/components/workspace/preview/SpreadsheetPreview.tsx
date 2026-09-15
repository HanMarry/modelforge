import { useEffect, useMemo, useState } from 'react';
import readXlsxFile, { type CellValue } from 'read-excel-file/browser';
import { defineMessages, useIntl } from '../../../i18n';
import { base64ToArrayBuffer } from './previewKind';

const i18n = defineMessages({
  loading: { id: 'spreadsheetPreview.loading', defaultMessage: 'Reading workbook…' },
  failed: { id: 'spreadsheetPreview.failed', defaultMessage: 'This workbook could not be read' },
  empty: { id: 'spreadsheetPreview.empty', defaultMessage: 'This sheet is empty' },
  summary: {
    id: 'spreadsheetPreview.summary',
    defaultMessage: '{rows} rows × {cols} columns',
  },
  truncated: {
    id: 'spreadsheetPreview.truncated',
    defaultMessage: 'Showing the first {rows} rows and {cols} columns',
  },
  sheet: { id: 'spreadsheetPreview.sheet', defaultMessage: 'Sheet' },
});

const MAX_ROWS = 1000;
const MAX_COLUMNS = 40;

type SheetCell = CellValue | null;

interface SheetTable {
  name: string;
  rows: SheetCell[][];
}

function formatCell(value: SheetCell | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  return String(value);
}

interface SpreadsheetPreviewProps {
  base64: string;
}

export default function SpreadsheetPreview({ base64 }: SpreadsheetPreviewProps) {
  const intl = useIntl();
  const blob = useMemo(() => new Blob([base64ToArrayBuffer(base64)]), [base64]);
  const [sheets, setSheets] = useState<SheetTable[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setActiveIndex(0);

    readXlsxFile(blob)
      .then((parsed) => {
        if (cancelled) return;
        setSheets(parsed.map((sheet) => ({ name: sheet.sheet, rows: sheet.data ?? [] })));
        setLoading(false);
      })
      .catch((readError: unknown) => {
        if (cancelled) return;
        setError(readError instanceof Error ? readError.message : String(readError));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [blob]);

  if (error) {
    return <p className="p-3 text-xs text-red-500">{intl.formatMessage(i18n.failed)}</p>;
  }

  if (loading) {
    return <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.loading)}</p>;
  }

  const active = sheets[activeIndex];
  const rows = active?.rows ?? [];
  const visibleRows = rows.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS));
  const widest = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const [header, ...body] = visibleRows;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {sheets.length > 1 && (
        <div className="flex flex-wrap gap-1 border-b border-border-primary px-2 py-1">
          {sheets.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              onClick={() => setActiveIndex(index)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                index === activeIndex
                  ? 'bg-background-tertiary text-text-primary'
                  : 'text-text-secondary hover:bg-background-tertiary/60'
              }`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {visibleRows.length === 0 ? (
          <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
        ) : (
          <table className="w-max min-w-full border-collapse font-mono text-[11px]">
            <thead className="sticky top-0 z-10 bg-background-secondary">
              <tr>
                <th className="border-b border-r border-border-primary px-2 py-1 text-right font-normal text-text-tertiary">
                  #
                </th>
                {(header ?? []).map((cell, index) => (
                  <th
                    key={index}
                    title={formatCell(cell)}
                    className="max-w-[14rem] truncate border-b border-border-primary px-2 py-1 text-left font-semibold text-text-primary"
                  >
                    {formatCell(cell) || `col ${index + 1}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={rowIndex % 2 === 1 ? 'bg-background-secondary/40' : ''}
                >
                  <td className="border-b border-r border-border-primary/60 px-2 py-0.5 text-right text-text-tertiary">
                    {rowIndex + 2}
                  </td>
                  {(header ?? []).map((_, columnIndex) => {
                    const value = row[columnIndex];
                    const text = formatCell(value);
                    const numeric = typeof value === 'number';
                    return (
                      <td
                        key={columnIndex}
                        title={text}
                        className={`max-w-[14rem] truncate border-b border-border-primary/60 px-2 py-0.5 ${
                          numeric ? 'text-right text-text-primary' : 'text-text-secondary'
                        }`}
                      >
                        {text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-border-primary px-2 py-1 text-[10px] text-text-tertiary">
        <span>{intl.formatMessage(i18n.summary, { rows: rows.length, cols: widest })}</span>
        {(rows.length > MAX_ROWS || widest > MAX_COLUMNS) && (
          <span>{intl.formatMessage(i18n.truncated, { rows: MAX_ROWS, cols: MAX_COLUMNS })}</span>
        )}
        {active && sheets.length > 1 && (
          <span className="ml-auto">
            {intl.formatMessage(i18n.sheet)}: {active.name}
          </span>
        )}
      </div>
    </div>
  );
}

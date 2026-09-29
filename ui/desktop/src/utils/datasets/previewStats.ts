/**
 * Dataset preview statistics (requirement 10.2): infer a column type, count rows, build the
 * first-100-row preview, and count missing (empty or null) cells per field over all rows.
 */
import type { ColumnType, DataPreview, DataTable } from '../../types/datasets';

const PREVIEW_ROW_LIMIT = 100;

const INTEGER_RE = /^[+-]?\d+$/;
const DATE_RE =
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}([T ]\d{1,2}:\d{1,2}(:\d{1,2})?(\.\d+)?([Zz]|[+-]\d{1,2}:?\d{2})?)?$/;

type CellKind = 'bool' | 'int' | 'float' | 'datetime' | 'string' | 'missing';

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function stringKind(value: string): CellKind {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'true' || lower === 'false') {
    return 'bool';
  }
  if (INTEGER_RE.test(trimmed)) {
    return 'int';
  }
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && !Number.isInteger(numeric)) {
    return 'float';
  }
  if (DATE_RE.test(trimmed)) {
    return 'datetime';
  }
  return 'string';
}

function cellKind(value: unknown): CellKind {
  if (isMissing(value)) {
    return 'missing';
  }
  if (typeof value === 'boolean') {
    return 'bool';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'int' : 'float';
  }
  if (typeof value === 'string') {
    return stringKind(value);
  }
  return 'string';
}

function mergeKinds(a: CellKind, b: CellKind): CellKind {
  if (a === b) return a;
  if ((a === 'int' && b === 'float') || (a === 'float' && b === 'int')) {
    return 'float';
  }
  return 'string';
}

const KIND_TO_TYPE: Record<Exclude<CellKind, 'missing'>, ColumnType> = {
  bool: '布尔',
  int: '整数',
  float: '浮点数',
  datetime: '日期时间',
  string: '字符串',
};

/** Infer the type of a whole column from its non-missing values (requirement 10.2). */
export function inferColumnType(values: unknown[]): ColumnType {
  let kind: CellKind = 'missing';
  for (const value of values) {
    const cell = cellKind(value);
    if (cell === 'missing') continue;
    kind = kind === 'missing' ? cell : mergeKinds(kind, cell);
  }
  if (kind === 'missing') {
    return '字符串';
  }
  return KIND_TO_TYPE[kind];
}

export function computePreviewStats(table: DataTable): DataPreview {
  const { fields, rows } = table;
  const totalRows = rows.length;
  const previewRows = rows.slice(0, PREVIEW_ROW_LIMIT);

  const types: ColumnType[] = [];
  const missingCounts: number[] = [];

  for (let column = 0; column < fields.length; column += 1) {
    const columnValues = rows.map((row) => row[column]);
    types.push(inferColumnType(columnValues));
    missingCounts.push(columnValues.filter((value) => isMissing(value)).length);
  }

  return {
    fields,
    totalRows,
    previewRows,
    types,
    missingCounts,
    sheetNames: [],
    activeSheet: '',
  };
}

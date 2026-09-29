/**
 * Shared types for the dataset library (requirement 10).
 */

/** The five inferred column types (requirement 10.2). */
export type ColumnType = '整数' | '浮点数' | '字符串' | '布尔' | '日期时间';

export interface DataFileEntry {
  /** Project-relative path, `/` separated. */
  relativePath: string;
  name: string;
  /** Size in bytes. */
  size: number;
  /** Last-modified time in milliseconds. */
  modifiedAt: number;
}

export interface DataFileListResult {
  files: DataFileEntry[];
  /** Matched count before the 1000-item cap (requirement 10.1). */
  total: number;
  /** True when `total` exceeded the cap. */
  truncated: boolean;
}

/** A normalized table: field names plus row-major cells. */
export interface DataTable {
  fields: string[];
  rows: unknown[][];
}

export interface DataPreview {
  fields: string[];
  totalRows: number;
  /** First `min(totalRows, 100)` rows, cells as values (requirement 10.2). */
  previewRows: unknown[][];
  /** Inferred type per field, parallel to `fields`. */
  types: ColumnType[];
  /** Missing (empty or null) cell count per field, parallel to `fields`. */
  missingCounts: number[];
  /** Worksheet names for XLSX; empty for other formats. */
  sheetNames: string[];
  /** Active worksheet (defaults to the first). */
  activeSheet: string;
}

export interface DatasetPreviewResult {
  preview: DataPreview;
  /** File size in bytes. */
  size: number;
}

export type DatasetParseErrorCode = 'TOO_LARGE' | 'PARSE_FAILED' | 'TIMEOUT';

export interface DatasetParseError {
  code: DatasetParseErrorCode;
  message: string;
}

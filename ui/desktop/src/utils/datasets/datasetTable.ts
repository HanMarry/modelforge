/**
 * Normalization of CSV and JSON into a row-major table (requirement 10.2). Split from the
 * heavy XLSX/Parquet parsers so the property test can exercise the CSV/JSON round-trip
 * without loading exceljs or hyparquet.
 */
import Papa from 'papaparse';
import type { DataTable } from '../../types/datasets';

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toTable(fields: string[], objects: Record<string, unknown>[]): DataTable {
  return { fields, rows: objects.map((obj) => fields.map((field) => obj[field] ?? null)) };
}

export class DatasetParseFailure extends Error {
  readonly code: 'PARSE_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'DatasetParseFailure';
    this.code = 'PARSE_FAILED';
  }
}

export function parseCsv(text: string): DataTable {
  const result = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
  });
  const fields = (result.meta.fields ?? []).map(String);
  return toTable(fields, result.data.filter((row) => isObject(row)));
}

export function parseJson(text: string): DataTable {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every((row) => isObject(row))) {
    throw new DatasetParseFailure('JSON 数据不是对象数组（表格）结构');
  }
  const fields: string[] = [];
  for (const row of parsed) {
    for (const key of Object.keys(row)) {
      if (!fields.includes(key)) fields.push(key);
    }
  }
  return toTable(fields, parsed as Record<string, unknown>[]);
}

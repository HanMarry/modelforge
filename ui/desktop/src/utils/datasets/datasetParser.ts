/**
 * Dataset parsing (requirement 10.2, 10.5). Runs in a `utilityProcess` so a slow or corrupt
 * file cannot block the main process; the caller enforces the 200 MB cap and the 5 s timeout.
 *
 * CSV and JSON use {@link datasetTable}; XLSX uses exceljs (first worksheet by default) and
 * Parquet uses hyparquet. Each format is normalized to a row-major table and handed to the
 * pure {@link computePreviewStats}.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { asyncBufferFromFile, parquetReadObjects } from 'hyparquet';
import type { DataPreview, DataTable, DatasetParseErrorCode } from '../../types/datasets';
import { parseCsv, parseJson } from './datasetTable';
import { computePreviewStats } from './previewStats';

export interface ParseDataFileOptions {
  /** Worksheet name or 1-based index for XLSX; defaults to the first worksheet. */
  sheet?: string | number;
}

export class DatasetParseFailure extends Error {
  readonly code: DatasetParseErrorCode;

  constructor(code: DatasetParseErrorCode, message: string) {
    super(message);
    this.name = 'DatasetParseFailure';
    this.code = code;
  }
}

function normalizeExcelValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('result' in record && record.result !== undefined) {
      return normalizeExcelValue(record.result);
    }
    if ('text' in record && typeof record.text === 'string') return record.text;
    if ('richText' in record && Array.isArray(record.richText)) {
      return (record.richText as Array<{ text?: string }>)
        .map((part) => part.text ?? '')
        .join('');
    }
    return JSON.stringify(value);
  }
  return value;
}

async function parseXlsx(filePath: string, sheet?: string | number): Promise<DataPreview> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const sheetNames = workbook.worksheets.map((worksheet) => worksheet.name);
  let worksheet = workbook.worksheets[0];
  if (typeof sheet === 'number') {
    worksheet = workbook.worksheets[sheet - 1] ?? workbook.worksheets[0];
  } else if (typeof sheet === 'string') {
    worksheet = workbook.worksheets.find((w) => w.name === sheet) ?? workbook.worksheets[0];
  }

  const columnCount = worksheet.columnCount;
  const headerRow = worksheet.getRow(1);
  const fields: string[] = [];
  for (let column = 1; column <= columnCount; column += 1) {
    const value = normalizeExcelValue(headerRow.getCell(column).value);
    fields.push(value === null || value === '' ? `列${column}` : String(value));
  }

  const rows: unknown[][] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const cells: unknown[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      cells.push(normalizeExcelValue(row.getCell(column).value));
    }
    rows.push(cells);
  });

  const preview = computePreviewStats({ fields, rows });
  return { ...preview, sheetNames, activeSheet: worksheet.name };
}

async function parseParquet(filePath: string): Promise<DataTable> {
  const file = await asyncBufferFromFile(filePath);
  const objects = await parquetReadObjects({ file });
  const fields: string[] = [];
  for (const row of objects) {
    for (const key of Object.keys(row)) {
      if (!fields.includes(key)) fields.push(key);
    }
  }
  return { fields, rows: objects.map((obj) => fields.map((field) => obj[field] ?? null)) };
}

export async function parseDataFile(
  filePath: string,
  options: ParseDataFileOptions = {}
): Promise<DataPreview> {
  const extension = path.extname(filePath).toLowerCase();

  try {
    switch (extension) {
      case '.csv':
        return computePreviewStats(parseCsv(await fs.readFile(filePath, 'utf8')));
      case '.xlsx':
        return await parseXlsx(filePath, options.sheet);
      case '.json':
        return computePreviewStats(parseJson(await fs.readFile(filePath, 'utf8')));
      case '.parquet':
        return computePreviewStats(await parseParquet(filePath));
      default:
        throw new DatasetParseFailure('PARSE_FAILED', `不支持的文件格式：${extension || '未知'}`);
    }
  } catch (error) {
    if (error instanceof DatasetParseFailure) throw error;
    throw new DatasetParseFailure(
      'PARSE_FAILED',
      `解析失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

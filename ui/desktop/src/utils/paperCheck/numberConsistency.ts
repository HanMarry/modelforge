/**
 * Number consistency (spec mathmodel-parity-and-beyond, requirement 18.2, Property 44): a number
 * the paper quotes from a result table must equal the table value rounded half up (ties away from
 * zero, "四舍五入") to the decimal places written in the paper. All arithmetic is decimal
 * (`decimal.js`), so `1.005` rounds to `1.01` whatever its binary floating-point form.
 *
 * Pure functions: the caller reads the paper sources and the result tables of the Run_Records
 * (CSV, TSV or JSON outputs whose hash still matches the record) and passes their text in.
 *
 * Result values are named: a CSV cell by its row label (first column, when not a number) and its
 * column header, a JSON number by the keys on its path and the string fields of the objects
 * around it. Generic names (`value`, `结果`, …), names shorter than two characters and names made
 * of digits only are dropped; a value left without names is never compared.
 *
 * A number in the paper is linked to a value when every name of the value appears before the
 * number on the same line and at least one of them appears after the previous number, so in
 * `RMSE 为 0.12，MAE 为 0.30` the second number is linked to `MAE`, not `RMSE`. In a LaTeX
 * `tabular`-like environment or a Markdown table, the row's first cell and the column header
 * name every cell instead. Names are compared after NFKC normalisation, lower-casing and removal
 * of everything but letters and digits (`R^2` and `r_2` are both `r2`).
 *
 * A linked number is consistent when at least one linked value matches it; a number followed by
 * `%` also matches a value that equals it after multiplying by 100. Numbers without any linked
 * value are not checked. The check cannot run (`无法执行`) without paper sources, without result
 * tables, or when no number in the paper could be linked to a table value.
 *
 * Paper numbers: `12`, `-0.5`, `−0.5` (U+2212), `1,234.5`, `.5`, `1.2e-3`, `1.2\times10^{-3}`,
 * `1.2×10^3`, each optionally followed by `%` or `\%`. The decimal places of a number with an
 * exponent are those of the value it stands for (`1.2\times10^{-3}` has 4, `1.2\times10^{3}`
 * has -2, which rounds to hundreds). Digits directly after an ASCII letter, digit, `_`, `.`,
 * `\` or `^`, or right inside `^{`/`_{`, are not numbers (`Q1`, `x_2`, `v1.2`, `R^{2}`). The
 * header row of a table is not checked either. Arguments of LaTeX commands such as `\label`,
 * `\ref`, `\cite`, `\includegraphics` and `\begin` are skipped, and comments are ignored.
 */

import Decimal from 'decimal.js';
import {
  sourceLanguageOf,
  splitLines,
  stripComments,
  type PaperCheckVerdict,
  type SourceText,
} from './common';

/** Enough significant digits that multiplying by powers of ten never rounds. */
const Dec = Decimal.clone({ precision: 200, rounding: Decimal.ROUND_HALF_UP });

const MAX_TABLE_ROWS = 10000;
const MAX_TABLE_VALUES = 20000;
const MAX_JSON_DEPTH = 12;
const MAX_EXPONENT = 400;

/** A number as written in the paper. */
export interface PaperNumber {
  /** The text as written, for example `0.123`, `-1,234.5`, `1.2\times10^{-3}` or `95.3\%`. */
  literal: string;
  /** The value it stands for, percent sign ignored. */
  value: Decimal;
  /** Decimal places of `value` as written; negative for `1.2\times10^{3}` (hundreds). */
  places: number;
  /** Followed by `%` or `\%`. */
  percent: boolean;
}

/** One number of a result table. */
export interface ResultValue {
  /** Labels naming the value: row label, column header, JSON keys. */
  names: string[];
  /** The value as written in the table, for example `0.12345`. */
  raw: string;
}

/** The numbers of one result table produced by a Run_Record. */
export interface ResultTable {
  /** Project-relative path of the table. */
  path: string;
  runId: string;
  values: ResultValue[];
}

export interface NumberMismatch {
  /** The number as written in the paper. */
  paperValue: string;
  path: string;
  /** 1-based line in `path`. */
  line: number;
  runId: string;
  /** Project-relative path of the result table. */
  table: string;
  /** The linked table value as written. */
  tableValue: string;
}

export type NumberConsistencyMissing = 'paper-source' | 'result-tables' | 'linked-values';

export interface NumberConsistencyReport {
  verdict: PaperCheckVerdict;
  /** Set only when the verdict is `无法执行`. */
  missing: NumberConsistencyMissing | null;
  /** Paper numbers that were linked to at least one table value and compared. */
  checked: number;
  mismatches: NumberMismatch[];
}

const MANTISSA = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`;
const EXPONENT = String.raw`(?:[eE]([+\-−]?\d+)|\s*(?:\\times|\\cdot|×|·)\s*10\s*\^\s*(?:\{\s*([+\-−]?\d+)\s*\}|([+\-−]?\d+)))`;
const PERCENT = String.raw`(\s*(?:\\%|%))`;
const NUMBER_BODY = `([+\\-−]?)${MANTISSA}${EXPONENT}?${PERCENT}?`;
// Not after a letter, digit, `_`, `.`, `\` or `^`, nor inside `^{…}`/`_{…}` (`R^2`, `x_{1}`).
const PAPER_NUMBER = new RegExp(String.raw`(?<![A-Za-z0-9_.\\^])(?<![\^_]\{)` + NUMBER_BODY, 'g');
const WHOLE_NUMBER = new RegExp(`^\\s*${NUMBER_BODY}\\s*$`);
const TABLE_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const GROUPED_NUMBER = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** LaTeX commands whose arguments are not prose: labels, references, files, lengths. */
const LATEX_NON_PROSE =
  /\\(?:label|ref|eqref|autoref|cref|Cref|pageref|cite[A-Za-z]*|nocite|includegraphics|input|include|usepackage|documentclass|begin|end|vspace|hspace|setlength|addtolength|setcounter|addtocounter|bibliography|bibliographystyle|url|href|hypersetup|geometry|graphicspath)\*?(?:\s*\[[^\]]*\])*(?:\s*\{[^{}]*\})*/g;

const LATEX_TABLE_BEGIN =
  /\\begin\{(?:tabular\*?|tabularx|tabulary|longtable|supertabular|xtabular|tblr|longtblr|array)\}/;
const LATEX_TABLE_END =
  /\\end\{(?:tabular\*?|tabularx|tabulary|longtable|supertabular|xtabular|tblr|longtblr|array)\}/;
const MARKDOWN_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

/** Names too generic to link a paper number to a value on their own. */
const GENERIC_NAMES = new Set(
  [
    'value',
    'values',
    'val',
    'result',
    'results',
    'data',
    'id',
    'index',
    'idx',
    'name',
    'no',
    'num',
    'number',
    '值',
    '数值',
    '结果',
    '数据',
    '序号',
    '编号',
  ].map(normalizeName)
);

function decimalOf(text: string): Decimal {
  return new Dec(text);
}

function unifyMinus(text: string): string {
  return text.replace(/−/g, '-');
}

function numberFromMatch(match: RegExpMatchArray | RegExpExecArray): PaperNumber | null {
  const [literal, sign, mantissa, eNotation, bracedPower, barePower, percent] = match;
  const exponentText = eNotation ?? bracedPower ?? barePower;
  const exponent = exponentText === undefined ? 0 : Number(unifyMinus(exponentText));
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > MAX_EXPONENT) {
    return null;
  }
  const digits = mantissa.replace(/,/g, '');
  const dot = digits.indexOf('.');
  const fraction = dot === -1 ? 0 : digits.length - dot - 1;
  const negative = sign === '-' || sign === '−';
  return {
    literal: literal.trim(),
    value: decimalOf(`${negative ? '-' : ''}${digits}e${exponent}`),
    places: fraction - exponent,
    percent: percent !== undefined,
  };
}

/**
 * Parses a number as written in a paper (see the module comment); the whole text must be one
 * number. `null` for anything else.
 */
export function parsePaperNumber(text: string): PaperNumber | null {
  const match = WHOLE_NUMBER.exec(text.normalize('NFKC'));
  return match === null ? null : numberFromMatch(match);
}

/**
 * A table cell as a decimal: `0.12`, `-3`, `1.2e-5`, `1,234.5`, `95.3%` (the percent sign is
 * dropped). `null` when the cell is not a number.
 */
export function parseTableValue(raw: string): Decimal | null {
  let text = unifyMinus(raw.normalize('NFKC').trim());
  if (text.endsWith('%')) {
    text = text.slice(0, -1).trim();
  }
  if (GROUPED_NUMBER.test(text)) {
    text = text.replace(/,/g, '');
  }
  return TABLE_NUMBER.test(text) ? decimalOf(text) : null;
}

/**
 * `value` rounded half up (ties away from zero) to `places` decimal places. Negative places round
 * to tens (-1), hundreds (-2) and so on.
 */
export function roundHalfUp(value: Decimal.Value, places: number): Decimal {
  const decimal = new Dec(value);
  if (places >= 0) {
    return decimal.toDecimalPlaces(places, Decimal.ROUND_HALF_UP);
  }
  const scale = new Dec(10).pow(-places);
  return decimal.div(scale).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).times(scale);
}

/**
 * Requirement 18.2: the table value, rounded to the decimal places of the paper number, equals
 * it. A paper number with `%` also matches a fraction (`95.3%` matches `0.953`). A table value
 * that is not a number never matches.
 */
export function paperValueMatches(paper: PaperNumber | string, tableValue: string): boolean {
  const number = typeof paper === 'string' ? parsePaperNumber(paper) : paper;
  const table = parseTableValue(tableValue);
  if (number === null || table === null) {
    return false;
  }
  if (roundHalfUp(table, number.places).eq(number.value)) {
    return true;
  }
  return number.percent && roundHalfUp(table.times(100), number.places).eq(number.value);
}

/** NFKC, lower case, letters and digits only: `R^2` → `r2`, `RMSE (test)` → `rmsetest`. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\\[a-z]+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function usableNames(names: readonly string[]): string[] {
  const kept: string[] = [];
  for (const name of names) {
    const trimmed = name.trim();
    const normalized = normalizeName(trimmed);
    if (
      normalized.length >= 2 &&
      !/^\d+$/.test(normalized) &&
      !GENERIC_NAMES.has(normalized) &&
      !kept.includes(trimmed)
    ) {
      kept.push(trimmed);
    }
  }
  return kept;
}

/** RFC 4180 fields: quotes, doubled quotes, delimiters and line breaks inside quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let fieldStart = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      quoted = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      fieldStart = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(cell);
      rows.push(row);
      if (rows.length >= MAX_TABLE_ROWS) {
        return rows;
      }
      row = [];
      cell = '';
      fieldStart = true;
    } else {
      cell += ch;
      fieldStart = false;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((value) => value.trim() !== ''));
}

function isNumberCell(cell: string): boolean {
  return parseTableValue(cell) !== null;
}

function readDelimited(text: string, delimiter: string): ResultValue[] {
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) {
    return [];
  }
  const first = rows[0];
  const hasHeader =
    rows.length > 1 &&
    (first.length === 1
      ? first[0].trim() !== '' && !isNumberCell(first[0])
      : first.slice(1).some((cell) => cell.trim() !== '' && !isNumberCell(cell)));
  const header = hasHeader ? first : [];
  const values: ResultValue[] = [];
  for (const cells of hasHeader ? rows.slice(1) : rows) {
    const labelCell = cells[0]?.trim() ?? '';
    const label = labelCell !== '' && !isNumberCell(labelCell) ? labelCell : '';
    cells.forEach((cell, column) => {
      if ((column === 0 && label !== '') || !isNumberCell(cell)) {
        return;
      }
      const names = usableNames([label, header[column] ?? '']);
      if (names.length > 0 && values.length < MAX_TABLE_VALUES) {
        values.push({ names, raw: cell.trim() });
      }
    });
  }
  return values;
}

function readJson(text: string): ResultValue[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return [];
  }
  const values: ResultValue[] = [];
  const visit = (node: unknown, names: readonly string[], depth: number): void => {
    if (depth > MAX_JSON_DEPTH || values.length >= MAX_TABLE_VALUES) {
      return;
    }
    if (typeof node === 'number' || (typeof node === 'string' && isNumberCell(node))) {
      const usable = usableNames(names);
      if (usable.length > 0) {
        values.push({ names: usable, raw: typeof node === 'number' ? String(node) : node.trim() });
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const element of node) {
        visit(element, names, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object' || node === null) {
      return;
    }
    const entries = Object.entries(node as Record<string, unknown>);
    // String fields label their sibling numbers: `{ "model": "lr", "rmse": 0.1 }`.
    const labels = entries
      .filter(
        ([, value]) =>
          typeof value === 'string' && value.trim().length <= 60 && !isNumberCell(value)
      )
      .map(([, value]) => value as string);
    for (const [key, value] of entries) {
      if (typeof value !== 'string' || isNumberCell(value)) {
        visit(value, [...names, ...labels, key], depth + 1);
      }
    }
  };
  visit(root, [], 0);
  return values;
}

function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot).toLowerCase();
}

/** Result table formats read by `readResultTable`. */
export const RESULT_TABLE_EXTENSIONS: readonly string[] = ['.csv', '.tsv', '.json'];

/** The named numbers of a CSV, TSV or JSON result table; `[]` for other formats. */
export function readResultTable(path: string, text: string): ResultValue[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  switch (extensionOf(path)) {
    case '.csv': {
      const firstLine = source.slice(0, source.search(/\r|\n|$/));
      const semicolons = (firstLine.match(/;/g) ?? []).length;
      const commas = (firstLine.match(/,/g) ?? []).length;
      return readDelimited(source, semicolons > commas ? ';' : ',');
    }
    case '.tsv':
      return readDelimited(source, '\t');
    case '.json':
      return readJson(source);
    default:
      return [];
  }
}

/** Replaces `\label{…}` and similar with spaces so offsets and table cells stay put. */
function blankNonProse(line: string): string {
  return line.replace(LATEX_NON_PROSE, (command) => ' '.repeat(command.length));
}

interface NumberOccurrence {
  number: PaperNumber;
  /** Normalised text that may hold every name of a linked value. */
  context: string;
  /** Normalised text of which at least one name must be part. */
  near: string;
}

/** Offsets of the unescaped `&` of a LaTeX table row, or of `|` of a Markdown one. */
function cellBounds(line: string, separator: '&' | '|'): Array<{ start: number; end: number }> {
  const bounds: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === separator && line[i - 1] !== '\\') {
      bounds.push({ start, end: i });
      start = i + 1;
    }
  }
  bounds.push({ start, end: line.length });
  if (separator === '|') {
    // `| a | b |` has an empty cell before the first and after the last bar.
    if (line.slice(bounds[0].start, bounds[0].end).trim() === '') {
      bounds.shift();
    }
    const last = bounds[bounds.length - 1];
    if (last !== undefined && line.slice(last.start, last.end).trim() === '') {
      bounds.pop();
    }
  }
  return bounds;
}

function cellTexts(line: string, separator: '&' | '|'): string[] {
  return cellBounds(line, separator).map(({ start, end }) =>
    line
      .slice(start, end)
      .replace(/\\\\.*$/, '')
      .trim()
  );
}

function numbersOnLine(
  line: string,
  table: { separator: '&' | '|'; header: string[] } | null
): NumberOccurrence[] {
  const occurrences: NumberOccurrence[] = [];
  const bounds = table === null ? [] : cellBounds(line, table.separator);
  const cells = table === null ? [] : cellTexts(line, table.separator);
  let previousEnd = 0;
  for (const match of line.matchAll(PAPER_NUMBER)) {
    const start = match.index ?? 0;
    const number = numberFromMatch(match);
    if (number === null) {
      continue;
    }
    if (table !== null) {
      const column = bounds.findIndex((bound) => start >= bound.start && start < bound.end);
      const cellStart = column === -1 ? 0 : bounds[column].start;
      const context = normalizeName(
        [cells[0] ?? '', table.header[column] ?? '', line.slice(cellStart, start)].join(' ')
      );
      occurrences.push({ number, context, near: context });
    } else {
      occurrences.push({
        number,
        context: normalizeName(line.slice(0, start)),
        near: normalizeName(line.slice(previousEnd, start)),
      });
    }
    previousEnd = start + match[0].length;
  }
  return occurrences;
}

interface LocatedNumber extends NumberOccurrence {
  path: string;
  line: number;
}

/** Every number of a paper source with the text that may name it, comments excluded. */
function extractNumbers(file: SourceText): LocatedNumber[] {
  const language = sourceLanguageOf(file.path);
  const lines = splitLines(stripComments(file.text, language)).map((line) =>
    line.normalize('NFKC')
  );
  const found: LocatedNumber[] = [];
  let latexTable: { header: string[] | null } | null = null;
  let markdownHeader: string[] | null = null;

  lines.forEach((rawLine, index) => {
    const lineNumber = index + 1;
    let table: { separator: '&' | '|'; header: string[] } | null = null;

    if (language === 'latex') {
      if (LATEX_TABLE_BEGIN.test(rawLine)) {
        latexTable = { header: null };
      }
      const line = blankNonProse(rawLine);
      const inTable: { header: string[] | null } | null = latexTable;
      if (inTable !== null && /(?<!\\)&/.test(line)) {
        if (inTable.header === null) {
          // The first row names the columns; its own numbers (years, sizes) are labels.
          inTable.header = cellTexts(line, '&');
        } else {
          table = { separator: '&', header: inTable.header };
        }
      }
      if (LATEX_TABLE_END.test(rawLine)) {
        latexTable = null;
      }
      if (inTable === null || table !== null || !/(?<!\\)&/.test(line)) {
        for (const occurrence of numbersOnLine(line, table)) {
          found.push({ ...occurrence, path: file.path, line: lineNumber });
        }
      }
      return;
    }

    if (language === 'markdown' && rawLine.trim().startsWith('|')) {
      const next = lines[index + 1];
      if (next !== undefined && MARKDOWN_SEPARATOR.test(next)) {
        markdownHeader = cellTexts(rawLine, '|');
        return;
      }
      if (MARKDOWN_SEPARATOR.test(rawLine)) {
        return;
      }
      if (markdownHeader !== null) {
        table = { separator: '|', header: markdownHeader };
      }
    } else if (language === 'markdown') {
      markdownHeader = null;
    }
    for (const occurrence of numbersOnLine(rawLine, table)) {
      found.push({ ...occurrence, path: file.path, line: lineNumber });
    }
  });
  return found;
}

const MAX_COMPARED_VALUES = 50000;

interface IndexedValue {
  table: ResultTable;
  value: ResultValue;
  /** Normalised names. */
  names: string[];
  decimal: Decimal;
}

interface ValueIndex {
  /** Every distinct normalised name. */
  names: string[];
  byName: Map<string, IndexedValue[]>;
}

function indexValues(tables: readonly ResultTable[]): ValueIndex {
  const byName = new Map<string, IndexedValue[]>();
  let count = 0;
  for (const table of tables) {
    for (const value of table.values) {
      const decimal = parseTableValue(value.raw);
      const names = [...new Set(value.names.map(normalizeName))].filter((name) => name !== '');
      if (decimal === null || names.length === 0 || count >= MAX_COMPARED_VALUES) {
        continue;
      }
      count++;
      const indexed: IndexedValue = { table, value, names, decimal };
      for (const name of names) {
        const list = byName.get(name);
        if (list === undefined) {
          byName.set(name, [indexed]);
        } else {
          list.push(indexed);
        }
      }
    }
  }
  return { names: [...byName.keys()], byName };
}

function linkedValues(occurrence: NumberOccurrence, index: ValueIndex): IndexedValue[] {
  const present = new Set(index.names.filter((name) => occurrence.context.includes(name)));
  const linked = new Set<IndexedValue>();
  for (const name of present) {
    for (const value of index.byName.get(name) ?? []) {
      if (
        value.names.every((candidate) => present.has(candidate)) &&
        value.names.some((candidate) => occurrence.near.includes(candidate))
      ) {
        linked.add(value);
      }
    }
  }
  return [...linked];
}

function bestCandidate(paper: PaperNumber, candidates: readonly IndexedValue[]): IndexedValue {
  let best = candidates[0];
  let bestDistance = best.decimal.minus(paper.value).abs();
  for (const candidate of candidates.slice(1)) {
    const distance = candidate.decimal.minus(paper.value).abs();
    if (
      candidate.names.length > best.names.length ||
      (candidate.names.length === best.names.length && distance.lt(bestDistance))
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

/** Requirement 18.2: compares the numbers of the paper with the linked result table values. */
export function checkNumberConsistency(
  paperFiles: readonly SourceText[],
  tables: readonly ResultTable[]
): NumberConsistencyReport {
  const cannotRun = (missing: NumberConsistencyMissing): NumberConsistencyReport => ({
    verdict: '无法执行',
    missing,
    checked: 0,
    mismatches: [],
  });
  if (paperFiles.length === 0) {
    return cannotRun('paper-source');
  }
  const index = indexValues(tables);
  if (index.names.length === 0) {
    return cannotRun('result-tables');
  }

  let checked = 0;
  const mismatches: NumberMismatch[] = [];
  for (const file of paperFiles) {
    for (const occurrence of extractNumbers(file)) {
      const candidates = linkedValues(occurrence, index);
      if (candidates.length === 0) {
        continue;
      }
      checked++;
      if (candidates.some(({ value }) => paperValueMatches(occurrence.number, value.raw))) {
        continue;
      }
      const best = bestCandidate(occurrence.number, candidates);
      mismatches.push({
        paperValue: occurrence.number.literal,
        path: occurrence.path,
        line: occurrence.line,
        runId: best.table.runId,
        table: best.table.path,
        tableValue: best.value.raw,
      });
    }
  }
  if (checked === 0) {
    return cannotRun('linked-values');
  }
  return {
    verdict: mismatches.length === 0 ? '通过' : '发现问题',
    missing: null,
    checked,
    mismatches,
  };
}

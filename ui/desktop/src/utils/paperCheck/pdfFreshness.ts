/**
 * PDF freshness (spec mathmodel-parity-and-beyond, requirement 18.5, Property 45): the compiled
 * PDF must not be older than any paper source, meaning the main file, the files it pulls in and
 * the figures they show. Reports `PDF 已过期` with the newer sources, or `PDF 缺失`.
 *
 * Pure functions: the caller lists the project files with their modification times and passes
 * the text of every LaTeX and Typst file; nothing here reads the file system.
 *
 * Dependencies are found in the text with comments removed (LaTeX `%`, Typst `//` and `/* *\/`):
 *
 * LaTeX, paths relative to the directory of the main file (where LaTeX runs), not to the file
 * that contains the command:
 * - `\input{sec/intro}` and `\input sec/intro`: `sec/intro.tex`, then `sec/intro` as written.
 *   A name already ending in `.tex` is used as written. The same rule applies to `\include`.
 * - `\includegraphics[…]{fig/plot}` (and `\includegraphics*`): a name ending in one of
 *   `LATEX_GRAPHICS_EXTENSIONS` is used as written; otherwise each extension in that order, then
 *   the name as written. For every candidate name the main file's directory is tried first, then
 *   each `\graphicspath` entry, as graphicx does.
 * - `\bibliography{a,b}` (`a.bib`, `b.bib`) and `\addbibresource{a.bib}`.
 * - Quotes around names with spaces (`{"my file"}`) are removed. Targets containing `\` or `#`
 *   are macros or macro parameters and reported as `dynamic`; absolute paths (`/…`, `C:…`, `~…`)
 *   as `outside-project`.
 *
 * Typst, paths relative to the file that contains the call; a leading `/` is relative to the
 * project root, which is the main file's directory (Typst's default `--root`), and paths may not
 * leave it. No extension is added.
 * - `#include "…"`, and `include "…"` in code after `=`, `(`, `[`, `{`, `,`, `;` or `:`.
 * - `image("…")`, `bibliography("…")`, with a string literal as first argument.
 *
 * Paths are compared after normalisation (`\` to `/`, `.` and `..` resolved). When no file has
 * exactly the candidate path, a single file matching it case-insensitively is used, as on the
 * Windows and macOS file systems.
 */

import {
  dirnameOf,
  isEscaped,
  isWithin,
  joinProjectPath,
  lineAt,
  lineStarts,
  normalizeProjectPath,
  sourceLanguageOf,
  stripComments,
  type PaperCheckVerdict,
} from './common';

export interface ProjectFile {
  /** Project-relative path; `\` and `/` are both accepted. */
  path: string;
  /** Last modification time in milliseconds, as `fs.Stats.mtimeMs`. */
  mtimeMs: number;
  /** Text of LaTeX and Typst files, needed to follow their references. */
  text?: string;
}

export type DependencyKind = 'input' | 'include' | 'graphics' | 'bibliography';

export interface DependencyReference {
  kind: DependencyKind;
  /** The command as written: `\input`, `\includegraphics`, `#include`, `image()`, … */
  command: string;
  /** Target as written, without TeX quotes and with Typst escapes decoded. */
  target: string;
  /** 1-based line of the command. */
  line: number;
}

export interface LatexReferences {
  references: DependencyReference[];
  /** `\graphicspath` entries in order, as written. */
  graphicsPaths: string[];
}

export type UnresolvedReason = 'not-found' | 'outside-project' | 'dynamic';

export interface UnresolvedReference {
  /** File containing the reference. */
  from: string;
  reference: DependencyReference;
  reason: UnresolvedReason;
}

export interface PaperSources {
  /** The main file first, then every resolved dependency, each once. */
  sources: string[];
  /** References whose file could not be found; they do not affect the verdict. */
  unresolved: UnresolvedReference[];
  /** Sources pulled in as LaTeX or Typst whose text was not provided, so not followed. */
  unparsed: string[];
}

export interface TimedFile {
  path: string;
  mtimeMs: number;
}

export type PdfFreshnessStatus = 'fresh' | 'stale' | 'missing';

export const PDF_FRESHNESS_LABELS: Readonly<Record<PdfFreshnessStatus, string>> = {
  fresh: 'PDF 为最新',
  stale: 'PDF 已过期',
  missing: 'PDF 缺失',
};

export interface FreshnessJudgement {
  status: PdfFreshnessStatus;
  /** Sources modified after the PDF, newest first; empty unless `stale`. */
  newerSources: TimedFile[];
}

export interface PdfFreshnessInput {
  /** Main LaTeX or Typst file, project-relative. */
  mainFile: string;
  /** Compiled PDF, project-relative; defaults to the main file with a `.pdf` extension. */
  pdfFile?: string;
  files: readonly ProjectFile[];
}

export interface PdfFreshnessReport {
  verdict: PaperCheckVerdict;
  /** `null` when the check could not run. */
  status: PdfFreshnessStatus | null;
  /** Set only when the verdict is `无法执行`: the main file is not among the files. */
  missing: 'paper-source' | null;
  mainFile: string;
  pdfFile: string;
  pdfMtimeMs: number | null;
  /** Every source the PDF depends on, main file first. */
  sources: TimedFile[];
  newerSources: TimedFile[];
  unresolved: UnresolvedReference[];
  unparsed: string[];
}

/** Tried in this order when `\includegraphics` names a file without one of them. */
export const LATEX_GRAPHICS_EXTENSIONS: readonly string[] = [
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.eps',
];

const LATEX_COMMAND =
  /\\(input|include|includegraphics|bibliography|addbibresource|graphicspath)(?![A-Za-z@])\*?/g;
const LATEX_BARE_NAME = /[^\s{}%\\]+/y;
const TYPST_STRING = String.raw`"((?:[^"\\\n]|\\.)*)"`;
const TYPST_INCLUDE = new RegExp(String.raw`(?:#|(?<=[=([{,;:]\s*))include\s*${TYPST_STRING}`, 'g');
const TYPST_CALL = new RegExp(String.raw`(?<![\w.-])(image|bibliography)\(\s*${TYPST_STRING}`, 'g');

interface Group {
  content: string;
  end: number;
}

/** The balanced `open … close` group starting at `start`; `\x` never opens or closes one. */
function readGroup(text: string, start: number, open: string, close: string): Group | null {
  if (text[start] !== open) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return { content: text.slice(start + 1, i), end: i + 1 };
      }
    }
  }
  return null;
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  return i;
}

function skipOptionalArguments(text: string, index: number): number {
  let i = skipWhitespace(text, index);
  for (let group = readGroup(text, i, '[', ']'); group !== null; ) {
    i = skipWhitespace(text, group.end);
    group = readGroup(text, i, '[', ']');
  }
  return i;
}

function cleanLatexTarget(raw: string): string {
  return raw.replace(/"/g, '').trim();
}

function graphicsPathEntries(content: string): string[] {
  const entries: string[] = [];
  let i = skipWhitespace(content, 0);
  for (let group = readGroup(content, i, '{', '}'); group !== null; ) {
    const entry = cleanLatexTarget(group.content);
    if (entry !== '') {
      entries.push(entry);
    }
    i = skipWhitespace(content, group.end);
    group = readGroup(content, i, '{', '}');
  }
  return entries;
}

function latexKind(command: string): DependencyKind {
  switch (command) {
    case 'include':
      return 'include';
    case 'includegraphics':
      return 'graphics';
    case 'bibliography':
    case 'addbibresource':
      return 'bibliography';
    default:
      return 'input';
  }
}

/** `\input`, `\include`, `\includegraphics`, bibliography commands and `\graphicspath` of a file. */
export function extractLatexReferences(text: string): LatexReferences {
  const source = stripComments(text, 'latex');
  const starts = lineStarts(source);
  const references: DependencyReference[] = [];
  const graphicsPaths: string[] = [];

  for (const match of source.matchAll(LATEX_COMMAND)) {
    const offset = match.index ?? 0;
    if (isEscaped(source, offset)) {
      // `\\input` is a line break followed by the word "input".
      continue;
    }
    const name = match[1];
    const command = `\\${name}`;
    const line = lineAt(starts, offset);
    const afterName = offset + match[0].length;
    const argumentStart =
      name === 'includegraphics' || name === 'addbibresource'
        ? skipOptionalArguments(source, afterName)
        : skipWhitespace(source, afterName);
    const group = readGroup(source, argumentStart, '{', '}');

    if (group === null) {
      if (name === 'input') {
        LATEX_BARE_NAME.lastIndex = argumentStart;
        const bare = LATEX_BARE_NAME.exec(source);
        if (bare !== null) {
          references.push({ kind: 'input', command, target: cleanLatexTarget(bare[0]), line });
        }
      }
      continue;
    }

    if (name === 'graphicspath') {
      graphicsPaths.push(...graphicsPathEntries(group.content));
      continue;
    }
    const kind = latexKind(name);
    const targets = name === 'bibliography' ? group.content.split(',') : [group.content];
    for (const raw of targets) {
      const target = cleanLatexTarget(raw);
      if (target !== '') {
        references.push({ kind, command, target, line });
      }
    }
  }
  return { references, graphicsPaths };
}

function decodeTypstString(body: string): string {
  return body.replace(/\\(u\{([0-9A-Fa-f]{1,6})\}|.)/g, (_all, escape: string, hex?: string) => {
    if (hex !== undefined) {
      const codePoint = parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : '';
    }
    switch (escape) {
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      default:
        return escape;
    }
  });
}

/** `include`, `image()` and `bibliography()` of a Typst file, in order of appearance. */
export function extractTypstReferences(text: string): DependencyReference[] {
  const source = stripComments(text, 'typst');
  const starts = lineStarts(source);
  const found: Array<{ offset: number; reference: DependencyReference }> = [];

  for (const match of source.matchAll(TYPST_INCLUDE)) {
    const offset = match.index ?? 0;
    const hashed = match[0].startsWith('#');
    if (hashed && isEscaped(source, offset)) {
      // `\#include` is literal text in markup.
      continue;
    }
    const target = decodeTypstString(match[1]);
    if (target !== '') {
      found.push({
        offset,
        reference: {
          kind: 'include',
          command: hashed ? '#include' : 'include',
          target,
          line: lineAt(starts, offset),
        },
      });
    }
  }
  for (const match of source.matchAll(TYPST_CALL)) {
    const offset = match.index ?? 0;
    const target = decodeTypstString(match[2]);
    if (target !== '') {
      found.push({
        offset,
        reference: {
          kind: match[1] === 'image' ? 'graphics' : 'bibliography',
          command: `${match[1]}()`,
          target,
          line: lineAt(starts, offset),
        },
      });
    }
  }
  return found.sort((a, b) => a.offset - b.offset).map(({ reference }) => reference);
}

function hasExtension(name: string, extensions: readonly string[]): boolean {
  const lower = name.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

/** File names LaTeX tries for a reference, before the directory is applied. */
function latexCandidateNames(reference: DependencyReference): string[] {
  const { kind, target } = reference;
  switch (kind) {
    case 'graphics':
      return hasExtension(target, LATEX_GRAPHICS_EXTENSIONS)
        ? [target]
        : [...LATEX_GRAPHICS_EXTENSIONS.map((extension) => `${target}${extension}`), target];
    case 'bibliography':
      return hasExtension(target, ['.bib']) ? [target] : [`${target}.bib`, target];
    case 'input':
    case 'include':
      return hasExtension(target, ['.tex']) ? [target] : [`${target}.tex`, target];
  }
}

/** Candidate project paths in the order LaTeX tries them, or why there are none. */
export function latexCandidates(
  reference: DependencyReference,
  rootDir: string,
  graphicsDirs: readonly string[] = []
): string[] | UnresolvedReason {
  if (/[\\#]/.test(reference.target)) {
    return 'dynamic';
  }
  if (/^(?:\/|~|[A-Za-z]:)/.test(reference.target)) {
    return 'outside-project';
  }
  const bases = reference.kind === 'graphics' ? [rootDir, ...graphicsDirs] : [rootDir];
  const candidates: string[] = [];
  for (const name of latexCandidateNames(reference)) {
    for (const base of bases) {
      const joined = joinProjectPath(base, name);
      if (joined !== null && joined !== '' && !candidates.includes(joined)) {
        candidates.push(joined);
      }
    }
  }
  return candidates.length > 0 ? candidates : 'outside-project';
}

/** The project path a Typst reference in `fromFile` names, or why it has none. */
export function typstCandidates(
  reference: DependencyReference,
  fromFile: string,
  rootDir: string
): string[] | UnresolvedReason {
  const { target } = reference;
  const joined = target.startsWith('/')
    ? joinProjectPath(rootDir, target.slice(1))
    : joinProjectPath(dirnameOf(fromFile), target);
  if (joined === null || joined === '' || !isWithin(rootDir, joined)) {
    return 'outside-project';
  }
  return [joined];
}

interface IndexedFile {
  path: string;
  mtimeMs: number;
  text: string | undefined;
}

interface FileIndex {
  exact: Map<string, IndexedFile>;
  /** Case- and Unicode-normalisation-folded path → every path with that folding. */
  folded: Map<string, string[]>;
}

function foldPath(path: string): string {
  return path.normalize('NFC').toLowerCase();
}

function indexFiles(files: readonly ProjectFile[]): FileIndex {
  const exact = new Map<string, IndexedFile>();
  const folded = new Map<string, string[]>();
  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (path === null || path === '' || exact.has(path)) {
      continue;
    }
    exact.set(path, { path, mtimeMs: file.mtimeMs, text: file.text });
    const key = foldPath(path);
    const same = folded.get(key);
    if (same === undefined) {
      folded.set(key, [path]);
    } else {
      same.push(path);
    }
  }
  return { exact, folded };
}

function lookup(index: FileIndex, path: string): IndexedFile | undefined {
  const exact = index.exact.get(path);
  if (exact !== undefined) {
    return exact;
  }
  const same = index.folded.get(foldPath(path));
  return same !== undefined && same.length === 1 ? index.exact.get(same[0]) : undefined;
}

interface CollectedSources {
  files: IndexedFile[];
  unresolved: UnresolvedReference[];
  unparsed: string[];
}

function collectFromIndex(main: IndexedFile, index: FileIndex): CollectedSources {
  const rootDir = dirnameOf(main.path);
  const files: IndexedFile[] = [main];
  const seen = new Set<string>([main.path]);
  const unresolved: UnresolvedReference[] = [];
  const unparsed: string[] = [];
  const graphicsDirs: string[] = [];
  const pendingGraphics: Array<{ from: string; reference: DependencyReference }> = [];
  const queue: Array<{ file: IndexedFile; language: 'latex' | 'typst' }> = [];

  const add = (file: IndexedFile): boolean => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    files.push(file);
    return true;
  };

  const resolve = (
    from: string,
    reference: DependencyReference,
    candidates: string[] | UnresolvedReason
  ): IndexedFile | undefined => {
    if (typeof candidates === 'string') {
      unresolved.push({ from, reference, reason: candidates });
      return undefined;
    }
    for (const candidate of candidates) {
      const file = lookup(index, candidate);
      if (file !== undefined) {
        return file;
      }
    }
    unresolved.push({ from, reference, reason: 'not-found' });
    return undefined;
  };

  const mainLanguage = sourceLanguageOf(main.path);
  if (mainLanguage === 'latex' || mainLanguage === 'typst') {
    queue.push({ file: main, language: mainLanguage });
  }

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const { file, language } = next;
    if (file.text === undefined) {
      unparsed.push(file.path);
      continue;
    }

    let references: DependencyReference[];
    if (language === 'latex') {
      const extracted = extractLatexReferences(file.text);
      for (const entry of extracted.graphicsPaths) {
        const dir = joinProjectPath(rootDir, entry);
        if (dir !== null && !graphicsDirs.includes(dir)) {
          graphicsDirs.push(dir);
        }
      }
      references = extracted.references;
    } else {
      references = extractTypstReferences(file.text);
    }

    for (const reference of references) {
      if (language === 'latex' && reference.kind === 'graphics') {
        // Resolved once every `\graphicspath` is known.
        pendingGraphics.push({ from: file.path, reference });
        continue;
      }
      const candidates =
        language === 'latex'
          ? latexCandidates(reference, rootDir)
          : typstCandidates(reference, file.path, rootDir);
      const found = resolve(file.path, reference, candidates);
      if (
        found !== undefined &&
        add(found) &&
        (reference.kind === 'input' || reference.kind === 'include')
      ) {
        queue.push({ file: found, language });
      }
    }
  }

  for (const { from, reference } of pendingGraphics) {
    const found = resolve(from, reference, latexCandidates(reference, rootDir, graphicsDirs));
    if (found !== undefined) {
      add(found);
    }
  }
  return { files, unresolved, unparsed };
}

/**
 * The main file and every file it depends on, followed transitively through `\input`,
 * `\include` and Typst `include`. `null` when the main file is not among `files`.
 */
export function collectPaperSources(
  mainFile: string,
  files: readonly ProjectFile[]
): PaperSources | null {
  const index = indexFiles(files);
  const mainPath = normalizeProjectPath(mainFile);
  const main = mainPath === null || mainPath === '' ? undefined : lookup(index, mainPath);
  if (main === undefined) {
    return null;
  }
  const collected = collectFromIndex(main, index);
  return {
    sources: collected.files.map(({ path }) => path),
    unresolved: collected.unresolved,
    unparsed: collected.unparsed,
  };
}

function newestFirst(a: TimedFile, b: TimedFile): number {
  if (a.mtimeMs !== b.mtimeMs) {
    return b.mtimeMs - a.mtimeMs;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

/**
 * `missing` when there is no PDF (`pdfMtimeMs` is `null`); otherwise `stale` exactly when some
 * source was modified strictly after the PDF, listing exactly those sources.
 */
export function judgePdfFreshness(
  pdfMtimeMs: number | null,
  sources: readonly TimedFile[]
): FreshnessJudgement {
  if (pdfMtimeMs === null) {
    return { status: 'missing', newerSources: [] };
  }
  const pdfTime = pdfMtimeMs;
  const newerSources = sources
    .filter(({ mtimeMs }) => mtimeMs > pdfTime)
    .map(({ path, mtimeMs }) => ({ path, mtimeMs }))
    .sort(newestFirst);
  return { status: newerSources.length > 0 ? 'stale' : 'fresh', newerSources };
}

/** `paper/main.tex` → `paper/main.pdf`; a name without extension gets `.pdf` appended. */
export function defaultPdfPath(mainFile: string): string {
  const slash = Math.max(mainFile.lastIndexOf('/'), mainFile.lastIndexOf('\\'));
  const dot = mainFile.lastIndexOf('.');
  return `${dot > slash + 1 ? mainFile.slice(0, dot) : mainFile}.pdf`;
}

/** Requirement 18.5: compares the PDF with every source it depends on. */
export function checkPdfFreshness(input: PdfFreshnessInput): PdfFreshnessReport {
  const index = indexFiles(input.files);
  const mainPath = normalizeProjectPath(input.mainFile) ?? input.mainFile;
  const main = mainPath === '' ? undefined : lookup(index, mainPath);
  const requestedPdf = input.pdfFile ?? defaultPdfPath(main?.path ?? mainPath);
  const pdfPath = normalizeProjectPath(requestedPdf);
  const pdfFile = pdfPath ?? requestedPdf;

  if (main === undefined) {
    return {
      verdict: '无法执行',
      status: null,
      missing: 'paper-source',
      mainFile: mainPath,
      pdfFile,
      pdfMtimeMs: null,
      sources: [],
      newerSources: [],
      unresolved: [],
      unparsed: [],
    };
  }

  const pdf = pdfPath === null || pdfPath === '' ? undefined : lookup(index, pdfPath);
  const collected = collectFromIndex(main, index);
  const sources = collected.files
    .filter(({ path }) => path !== pdf?.path)
    .map(({ path, mtimeMs }) => ({ path, mtimeMs }));
  const judgement = judgePdfFreshness(pdf === undefined ? null : pdf.mtimeMs, sources);
  return {
    verdict: judgement.status === 'fresh' ? '通过' : '发现问题',
    status: judgement.status,
    missing: null,
    mainFile: main.path,
    pdfFile: pdf?.path ?? pdfFile,
    pdfMtimeMs: pdf === undefined ? null : pdf.mtimeMs,
    sources,
    newerSources: judgement.newerSources,
    unresolved: collected.unresolved,
    unparsed: collected.unparsed,
  };
}

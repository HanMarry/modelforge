/**
 * The paper check run (spec mathmodel-parity-and-beyond, requirement 18, task 23.8): gathers the
 * inputs of every check through a read-only `ProjectReader`, runs the checks and turns their
 * results into the report the panel shows.
 *
 * - Read-only (18.9): every file is read through the reader, which opens files `O_RDONLY` and
 *   never writes or calls `utimes`; Property 46 checks contents and modification times.
 * - A check that lacks an input is `无法执行` with the reason, and the others still run (18.7).
 *   A check that throws is `无法执行` with `check-failed` rather than failing the report.
 * - The offline checks share a budget (`OFFLINE_BUDGET_MS`) so the report is ready within the
 *   60 seconds of 18.8; a check started after it ran out is `无法执行` with `timed-out`. The
 *   online reference lookups run last and are bounded per entry instead (18.4).
 *
 * Inputs:
 * - Paper sources: the main file and what it pulls in (`collectPaperSources`), plus the images of
 *   a Markdown main file. The PDF is the main file with a `.pdf` extension.
 * - Problem statements: `.md`, `.txt`, `.tex`, `.typ` or `.pdf` files that are not paper
 *   sources and whose path has a segment like `题目`, `题面`, `赛题`, `A题` (or their traditional
 *   forms), `problem…` or `question…`, plus the first input file recorded in
 *   `.modelforge/project.json`.
 * - Result tables: CSV, TSV and JSON outputs of the Run_Records in `.modelforge/runs/` that
 *   exited with 0, taking the latest run per file, and only while the file still has the hash
 *   that run recorded (otherwise it is no longer that run's result).
 */

import type {
  AnonymityTerms,
  PaperCheckIssue,
  PaperCheckIssueCode,
  PaperCheckItem,
  PaperCheckItemId,
  PaperCheckReason,
  PaperCheckReport,
} from '../../types/paperCheckApi';
import type { RunRecord } from '../../types/runRecord';
import { describeError } from '../ipcResult';
import { loadRunRecords } from '../runRecord';
import { checkAnonymity, type AnonymityField } from './anonymity';
import {
  dirnameOf,
  joinProjectPath,
  normalizeProjectPath,
  sourceLanguageOf,
  type SourceText,
} from './common';
import {
  analyzePdfFigure,
  analyzeSvgFigure,
  checkFigureLabels,
  extractMarkdownImages,
  figureFormat,
  type FigureAnalysis,
  type FigureLabelPart,
  type FigureResult,
  type FigureUnreadableReason,
} from './figureLabels';
import {
  checkNumberConsistency,
  readResultTable,
  RESULT_TABLE_EXTENSIONS,
  type ResultTable,
} from './numberConsistency';
import {
  checkPdfFreshness,
  collectPaperSources,
  defaultPdfPath,
  type ProjectFile,
} from './pdfFreshness';
import { pageLines, type PdfDocumentText, type PdfTextExtractor } from './pdfTextLayer';
import type { ProjectEntry, ProjectReader } from './projectReader';
import { checkQuestionCoverage } from './questionCoverage';
import {
  collectReferences,
  summarizeReferences,
  verifyReferences,
  type CrossrefOptions,
  type ReferenceEntry,
  type ReferenceUnverifiedReason,
} from './references';

/** Time the offline checks may take together, leaving room within the 60 s of 18.8. */
export const OFFLINE_BUDGET_MS = 55_000;
/** Issues kept per check; the rest are counted in `omittedIssues`. */
export const MAX_ISSUES_PER_ITEM = 200;

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_SVG_BYTES = 20 * 1024 * 1024;
const MAX_TABLE_BYTES = 20 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_TEXT_FILES = 2000;

const FOLLOWED_EXTENSIONS = ['.tex', '.ltx', '.typ', '.cls', '.sty'];
const PAPER_TEXT_EXTENSIONS = ['.tex', '.ltx', '.typ', '.md', '.markdown'];
const TEMPLATE_EXTENSIONS = ['.cls', '.sty'];
const PROBLEM_EXTENSIONS = ['.md', '.markdown', '.txt', '.tex', '.typ', '.pdf'];

const ITEM_ORDER: readonly PaperCheckItemId[] = [
  'question-coverage',
  'number-consistency',
  'figure-labels',
  'references',
  'pdf-freshness',
  'anonymity',
];

const PROBLEM_SEGMENT =
  /[题題][目面]|[赛賽][题題]|[试試][题題]|(?:^|[^A-Za-z])[A-Fa-f][题題]|^(?:problem|question|statement)s?(?:[_\-.\s]|$)/i;

/** What the main process sends to the check process. */
export interface PaperCheckRunMessage {
  /** Real path of the Project root, already checked by the main process. */
  root: string;
  /** Project-relative path of the paper's main source, with `/` separators. */
  paperPath: string;
  online: boolean;
  anonymity?: AnonymityTerms;
}

export interface PaperCheckRunOptions {
  paperPath: string;
  online: boolean;
  anonymity?: AnonymityTerms;
}

export interface PaperCheckRunnerDeps {
  reader: ProjectReader;
  extractPdfText: PdfTextExtractor;
  /** Needed for online verification; without it references are treated as offline. */
  crossref?: CrossrefOptions;
  now?: () => number;
  offlineBudgetMs?: number;
}

class DeadlineExceeded extends Error {
  constructor() {
    super('The offline checks ran out of time');
    this.name = 'DeadlineExceeded';
  }
}

const PART_LABELS: Readonly<Record<FigureLabelPart, string>> = {
  'x-label': '横轴标签',
  'y-label': '纵轴标签',
  'x-unit': '横轴单位',
  'y-unit': '纵轴单位',
};

const UNREADABLE_LABELS: Readonly<Record<FigureUnreadableReason, string>> = {
  bitmap: '位图',
  'unsupported-format': '不支持的格式',
  'no-axes-structure': '无法识别坐标轴',
  'no-text': '没有文字层',
  'parse-error': '无法解析',
};

const REFERENCE_REASON_LABELS: Readonly<Record<ReferenceUnverifiedReason, string>> = {
  'doi-not-found': 'DOI 不存在',
  'doi-title-mismatch': 'DOI 与标题不符',
  'no-match': '没有找到匹配的记录',
  'no-identifier': '没有 DOI 和标题',
};

const FIELD_LABELS: Readonly<Record<AnonymityField, string>> = {
  name: '姓名',
  school: '学校',
  team: '队名',
};

function hasExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension));
}

function issue(
  code: PaperCheckIssueCode,
  params: PaperCheckIssue['params'],
  message: string,
  location: { file?: string; line?: number; page?: number } = {}
): PaperCheckIssue {
  return { code, params, message, ...location };
}

function item(
  id: PaperCheckItemId,
  verdict: PaperCheckItem['verdict'],
  issues: PaperCheckIssue[],
  reason?: PaperCheckReason
): PaperCheckItem {
  const result: PaperCheckItem = { id, verdict, issues: issues.slice(0, MAX_ISSUES_PER_ITEM) };
  if (issues.length > MAX_ISSUES_PER_ITEM) {
    result.omittedIssues = issues.length - MAX_ISSUES_PER_ITEM;
  }
  if (reason !== undefined) {
    result.reason = reason;
  }
  return result;
}

function cannotRun(
  id: PaperCheckItemId,
  reason: PaperCheckReason,
  issues: PaperCheckIssue[] = []
): PaperCheckItem {
  return item(id, '无法执行', issues, reason);
}

function display(entry: ReferenceEntry): string {
  const text = entry.title ?? entry.text;
  return [...text].length > 80 ? `${[...text].slice(0, 79).join('')}…` : text;
}

/** Text of a PDF as a source whose line `n` lies on page `pages[n - 1]`. */
function pdfSource(
  path: string,
  pdf: PdfDocumentText
): { source: SourceText; pages: number[] } {
  const lines: string[] = [];
  const pages: number[] = [];
  for (const page of pdf.pages) {
    for (const line of pageLines(page)) {
      lines.push(line.replace(/\r?\n/g, ' '));
      pages.push(page.page);
    }
  }
  return { source: { path, text: lines.join('\n') }, pages };
}

function isProblemStatement(path: string): boolean {
  if (!hasExtension(path, PROBLEM_EXTENSIONS) || path.startsWith('.modelforge/')) {
    return false;
  }
  const segments = path.split('/');
  return segments.some((segment, i) => {
    const name = i === segments.length - 1 ? segment.replace(/\.[^.]*$/, '') : segment;
    return PROBLEM_SEGMENT.test(name);
  });
}

/** Runs every check on the Project behind `deps.reader` (requirement 18). */
export async function runPaperCheck(
  options: PaperCheckRunOptions,
  deps: PaperCheckRunnerDeps
): Promise<PaperCheckReport> {
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.offlineBudgetMs ?? OFFLINE_BUDGET_MS);
  const checkTime = (): void => {
    if (now() > deadline) {
      throw new DeadlineExceeded();
    }
  };
  const { reader } = deps;

  const files = await reader.list();
  const byPath = new Map<string, ProjectEntry>(files.map((file) => [file.path, file]));
  const byFoldedPath = new Map<string, string[]>();
  for (const { path } of files) {
    const key = path.normalize('NFC').toLowerCase();
    byFoldedPath.set(key, [...(byFoldedPath.get(key) ?? []), path]);
  }
  /** The listed path for `path`, matching case-insensitively when unambiguous. */
  const find = (path: string | null): string | null => {
    if (path === null || path === '') {
      return null;
    }
    if (byPath.has(path)) {
      return path;
    }
    const same = byFoldedPath.get(path.normalize('NFC').toLowerCase());
    return same !== undefined && same.length === 1 ? same[0] : null;
  };

  // Sources that may pull in other files, read once for dependency following.
  const texts = new Map<string, string>();
  const projectFiles: ProjectFile[] = [];
  for (const file of files) {
    let text: string | null = null;
    if (hasExtension(file.path, FOLLOWED_EXTENSIONS) && texts.size < MAX_TEXT_FILES) {
      text = await reader.readText(file.path, MAX_TEXT_BYTES);
      if (text !== null) {
        texts.set(file.path, text);
      }
    }
    projectFiles.push(
      text === null
        ? { path: file.path, mtimeMs: file.mtimeMs }
        : { path: file.path, mtimeMs: file.mtimeMs, text }
    );
  }
  const textOf = async (path: string): Promise<string | null> => {
    const cached = texts.get(path);
    if (cached !== undefined) {
      return cached;
    }
    const text = await reader.readText(path, MAX_TEXT_BYTES);
    if (text !== null) {
      texts.set(path, text);
    }
    return text;
  };
  const pdfTexts = new Map<string, Promise<PdfDocumentText | null>>();
  const pdfTextOf = (path: string, maxPages?: number): Promise<PdfDocumentText | null> => {
    const key = `${path}\u0000${maxPages ?? ''}`;
    let pending = pdfTexts.get(key);
    if (pending === undefined) {
      pending = (async () => {
        const bytes = await reader.readBytes(path, MAX_PDF_BYTES);
        if (bytes === null) {
          return null;
        }
        try {
          return await deps.extractPdfText(bytes, maxPages);
        } catch {
          return null;
        }
      })();
      pdfTexts.set(key, pending);
    }
    return pending;
  };

  // Paper sources.
  const requestedMain = normalizeProjectPath(options.paperPath) ?? '';
  const collected = requestedMain === '' ? null : collectPaperSources(requestedMain, projectFiles);
  const mainFile = collected?.sources[0] ?? null;
  const pdfPath = normalizeProjectPath(defaultPdfPath(mainFile ?? requestedMain)) ?? '';
  const pdfFile = find(pdfPath);
  const sourcePaths = [...(collected?.sources ?? [])];
  if (mainFile !== null && sourceLanguageOf(mainFile) === 'markdown') {
    const text = await textOf(mainFile);
    for (const { target } of extractMarkdownImages(text ?? '')) {
      const image = find(joinProjectPath(dirnameOf(mainFile), target));
      if (image !== null && !sourcePaths.includes(image)) {
        sourcePaths.push(image);
      }
    }
  }
  const paperSources: SourceText[] = [];
  const templateSources: SourceText[] = [];
  const bibSources: SourceText[] = [];
  const figurePaths: string[] = [];
  for (const path of sourcePaths) {
    if (hasExtension(path, PAPER_TEXT_EXTENSIONS) || hasExtension(path, TEMPLATE_EXTENSIONS)) {
      const text = await textOf(path);
      if (text !== null) {
        (hasExtension(path, TEMPLATE_EXTENSIONS) ? templateSources : paperSources).push({
          path,
          text,
        });
      }
    } else if (hasExtension(path, ['.bib'])) {
      const text = await textOf(path);
      if (text !== null) {
        bibSources.push({ path, text });
      }
    } else if (!hasExtension(path, ['.bst']) && path !== pdfFile) {
      figurePaths.push(path);
    }
  }

  const items: PaperCheckItem[] = [];
  const runItem = async (
    id: PaperCheckItemId,
    run: () => Promise<PaperCheckItem | null>,
    timed = true
  ): Promise<void> => {
    let result: PaperCheckItem | null;
    if (timed && now() > deadline) {
      result = cannotRun(id, 'timed-out');
    } else {
      try {
        result = await run();
      } catch (error) {
        result =
          error instanceof DeadlineExceeded
            ? cannotRun(id, 'timed-out')
            : { ...cannotRun(id, 'check-failed'), reasonDetail: describeError(error) };
      }
    }
    if (result !== null) {
      items.push(result);
    }
  };

  await runItem('question-coverage', async () => {
    let origin: string | null = null;
    const metadata = find('.modelforge/project.json');
    if (metadata !== null) {
      try {
        const parsed = JSON.parse((await reader.readText(metadata)) ?? '') as {
          origin?: { inputFiles?: unknown };
        };
        const inputs = parsed.origin?.inputFiles;
        origin =
          Array.isArray(inputs) && typeof inputs[0] === 'string'
            ? find(normalizeProjectPath(inputs[0]))
            : null;
      } catch {
        origin = null;
      }
    }
    const excluded = new Set<string>([...sourcePaths, ...(pdfFile === null ? [] : [pdfFile])]);
    const candidates = files
      .map(({ path }) => path)
      .filter((path) => !excluded.has(path) && (path === origin || isProblemStatement(path)));
    if (origin !== null && !excluded.has(origin) && !candidates.includes(origin)) {
      candidates.unshift(origin);
    }

    const problems: SourceText[] = [];
    const pageMaps = new Map<string, number[]>();
    for (const path of candidates) {
      checkTime();
      if (hasExtension(path, ['.pdf'])) {
        const pdf = await pdfTextOf(path);
        if (pdf !== null) {
          const { source, pages } = pdfSource(path, pdf);
          problems.push(source);
          pageMaps.set(path, pages);
        }
      } else if (hasExtension(path, PROBLEM_EXTENSIONS)) {
        const text = await textOf(path);
        if (text !== null) {
          problems.push({ path, text });
        }
      }
    }

    const report = checkQuestionCoverage(problems, paperSources);
    if (report.verdict === '无法执行') {
      const reasons: Record<string, PaperCheckReason> = {
        'problem-statement': 'missing-problem-statement',
        'paper-source': 'missing-paper-source',
        'question-numbers': 'missing-question-numbers',
      };
      return cannotRun('question-coverage', reasons[report.missing ?? 'paper-source']);
    }
    const issues = report.uncovered.map(({ number, statedAt }) => {
      const pages = pageMaps.get(statedAt.path);
      const location =
        pages === undefined
          ? { file: statedAt.path, line: statedAt.line }
          : { file: statedAt.path, page: pages[statedAt.line - 1] };
      return issue(
        'question-uncovered',
        { number },
        `题面中的问题 ${number} 在论文中没有出现`,
        location
      );
    });
    return item('question-coverage', report.verdict, issues);
  });

  await runItem('number-consistency', async () => {
    const runFiles = files.filter(
      ({ path }) => /^\.modelforge\/runs\/[^/]+\.json$/.test(path) && !path.endsWith('.meta.json')
    );
    const loaded = loadRunRecords(
      await Promise.all(
        runFiles.map(async ({ path }) => ({ path, text: (await reader.readText(path)) ?? '' }))
      )
    );
    const recordCount = loaded.records.length;
    const latest = new Map<string, { record: RunRecord; sha256: string; ended: number }>();
    for (const { record } of loaded.records) {
      if (record.exitCode !== 0) {
        continue;
      }
      const ended = Date.parse(record.endedAt);
      for (const output of record.outputs) {
        const previous = latest.get(output.path);
        if (
          hasExtension(output.path, RESULT_TABLE_EXTENSIONS) &&
          (previous === undefined || ended > previous.ended)
        ) {
          latest.set(output.path, { record, sha256: output.sha256, ended });
        }
      }
    }
    const tables: ResultTable[] = [];
    for (const [path, { record, sha256 }] of latest) {
      checkTime();
      if (!byPath.has(path) || (await reader.sha256(path, MAX_TABLE_BYTES)) !== sha256) {
        continue;
      }
      const text = await reader.readText(path, MAX_TABLE_BYTES);
      if (text !== null) {
        tables.push({ path, runId: record.runId, values: readResultTable(path, text) });
      }
    }

    checkTime();
    const report = checkNumberConsistency(paperSources, tables);
    switch (report.missing) {
      case 'paper-source':
        return cannotRun('number-consistency', 'missing-paper-source');
      case 'result-tables':
        return cannotRun(
          'number-consistency',
          recordCount === 0 ? 'missing-run-records' : 'no-result-tables'
        );
      case 'linked-values':
        return cannotRun('number-consistency', 'no-linked-values');
      default:
        break;
    }
    const issues = report.mismatches.map(({ paperValue, tableValue, runId, table, path, line }) =>
      issue(
        'number-mismatch',
        { paperValue, tableValue, runId, table },
        `论文数值 ${paperValue} 与 ${table} 中的 ${tableValue} 不一致（run_id ${runId}）`,
        { file: path, line }
      )
    );
    return item('number-consistency', report.verdict, issues);
  });

  await runItem('figure-labels', async () => {
    if (mainFile === null) {
      return cannotRun('figure-labels', 'missing-paper-source');
    }
    const unreadable = (reason: FigureUnreadableReason): FigureAnalysis => ({
      status: 'unreadable',
      reason,
    });
    const results: FigureResult[] = [];
    for (const path of figurePaths) {
      checkTime();
      let analysis: FigureAnalysis;
      switch (figureFormat(path)) {
        case 'svg': {
          const text = await reader.readText(path, MAX_SVG_BYTES);
          analysis = text === null ? unreadable('parse-error') : analyzeSvgFigure(text);
          break;
        }
        case 'pdf': {
          const pdf = await pdfTextOf(path, 1);
          analysis = pdf === null ? unreadable('parse-error') : analyzePdfFigure(pdf.pages[0]);
          break;
        }
        case 'bitmap':
          analysis = unreadable('bitmap');
          break;
        default:
          analysis = unreadable('unsupported-format');
      }
      results.push({ path, analysis });
    }
    const report = checkFigureLabels(results);
    const issues = [
      ...report.incomplete.map(({ path, missing }) =>
        issue(
          'figure-missing',
          { missing: missing.join(',') },
          `${path} 缺少${missing.map((part) => PART_LABELS[part]).join('、')}`,
          { file: path }
        )
      ),
      ...report.unreadable.map(({ path, reason }) => {
        const message = `${path} 无法检查（${UNREADABLE_LABELS[reason]}）`;
        return issue('figure-unreadable', { reason }, message, { file: path });
      }),
    ];
    if (report.missing === 'figures') {
      return cannotRun('figure-labels', 'no-figures');
    }
    if (report.missing === 'readable-figures') {
      return cannotRun('figure-labels', 'figures-unreadable', issues);
    }
    return item('figure-labels', report.verdict, issues);
  });

  await runItem('pdf-freshness', async () => {
    const report = checkPdfFreshness({ mainFile: requestedMain, files: projectFiles });
    if (report.verdict === '无法执行') {
      return cannotRun('pdf-freshness', 'missing-paper-source');
    }
    const pdf = report.pdfFile;
    const issues =
      report.status === 'missing'
        ? [issue('pdf-missing', { pdf }, `PDF 缺失：${pdf}`)]
        : report.newerSources.map(({ path }) =>
            issue('pdf-stale', { pdf }, `${path} 比 PDF（${pdf}）新`, { file: path })
          );
    return item('pdf-freshness', report.verdict, issues);
  });

  if (options.anonymity !== undefined) {
    const terms = options.anonymity;
    await runItem('anonymity', async () => {
      const pdf =
        pdfFile === null
          ? null
          : { path: pdfFile, pages: (await pdfTextOf(pdfFile))?.pages ?? null };
      checkTime();
      const report = checkAnonymity(terms, [...paperSources, ...templateSources], pdf);
      if (report.missing !== null) {
        return cannotRun(
          'anonymity',
          report.missing === 'profile' ? 'missing-profile' : 'missing-paper-source'
        );
      }
      const issues = report.hits.map(({ term, field, path, line, page }) => {
        const where = line !== undefined ? `第 ${line} 行` : `第 ${page ?? 1} 页`;
        return issue(
          'anonymity-hit',
          { term, field },
          `${FIELD_LABELS[field]}「${term}」出现在 ${path} ${where}`,
          line !== undefined ? { file: path, line } : { file: path, page: page ?? 1 }
        );
      });
      if (report.unreadablePdf !== null) {
        issues.push(
          issue('pdf-unreadable', {}, `无法读取 ${report.unreadablePdf} 的文字`, {
            file: report.unreadablePdf,
          })
        );
      }
      return item('anonymity', report.verdict, issues);
    });
  }

  // Online lookups last, outside the offline budget; each entry is bounded by its timeout.
  await runItem(
    'references',
    async () => {
      if (mainFile === null) {
        return cannotRun('references', 'missing-paper-source');
      }
      const entries = collectReferences(paperSources, bibSources);
      const verifications =
        options.online && deps.crossref !== undefined && entries.length > 0
          ? await verifyReferences(entries, deps.crossref)
          : null;
      const report = summarizeReferences(entries, verifications);
      const issues = [
        ...report.unverified.map(({ entry, reason }) =>
          issue(
            'reference-unverified',
            { index: entry.index, title: display(entry), reason },
            `[${entry.index}] ${display(entry)} 无法核实（${REFERENCE_REASON_LABELS[reason]}）`,
            { file: entry.path, line: entry.line }
          )
        ),
        ...report.network.map(({ entry }) =>
          issue(
            'reference-network',
            { index: entry.index, title: display(entry) },
            `[${entry.index}] ${display(entry)} 未核实（网络原因）`,
            { file: entry.path, line: entry.line }
          )
        ),
      ];
      switch (report.missing) {
        case 'references':
          return cannotRun('references', 'no-references');
        case 'offline':
          return cannotRun('references', 'offline');
        case 'network':
          return cannotRun('references', 'network-unavailable', issues);
        default:
          return item('references', report.verdict, issues);
      }
    },
    false
  );

  items.sort((a, b) => ITEM_ORDER.indexOf(a.id) - ITEM_ORDER.indexOf(b.id));
  return { items, finishedAt: new Date(now()).toISOString() };
}

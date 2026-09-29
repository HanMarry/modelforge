// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import type { RunRecord } from '../../types/runRecord';
import { serializeRunRecord } from '../runRecord';
import { runPaperCheck, type PaperCheckRunnerDeps } from './paperCheckRunner';
import type { PdfDocumentText, PdfTextExtractor } from './pdfTextLayer';
import { createProjectReader } from './projectReader';

const RUN_ID = '20260920T101530123-abc123';

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

function runRecord(outputs: RunRecord['outputs']): string {
  return serializeRunRecord({
    schemaVersion: 1,
    runId: RUN_ID,
    inputs: [],
    inputsTruncated: false,
    code: { path: 'code/model.py', sha256: sha256('print(1)') },
    config: { provider: 'test', model: 'test-model', runtime: 'python 3.12' },
    command: 'python code/model.py',
    dependencies: [],
    seed: '42',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs,
    outputsTruncated: false,
  });
}

const SVG_OK = [
  '<svg xmlns="http://www.w3.org/2000/svg"><metadata>Matplotlib v3.8</metadata>',
  '<g id="axes_1"><g id="matplotlib.axis_1"><g id="xtick_1"><g id="text_1"><!-- 0 --></g></g>',
  '<g id="text_2"><!-- 时间 (s) --></g></g>',
  '<g id="matplotlib.axis_2"><g id="ytick_1"><g id="text_3"><!-- 1 --></g></g>',
  '<g id="text_4"><!-- 人数 --></g></g></g></svg>',
].join('\n');

const BIB = '@article{zhang2020,\n  title = {Grey prediction of population growth},\n  year = {2020}\n}\n';

const PDF_TEXT: PdfDocumentText = {
  pages: [
    { page: 1, width: 100, height: 100, items: [{ text: '正文', x: 0, y: 0, angle: 0, endOfLine: true }] },
  ],
};

/** Reads a PDF whose first byte is not 0; others cannot be parsed. */
const fakeExtract: PdfTextExtractor = async (bytes) => {
  if (bytes[0] === 0) {
    throw new Error('Invalid PDF structure');
  }
  return PDF_TEXT;
};

const roots: string[] = [];

async function tempProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'paper-check-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

/** Writes `files` below `root`; `mtimes` holds seconds since the epoch per path (test setup). */
async function writeFiles(
  root: string,
  files: Record<string, string | Uint8Array>,
  mtimes: Record<string, number> = {}
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    const seconds = mtimes[relative] ?? 1_700_000_000;
    await fs.utimes(target, seconds, seconds);
  }
}

async function run(
  root: string,
  options: { paperPath: string; online?: boolean; anonymity?: { names: string[]; school: string; team: string } },
  extra: Partial<PaperCheckRunnerDeps> = {}
) {
  const reader = await createProjectReader(root);
  return runPaperCheck(
    { paperPath: options.paperPath, online: options.online ?? false, anonymity: options.anonymity },
    { reader, extractPdfText: fakeExtract, ...extra }
  );
}

const MAIN_TEX = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\section{问题一的求解}',
  '模型的 RMSE 为 0.20。',
  '\\section{问题二的求解}',
  '作者单位：某某大学',
  '\\includesvg{fig/plot}',
  '\\includegraphics{fig/photo}',
  '如文献\\cite{zhang2020}所述。',
  '\\bibliography{refs}',
  '\\end{document}',
].join('\n');

const TABLE = 'metric,value\nrmse,0.1234\n';

async function sampleProject(): Promise<string> {
  const root = await tempProject();
  await writeFiles(
    root,
    {
      '题目/problem.md': '# 赛题\n\n问题一：预测人口。\n\n问题二：优化。\n\n问题三：评价。\n',
      'paper/main.tex': MAIN_TEX,
      'paper/fig/plot.svg': SVG_OK,
      'paper/fig/photo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'paper/refs.bib': BIB,
      'paper/main.pdf': new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      'results/summary.csv': TABLE,
      [`.modelforge/runs/${RUN_ID}.json`]: runRecord([
        { path: 'results/summary.csv', sha256: sha256(TABLE) },
      ]),
    },
    { 'paper/main.tex': 1_700_002_000, 'paper/main.pdf': 1_700_001_000 }
  );
  return root;
}

describe('runPaperCheck', () => {
  it('runs every check and reports issues with their locations', async () => {
    const root = await sampleProject();
    const report = await run(root, {
      paperPath: 'paper/main.tex',
      anonymity: { names: ['张三'], school: '某某大学', team: '' },
    });

    expect(report.items.map(({ id, verdict }) => [id, verdict])).toEqual([
      ['question-coverage', '发现问题'],
      ['number-consistency', '发现问题'],
      ['figure-labels', '发现问题'],
      ['references', '无法执行'],
      ['pdf-freshness', '发现问题'],
      ['anonymity', '发现问题'],
    ]);
    const byId = new Map(report.items.map((entry) => [entry.id, entry]));
    expect(byId.get('question-coverage')?.issues).toMatchObject([
      { code: 'question-uncovered', params: { number: 3 }, file: '题目/problem.md', line: 7 },
    ]);
    expect(byId.get('number-consistency')?.issues).toMatchObject([
      {
        code: 'number-mismatch',
        params: {
          paperValue: '0.20',
          tableValue: '0.1234',
          runId: RUN_ID,
          table: 'results/summary.csv',
        },
        file: 'paper/main.tex',
        line: 4,
      },
    ]);
    expect(byId.get('figure-labels')?.issues).toMatchObject([
      { code: 'figure-unreadable', params: { reason: 'bitmap' }, file: 'paper/fig/photo.png' },
    ]);
    expect(byId.get('references')?.reason).toBe('offline');
    expect(byId.get('pdf-freshness')?.issues).toMatchObject([
      { code: 'pdf-stale', params: { pdf: 'paper/main.pdf' }, file: 'paper/main.tex' },
    ]);
    expect(byId.get('anonymity')?.issues).toMatchObject([
      {
        code: 'anonymity-hit',
        params: { term: '某某大学', field: 'school' },
        file: 'paper/main.tex',
        line: 6,
      },
    ]);
    expect(Number.isNaN(Date.parse(report.finishedAt))).toBe(false);
  });

  it('verifies references online through the given Crossref client', async () => {
    const root = await sampleProject();
    const crossrefFetch: NonNullable<PaperCheckRunnerDeps['crossref']>['fetch'] = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        message: { items: [{ title: ['Grey prediction of population growth'] }] },
      }),
    });
    const report = await run(
      root,
      { paperPath: 'paper/main.tex', online: true },
      { crossref: { fetch: crossrefFetch } }
    );

    expect(report.items.find(({ id }) => id === 'references')).toMatchObject({
      verdict: '通过',
      issues: [],
    });
    expect(report.items.some(({ id }) => id === 'anonymity')).toBe(false);
  });

  it('marks checks without their inputs as 无法执行 and still runs the rest', async () => {
    const root = await tempProject();
    await writeFiles(root, { 'main.tex': '\\documentclass{article}\n正文。' });

    const report = await run(root, { paperPath: 'main.tex' });

    expect(report.items.map(({ id, verdict, reason }) => [id, verdict, reason])).toEqual([
      ['question-coverage', '无法执行', 'missing-problem-statement'],
      ['number-consistency', '无法执行', 'missing-run-records'],
      ['figure-labels', '无法执行', 'no-figures'],
      ['references', '无法执行', 'no-references'],
      ['pdf-freshness', '发现问题', undefined],
    ]);
    expect(report.items[4].issues).toMatchObject([{ code: 'pdf-missing', params: { pdf: 'main.pdf' } }]);
  });

  it('reports a missing paper source for every check that needs it', async () => {
    const root = await tempProject();
    await writeFiles(root, { 'problem.md': '问题一' });

    const report = await run(root, {
      paperPath: 'paper/missing.tex',
      anonymity: { names: ['张三'], school: '', team: '' },
    });

    expect(report.items.map(({ id, reason }) => [id, reason])).toEqual([
      ['question-coverage', 'missing-paper-source'],
      ['number-consistency', 'missing-paper-source'],
      ['figure-labels', 'missing-paper-source'],
      ['references', 'missing-paper-source'],
      ['pdf-freshness', 'missing-paper-source'],
      ['anonymity', 'missing-paper-source'],
    ]);
  });

  it('keeps going when one check fails or the offline budget is used up', async () => {
    const root = await sampleProject();
    const reader = await createProjectReader(root);
    const failing = {
      ...reader,
      sha256: async () => {
        throw new Error('disk exploded');
      },
    };
    const report = await runPaperCheck(
      { paperPath: 'paper/main.tex', online: false },
      { reader: failing, extractPdfText: fakeExtract }
    );
    const numbers = report.items.find(({ id }) => id === 'number-consistency');
    expect(numbers).toMatchObject({ verdict: '无法执行', reason: 'check-failed', reasonDetail: 'disk exploded' });
    expect(report.items.find(({ id }) => id === 'pdf-freshness')?.verdict).toBe('发现问题');

    const late = await run(root, { paperPath: 'paper/main.tex' }, { offlineBudgetMs: -1 });
    expect(late.items.map(({ id, reason }) => [id, reason])).toEqual([
      ['question-coverage', 'timed-out'],
      ['number-consistency', 'timed-out'],
      ['figure-labels', 'timed-out'],
      ['references', 'offline'],
      ['pdf-freshness', 'timed-out'],
    ]);
  });
});

async function snapshot(root: string): Promise<Array<{ path: string; sha256: string; mtimeMs: number }>> {
  const files: Array<{ path: string; sha256: string; mtimeMs: number }> = [];
  const walk = async (dir: string, relative: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(absolute, child);
      } else {
        const stat = await fs.stat(absolute);
        files.push({ path: child, sha256: sha256(await fs.readFile(absolute)), mtimeMs: stat.mtimeMs });
      }
    }
  };
  await walk(root, '');
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const textArb = fc.string({
  unit: fc.constantFrom('a', 'b', '问', '题', '一', '三', '1', '2', '.', ' ', '\n', '%', '{', '}', '0', 'Q'),
  maxLength: 40,
});

const projectArb = fc.record(
  {
    language: fc.constantFrom<'latex' | 'typst' | 'markdown'>('latex', 'typst', 'markdown'),
    body: textArb,
    sections: fc.array(textArb, { maxLength: 2 }),
    svg: fc.boolean(),
    png: fc.boolean(),
    figurePdf: fc.boolean(),
    paperPdf: fc.constantFrom<'none' | 'readable' | 'broken'>('none', 'readable', 'broken'),
    problem: fc.option(textArb, { nil: null }),
    tableValue: fc.integer({ min: -99999, max: 99999 }),
    tableHashMatches: fc.boolean(),
    anonymity: fc.boolean(),
    mtimes: fc.array(fc.integer({ min: 1_500_000_000, max: 1_800_000_000 }), {
      minLength: 16,
      maxLength: 16,
    }),
  },
  { noNullPrototype: true }
);

type ProjectSpec = typeof projectArb extends fc.Arbitrary<infer T> ? T : never;

function projectFiles(spec: ProjectSpec): { main: string; files: Record<string, string | Uint8Array> } {
  const table = `metric,value\nrmse,${(spec.tableValue / 1000).toFixed(3)}\n`;
  const files: Record<string, string | Uint8Array> = {
    'paper/refs.bib': BIB,
    'results/table.csv': table,
    [`.modelforge/runs/${RUN_ID}.json`]: runRecord([
      { path: 'results/table.csv', sha256: spec.tableHashMatches ? sha256(table) : sha256('old') },
    ]),
    '.modelforge/project.json': JSON.stringify({ origin: { kind: 'example', inputFiles: ['题面.md'] } }),
  };
  if (spec.problem !== null) {
    files['题面.md'] = `问题一 ${spec.problem}`;
  }
  if (spec.svg) {
    files['paper/fig/plot.svg'] = SVG_OK;
  }
  if (spec.png) {
    files['paper/fig/photo.png'] = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  }
  if (spec.figurePdf) {
    files['paper/fig/chart.pdf'] = new Uint8Array([0x25, 0x50, 0x44, 0x46, 9]);
  }
  if (spec.paperPdf !== 'none') {
    files['paper/main.pdf'] = new Uint8Array([spec.paperPdf === 'readable' ? 0x25 : 0, 1, 2]);
  }

  const body = `${spec.body}\nRMSE 为 0.12，某某大学`;
  let main: string;
  if (spec.language === 'latex') {
    main = 'paper/main.tex';
    spec.sections.forEach((text, i) => {
      files[`paper/sec/s${i}.tex`] = text;
    });
    files[main] = [
      '\\documentclass{article}',
      body,
      ...spec.sections.map((_, i) => `\\input{sec/s${i}}`),
      spec.svg ? '\\includesvg{fig/plot}' : '',
      spec.png ? '\\includegraphics{fig/photo}' : '',
      spec.figurePdf ? '\\includegraphics{fig/chart.pdf}' : '',
      '\\cite{zhang2020}',
      '\\bibliography{refs}',
    ].join('\n');
  } else if (spec.language === 'typst') {
    main = 'paper/main.typ';
    spec.sections.forEach((text, i) => {
      files[`paper/sec/s${i}.typ`] = text;
    });
    files[main] = [
      body,
      ...spec.sections.map((_, i) => `#include "sec/s${i}.typ"`),
      spec.svg ? '#image("fig/plot.svg")' : '',
      spec.png ? '#image("fig/photo.png")' : '',
      spec.figurePdf ? '#image("fig/chart.pdf")' : '',
      '@zhang2020',
      '#bibliography("refs.bib")',
    ].join('\n');
  } else {
    main = 'paper/main.md';
    files[main] = [
      body,
      spec.svg ? '![](fig/plot.svg)' : '',
      spec.png ? '![](fig/photo.png)' : '',
      spec.figurePdf ? '![](fig/chart.pdf)' : '',
      '## 参考文献',
      '[1] Zhang S. Grey prediction of population growth[J]. 2020.',
    ].join('\n');
  }
  return { main, files };
}

// Feature: mathmodel-parity-and-beyond, Property 46: 论文检查只读
describe('Property 46: 论文检查只读', () => {
  it('leaves the content and modification time of every file unchanged', async () => {
    await fc.assert(
      fc.asyncProperty(projectArb, async (spec) => {
        const root = await tempProject();
        try {
          const { main, files } = projectFiles(spec);
          const mtimes = Object.fromEntries(
            Object.keys(files).map((file, i) => [file, spec.mtimes[i % spec.mtimes.length]])
          );
          await writeFiles(root, files, mtimes);
          const before = await snapshot(root);

          const report = await run(root, {
            paperPath: main,
            anonymity: spec.anonymity ? { names: ['张三'], school: '某某大学', team: '' } : undefined,
          });

          expect(report.items.length).toBeGreaterThanOrEqual(5);
          expect(await snapshot(root)).toEqual(before);
        } finally {
          await fs.rm(root, { recursive: true, force: true });
        }
      }),
      pbtParams
    );
  }, 120_000);
});

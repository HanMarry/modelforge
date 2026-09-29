import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  checkPdfFreshness,
  collectPaperSources,
  defaultPdfPath,
  extractLatexReferences,
  extractTypstReferences,
  judgePdfFreshness,
  latexCandidates,
  PDF_FRESHNESS_LABELS,
  typstCandidates,
  type DependencyKind,
  type DependencyReference,
  type ProjectFile,
  type TimedFile,
} from './pdfFreshness';

function reference(kind: DependencyKind, target: string): DependencyReference {
  return { kind, command: '\\input', target, line: 1 };
}

function byPath(files: readonly TimedFile[]): TimedFile[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

describe('extractLatexReferences', () => {
  it('finds \\input, \\include, \\includegraphics, bibliographies and \\graphicspath', () => {
    const text = [
      '\\documentclass{article}',
      '\\graphicspath{{figures/}{"my img/"}}',
      '\\input{sec/intro}',
      '\\input sec/plain',
      '\\include{chapters/第一章}',
      '\\includegraphics[width=0.8\\textwidth]{fig/结果 图}',
      '\\includegraphics*[trim={1cm 0 0 0}, clip]{"plot two".png}',
      '% \\input{old}',
      '50\\% done \\input{after-percent}',
      '\\includeonly{chapters/a} \\inputencoding{utf8} \\bibliographystyle{plain}',
      '\\bibliography{refs, extra}',
      '\\addbibresource[location=local]{lib/参考文献.bib}',
      '\\newcommand{\\chapterfile}[1]{\\input{chapters/#1}}',
      'a line break \\\\input{not-a-command}',
      '\\includegraphics',
      '  [width=3cm]',
      '  {fig/split}',
    ].join('\n');

    const { references, graphicsPaths } = extractLatexReferences(text);

    expect(graphicsPaths).toEqual(['figures/', 'my img/']);
    expect(references).toEqual([
      { kind: 'input', command: '\\input', target: 'sec/intro', line: 3 },
      { kind: 'input', command: '\\input', target: 'sec/plain', line: 4 },
      { kind: 'include', command: '\\include', target: 'chapters/第一章', line: 5 },
      { kind: 'graphics', command: '\\includegraphics', target: 'fig/结果 图', line: 6 },
      { kind: 'graphics', command: '\\includegraphics', target: 'plot two.png', line: 7 },
      { kind: 'input', command: '\\input', target: 'after-percent', line: 9 },
      { kind: 'bibliography', command: '\\bibliography', target: 'refs', line: 11 },
      { kind: 'bibliography', command: '\\bibliography', target: 'extra', line: 11 },
      { kind: 'bibliography', command: '\\addbibresource', target: 'lib/参考文献.bib', line: 12 },
      { kind: 'input', command: '\\input', target: 'chapters/#1', line: 13 },
      { kind: 'graphics', command: '\\includegraphics', target: 'fig/split', line: 15 },
    ]);
  });
});

describe('extractTypstReferences', () => {
  it('finds include, image() and bibliography() outside comments', () => {
    const text = [
      '#import "template.typ": conf',
      '#include "chapters/引言.typ"',
      '#let body = include "chapters/模型 建立.typ"',
      '#figure(image("fig/plot.png", width: 80%), caption: [结果])',
      '#figure(',
      '  image("/fig/abs.svg"),',
      ')',
      '// #include "old.typ"',
      '/* image("hidden.png") */',
      '#link("https://example.org") #include "after-link.typ"',
      '#image("esc\\"aped.png")',
      'We include "prose" in markup.',
      '#bibliography("refs.bib")',
      '#myimage("no.png") \\#include "literal.typ"',
    ].join('\n');

    expect(extractTypstReferences(text)).toEqual([
      { kind: 'include', command: '#include', target: 'chapters/引言.typ', line: 2 },
      { kind: 'include', command: 'include', target: 'chapters/模型 建立.typ', line: 3 },
      { kind: 'graphics', command: 'image()', target: 'fig/plot.png', line: 4 },
      { kind: 'graphics', command: 'image()', target: '/fig/abs.svg', line: 6 },
      { kind: 'include', command: '#include', target: 'after-link.typ', line: 10 },
      { kind: 'graphics', command: 'image()', target: 'esc"aped.png', line: 11 },
      { kind: 'bibliography', command: 'bibliography()', target: 'refs.bib', line: 13 },
    ]);
  });
});

describe('path resolution', () => {
  it('adds .tex to \\input and \\include unless present', () => {
    expect(latexCandidates(reference('input', 'sec/intro'), 'paper')).toEqual([
      'paper/sec/intro.tex',
      'paper/sec/intro',
    ]);
    expect(latexCandidates(reference('input', 'sec/intro.TEX'), 'paper')).toEqual([
      'paper/sec/intro.TEX',
    ]);
    expect(latexCandidates(reference('include', '章节/引言'), '')).toEqual([
      '章节/引言.tex',
      '章节/引言',
    ]);
    expect(latexCandidates(reference('bibliography', 'refs'), '')).toEqual(['refs.bib', 'refs']);
  });

  it('tries graphics extensions in order, each in the main directory then \\graphicspath', () => {
    expect(latexCandidates(reference('graphics', 'plot'), 'paper', ['paper/figures'])).toEqual([
      'paper/plot.pdf',
      'paper/figures/plot.pdf',
      'paper/plot.png',
      'paper/figures/plot.png',
      'paper/plot.jpg',
      'paper/figures/plot.jpg',
      'paper/plot.jpeg',
      'paper/figures/plot.jpeg',
      'paper/plot.eps',
      'paper/figures/plot.eps',
      'paper/plot',
      'paper/figures/plot',
    ]);
    expect(latexCandidates(reference('graphics', 'fig/a.PNG'), '')).toEqual(['fig/a.PNG']);
  });

  it('reports macros and paths outside the project', () => {
    expect(latexCandidates(reference('input', '\\dir/x'), '')).toBe('dynamic');
    expect(latexCandidates(reference('input', 'chapters/#1'), '')).toBe('dynamic');
    expect(latexCandidates(reference('input', 'C:/x'), '')).toBe('outside-project');
    expect(latexCandidates(reference('input', '/abs/x'), '')).toBe('outside-project');
    expect(latexCandidates(reference('input', '../../x'), 'paper')).toBe('outside-project');
  });

  it('resolves Typst paths against the including file, or the root for a leading /', () => {
    const ref = (target: string) => reference('graphics', target);

    expect(typstCandidates(ref('fig/a.png'), 'paper/sec/b.typ', 'paper')).toEqual([
      'paper/sec/fig/a.png',
    ]);
    expect(typstCandidates(ref('../fig/a.png'), 'paper/sec/b.typ', 'paper')).toEqual([
      'paper/fig/a.png',
    ]);
    expect(typstCandidates(ref('/fig/a.png'), 'paper/sec/b.typ', 'paper')).toEqual([
      'paper/fig/a.png',
    ]);
    expect(typstCandidates(ref('../../a.png'), 'paper/sec/b.typ', 'paper')).toBe(
      'outside-project'
    );
  });
});

describe('collectPaperSources', () => {
  it('follows LaTeX files transitively and resolves graphics with \\graphicspath', () => {
    const files: ProjectFile[] = [
      {
        path: 'paper/main.tex',
        mtimeMs: 1,
        text: [
          '\\graphicspath{{figures/}}',
          '\\input{sec/intro}',
          '\\includegraphics{fig/plot}',
          '\\includegraphics{heat}',
          '\\includegraphics{Fig/Upper}',
          '\\input{missing}',
          '\\input{../../outside}',
          '\\input{\\dir/x}',
          '\\bibliography{refs}',
        ].join('\n'),
      },
      // Windows separators; `\input{main}` loops back to the main file.
      { path: 'paper\\sec\\intro.tex', mtimeMs: 1, text: '\\input{sec/method}\n\\input{main}' },
      { path: 'paper/sec/method.tex', mtimeMs: 1 },
      { path: 'paper/fig/plot.png', mtimeMs: 1 },
      { path: 'paper/fig/plot.eps', mtimeMs: 1 },
      { path: 'paper/figures/heat.jpg', mtimeMs: 1 },
      { path: 'paper/fig/upper.pdf', mtimeMs: 1 },
      { path: 'paper/refs.bib', mtimeMs: 1 },
      { path: 'paper/unused.tex', mtimeMs: 1, text: '' },
    ];

    const collected = collectPaperSources('paper/main.tex', files);

    expect(collected?.sources).toEqual([
      'paper/main.tex',
      'paper/sec/intro.tex',
      'paper/refs.bib',
      'paper/sec/method.tex',
      'paper/fig/plot.png',
      'paper/figures/heat.jpg',
      'paper/fig/upper.pdf',
    ]);
    expect(collected?.unresolved.map(({ reference: ref, reason }) => [ref.target, reason])).toEqual(
      [
        ['missing', 'not-found'],
        ['../../outside', 'outside-project'],
        ['\\dir/x', 'dynamic'],
      ]
    );
    expect(collected?.unparsed).toEqual(['paper/sec/method.tex']);
  });

  it('follows Typst includes relative to each file and keeps paths inside the root', () => {
    const files: ProjectFile[] = [
      {
        path: '论文/main.typ',
        mtimeMs: 1,
        text: '#include "chapters/a.typ"\n#image("/fig/logo.png")\n#include "chapters/a.typ"',
      },
      {
        path: '论文/chapters/a.typ',
        mtimeMs: 1,
        text: '#image("../fig/x.png")\n#image("../../outside.png")\n#image("missing.png")',
      },
      { path: '论文/fig/logo.png', mtimeMs: 1 },
      { path: '论文/fig/x.png', mtimeMs: 1 },
      { path: 'outside.png', mtimeMs: 1 },
    ];

    const collected = collectPaperSources('论文/main.typ', files);

    expect(collected?.sources).toEqual([
      '论文/main.typ',
      '论文/chapters/a.typ',
      '论文/fig/logo.png',
      '论文/fig/x.png',
    ]);
    expect(collected?.unresolved.map(({ reference: ref, reason }) => [ref.target, reason])).toEqual(
      [
        ['../../outside.png', 'outside-project'],
        ['missing.png', 'not-found'],
      ]
    );
  });

  it('returns null without the main file', () => {
    expect(collectPaperSources('main.tex', [{ path: 'other.tex', mtimeMs: 1, text: '' }])).toBeNull();
  });
});

describe('checkPdfFreshness', () => {
  function project(pdfMtimeMs: number | null): ProjectFile[] {
    const files: ProjectFile[] = [
      { path: 'paper/main.tex', mtimeMs: 100, text: '\\input{sec/a}\n\\includegraphics{fig/b}' },
      { path: 'paper/sec/a.tex', mtimeMs: 300, text: '' },
      { path: 'paper/fig/b.png', mtimeMs: 200 },
      { path: 'paper/notes.md', mtimeMs: 900 },
    ];
    return pdfMtimeMs === null ? files : [...files, { path: 'paper/main.pdf', mtimeMs: pdfMtimeMs }];
  }

  it('reports a stale PDF with the newer sources, newest first', () => {
    const report = checkPdfFreshness({ mainFile: 'paper/main.tex', files: project(150) });

    expect(report.verdict).toBe('发现问题');
    expect(report.status).toBe('stale');
    expect(PDF_FRESHNESS_LABELS.stale).toBe('PDF 已过期');
    expect(report.pdfFile).toBe('paper/main.pdf');
    expect(report.pdfMtimeMs).toBe(150);
    expect(report.newerSources).toEqual([
      { path: 'paper/sec/a.tex', mtimeMs: 300 },
      { path: 'paper/fig/b.png', mtimeMs: 200 },
    ]);
    expect(report.sources.map(({ path }) => path)).toEqual([
      'paper/main.tex',
      'paper/sec/a.tex',
      'paper/fig/b.png',
    ]);
  });

  it('passes when no source is newer than the PDF, ties included', () => {
    const report = checkPdfFreshness({ mainFile: 'paper/main.tex', files: project(300) });

    expect(report.verdict).toBe('通过');
    expect(report.status).toBe('fresh');
    expect(report.newerSources).toEqual([]);
  });

  it('reports a missing PDF', () => {
    const report = checkPdfFreshness({ mainFile: 'paper/main.tex', files: project(null) });

    expect(report.verdict).toBe('发现问题');
    expect(report.status).toBe('missing');
    expect(PDF_FRESHNESS_LABELS.missing).toBe('PDF 缺失');
    expect(report.pdfFile).toBe('paper/main.pdf');
    expect(report.pdfMtimeMs).toBeNull();
    expect(report.newerSources).toEqual([]);
  });

  it('cannot run without the main file', () => {
    const report = checkPdfFreshness({ mainFile: 'paper/nope.tex', files: project(150) });

    expect(report.verdict).toBe('无法执行');
    expect(report.status).toBeNull();
    expect(report.missing).toBe('paper-source');
  });

  it('accepts an explicit PDF path and Windows separators', () => {
    const report = checkPdfFreshness({
      mainFile: 'paper\\main.tex',
      pdfFile: 'out\\paper.pdf',
      files: [...project(null), { path: 'out/paper.pdf', mtimeMs: 50 }],
    });

    expect(report.mainFile).toBe('paper/main.tex');
    expect(report.pdfFile).toBe('out/paper.pdf');
    expect(report.newerSources.map(({ path }) => path)).toEqual([
      'paper/sec/a.tex',
      'paper/fig/b.png',
      'paper/main.tex',
    ]);
  });

  it('derives the PDF path from the main file', () => {
    expect(defaultPdfPath('paper/main.tex')).toBe('paper/main.pdf');
    expect(defaultPdfPath('paper.v2/main')).toBe('paper.v2/main.pdf');
    expect(defaultPdfPath('论文\\终稿.typ')).toBe('论文\\终稿.pdf');
    expect(defaultPdfPath('.hidden')).toBe('.hidden.pdf');
  });
});

/** Half-millisecond steps in a small range, so equal times come up often. */
const mtimeArb = fc.integer({ min: 0, max: 40 }).map((n) => n / 2);

type DependencyState = 'referenced' | 'commented' | 'absent';

interface PoolFile {
  /** Relative to the main file's directory. */
  file: string;
  /** Present for files that are themselves LaTeX or Typst sources. */
  text?: string;
}

interface PoolEntry extends PoolFile {
  /** The line of the main file that pulls the dependency in. */
  line: string;
  /** A file the dependency pulls in in turn. */
  nested?: PoolFile;
}

const LATEX_POOL: readonly PoolEntry[] = [
  {
    line: '\\input{sec/intro}',
    file: 'sec/intro.tex',
    text: '\\input{sec/detail}\n',
    nested: { file: 'sec/detail.tex', text: '' },
  },
  { line: '\\input{sec/模型 建立.tex}', file: 'sec/模型 建立.tex', text: '' },
  { line: '\\include{chapters/结论}', file: 'chapters/结论.tex', text: '' },
  { line: '\\includegraphics[width=0.5\\textwidth]{fig/plot}', file: 'fig/plot.png' },
  { line: '\\includegraphics{"图表/结果 图".pdf}', file: '图表/结果 图.pdf' },
  { line: '\\includegraphics{heat}', file: 'figures/heat.jpg' },
  { line: '\\bibliography{refs}', file: 'refs.bib' },
];

const TYPST_POOL: readonly PoolEntry[] = [
  {
    line: '#include "sec/intro.typ"',
    file: 'sec/intro.typ',
    text: '#image("../fig/in-intro.png")\n',
    nested: { file: 'fig/in-intro.png' },
  },
  { line: '#include "chapters/结论 部分.typ"', file: 'chapters/结论 部分.typ', text: '' },
  { line: '#figure(image("fig/plot.png"), caption: [图])', file: 'fig/plot.png' },
  { line: '#image("/图表/结果 图.svg")', file: '图表/结果 图.svg' },
  { line: '#bibliography("refs.bib")', file: 'refs.bib' },
];

type Language = 'latex' | 'typst';

const SETUP: Readonly<
  Record<Language, { pool: readonly PoolEntry[]; header: string; comment: string; main: string }>
> = {
  latex: {
    pool: LATEX_POOL,
    header: '\\documentclass{article}\n\\graphicspath{{figures/}}\n',
    comment: '% ',
    main: 'main.tex',
  },
  typst: {
    pool: TYPST_POOL,
    header: '#set page(paper: "a4")\n#set text(lang: "zh")\n',
    comment: '// ',
    main: 'main.typ',
  },
};

/** Files in the project that no source references; `fig/plot.eps` loses to `fig/plot.png`. */
const UNRELATED: Readonly<Record<Language, readonly string[]>> = {
  latex: ['fig/plot.eps', 'fig/unused.png', 'notes.md'],
  typst: ['fig/unused.png', 'notes.md', 'sec/unused.typ'],
};

/** Main file, every pool file with its nested file, and the unrelated files. */
function fileCount(language: Language): number {
  const { pool } = SETUP[language];
  const nested = pool.filter((entry) => entry.nested !== undefined).length;
  return 1 + pool.length + nested + UNRELATED[language].length;
}

const projectArb = fc
  .tuple(
    fc.constantFrom<Language>('latex', 'typst'),
    fc.constantFrom('paper', '论文 终稿', ''),
    fc.boolean()
  )
  .chain(([language, root, backslashes]) =>
    fc.tuple(
      fc.constant(language),
      fc.constant(root),
      fc.constant(backslashes),
      fc.array(fc.constantFrom<DependencyState>('referenced', 'commented', 'absent'), {
        minLength: SETUP[language].pool.length,
        maxLength: SETUP[language].pool.length,
      }),
      fc.array(mtimeArb, { minLength: fileCount(language), maxLength: fileCount(language) }),
      fc.option(mtimeArb)
    )
  );

// Feature: mathmodel-parity-and-beyond, Property 45: PDF 新鲜度判定
describe('Property 45: PDF 新鲜度判定', () => {
  it('is stale exactly when some source is newer, listing exactly those sources', () => {
    const paths = ['main.tex', 'sec/引言.tex', 'fig/结果 图.png', 'refs.bib', 'a.typ', 'x.jpg'];
    const sourcesArb = fc.uniqueArray(fc.tuple(fc.constantFrom(...paths), mtimeArb), {
      selector: ([path]) => path,
      maxLength: paths.length,
    });

    fc.assert(
      fc.property(fc.option(mtimeArb), sourcesArb, (pdfMtimeMs, entries) => {
        const sources = entries.map(([path, mtimeMs]) => ({ path, mtimeMs }));
        const judgement = judgePdfFreshness(pdfMtimeMs, sources);

        if (pdfMtimeMs === null) {
          expect(judgement).toEqual({ status: 'missing', newerSources: [] });
          return;
        }
        const pdfTime = pdfMtimeMs;
        const newer = sources.filter(({ mtimeMs }) => mtimeMs > pdfTime);
        expect(judgement.status).toBe(newer.length > 0 ? 'stale' : 'fresh');
        expect(byPath(judgement.newerSources)).toEqual(byPath(newer));
        judgement.newerSources.forEach((source, i) => {
          if (i > 0) {
            expect(judgement.newerSources[i - 1].mtimeMs).toBeGreaterThanOrEqual(source.mtimeMs);
          }
        });
      }),
      pbtParams
    );
  });

  it('compares the PDF with exactly the sources the main file pulls in', () => {
    fc.assert(
      fc.property(
        projectArb,
        ([language, root, backslashes, states, mtimes, pdfMtimeMs]) => {
          const { pool, header, comment, main } = SETUP[language];
          const at = (relative: string) => (root === '' ? relative : `${root}/${relative}`);
          const native = (path: string) => (backslashes ? path.replace(/\//g, '\\') : path);

          const mainText =
            header +
            pool
              .map((entry, i) => {
                if (states[i] === 'referenced') {
                  return `${entry.line}\n`;
                }
                return states[i] === 'commented' ? `${comment}${entry.line}\n` : '';
              })
              .join('');
          const layout: Array<{ path: string; text: string | undefined; source: boolean }> = [
            { path: at(main), text: mainText, source: true },
            ...pool.flatMap((entry, i) => {
              const source = states[i] === 'referenced';
              const own = { path: at(entry.file), text: entry.text, source };
              return entry.nested === undefined
                ? [own]
                : [own, { path: at(entry.nested.file), text: entry.nested.text, source }];
            }),
            ...UNRELATED[language].map((file) => ({ path: at(file), text: undefined, source: false })),
          ];
          const files: ProjectFile[] = layout.map(({ path, text }, i) => ({
            path: native(path),
            mtimeMs: mtimes[i],
            text,
          }));
          if (pdfMtimeMs !== null) {
            files.push({ path: native(at('main.pdf')), mtimeMs: pdfMtimeMs });
          }
          const expectedSources = layout
            .map(({ path, source }, i) => ({ path, mtimeMs: mtimes[i], source }))
            .filter(({ source }) => source)
            .map(({ path, mtimeMs }) => ({ path, mtimeMs }));

          const report = checkPdfFreshness({ mainFile: native(at(main)), files });

          expect(byPath(report.sources)).toEqual(byPath(expectedSources));
          expect(report.unresolved).toEqual([]);
          expect(report.unparsed).toEqual([]);
          if (pdfMtimeMs === null) {
            expect(report.status).toBe('missing');
            expect(report.verdict).toBe('发现问题');
            expect(report.newerSources).toEqual([]);
            return;
          }
          const pdfTime = pdfMtimeMs;
          const newer = expectedSources.filter(({ mtimeMs }) => mtimeMs > pdfTime);
          expect(byPath(report.newerSources)).toEqual(byPath(newer));
          expect(report.status).toBe(newer.length > 0 ? 'stale' : 'fresh');
          expect(report.verdict).toBe(newer.length > 0 ? '发现问题' : '通过');
        }
      ),
      pbtParams
    );
  });
});

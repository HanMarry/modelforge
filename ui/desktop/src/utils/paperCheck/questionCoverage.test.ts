import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import type { SourceText } from './common';
import {
  checkQuestionCoverage,
  extractQuestionMentions,
  parseQuestionNumeral,
} from './questionCoverage';

function numbersIn(text: string, path = '题面.md'): number[] {
  return extractQuestionMentions({ path, text }).map(({ number }) => number);
}

const CHINESE_DIGITS = '一二三四五六七八九';

/** 1–99 as written in Chinese: 三, 十, 十三, 三十, 三十三. */
function toChinese(n: number): string {
  if (n < 10) {
    return CHINESE_DIGITS[n - 1];
  }
  const tens = Math.floor(n / 10);
  const ones = n % 10;
  return `${tens === 1 ? '' : CHINESE_DIGITS[tens - 1]}十${ones === 0 ? '' : CHINESE_DIGITS[ones - 1]}`;
}

function toFullWidth(n: number): string {
  return String(n).replace(/\d/g, (digit) => String.fromCharCode(0xff10 + Number(digit)));
}

/** Ways a problem statement or paper writes question n. */
const STYLES: ReadonlyArray<(n: number) => string> = [
  (n) => `问题${toChinese(n)}`,
  (n) => `问题 ${n}`,
  (n) => `问题${n}`,
  (n) => `Q${n}`,
  (n) => `第${toChinese(n)}问`,
  (n) => `第 ${n} 个问题`,
  (n) => `问题（${n}）`,
  (n) => `Ｑ${toFullWidth(n)}`,
];

describe('parseQuestionNumeral', () => {
  it.each<[string, number]>([
    ['1', 1],
    ['07', 7],
    ['99', 99],
    ['三', 3],
    ['十', 10],
    ['十二', 12],
    ['一十', 10],
    ['二十', 20],
    ['二十三', 23],
    ['九十九', 99],
  ])('reads %s as %d', (numeral, value) => {
    expect(parseQuestionNumeral(numeral)).toBe(value);
  });

  it.each(['0', '100', '2023', '十十', '二二', '三十十', '十二三', ''])('rejects %j', (numeral) => {
    expect(parseQuestionNumeral(numeral)).toBeNull();
  });

  it('reads every number 1–99 written in Chinese', () => {
    for (let n = 1; n <= 99; n++) {
      expect(parseQuestionNumeral(toChinese(n))).toBe(n);
    }
  });
});

describe('extractQuestionMentions', () => {
  it('recognises the usual ways of numbering questions', () => {
    const text = [
      '问题一：建立模型',
      '问题 2：求解',
      '问题3',
      'Q4: 灵敏度',
      '第五问',
      '第 6 个问题',
      '问题（7）',
      '问题~8',
      '问题 十一',
    ].join('\n');

    expect(numbersIn(text)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 11]);
  });

  it('reads lists joined by 、', () => {
    expect(numbersIn('问题一、二的求解')).toEqual([1, 2]);
    expect(numbersIn('问题1、2、3')).toEqual([1, 2, 3]);
    expect(numbersIn('第一、二问')).toEqual([1, 2]);
  });

  it('normalises full-width and circled forms', () => {
    expect(numbersIn('Ｑ２')).toEqual([2]);
    expect(numbersIn('问题①')).toEqual([1]);
    expect(numbersIn('问题（３）')).toEqual([3]);
    expect(numbersIn('问题\u3000四')).toEqual([4]);
  });

  it.each([
    '这个问题十分重要',
    '该问题一般可以用线性规划求解',
    '两个问题一样',
    '将其分解为子问题1与子问题2',
    'FAQ1',
    '2023Q4 的销量',
    '$Q_1$ 表示流量',
    '(1) 建立模型；(2) 求解',
    '1. 建立模型',
    '问题2023',
    '问题0',
    'Problem 1',
  ])('finds no question number in %j', (text) => {
    expect(numbersIn(text)).toEqual([]);
  });

  it('keeps headings whose next word only looks like an idiom', () => {
    expect(numbersIn('问题一定价与补货')).toEqual([1]);
    expect(numbersIn('问题一时间序列预测')).toEqual([1]);
  });

  it('does not expand ranges', () => {
    expect(numbersIn('问题1-3')).toEqual([1]);
  });

  it('ignores comments in LaTeX, Typst and Markdown, not in plain text', () => {
    expect(numbersIn('% 问题一\n问题二 % Q3', 'main.tex')).toEqual([2]);
    expect(numbersIn('// 问题一\n/* Q2 */ 问题三', 'sec/分析.typ')).toEqual([3]);
    expect(numbersIn('<!-- 问题一 -->问题二', 'notes.md')).toEqual([2]);
    expect(numbersIn('% 问题一', '题面.txt')).toEqual([1]);
  });

  it('records the path, line and words of each mention', () => {
    expect(extractQuestionMentions({ path: 'p.md', text: '\r\n\r\n  问题二的背景' })).toEqual([
      { number: 2, literal: '问题二', path: 'p.md', line: 3 },
    ]);
  });
});

describe('checkQuestionCoverage', () => {
  const problem: SourceText = {
    path: '题面/A 题.md',
    text: '问题一 预测销量。\n问题二 优化补货。\n问题三 评估策略。',
  };

  it('lists the questions the paper never mentions, with where they are stated', () => {
    const paper: SourceText[] = [
      { path: 'main.tex', text: '\\section{问题一的模型}\n% 问题二 TODO\n' },
      { path: 'sec/q3.typ', text: '= Q3 求解\n问题五不在题面里' },
    ];

    expect(checkQuestionCoverage([problem], paper)).toEqual({
      verdict: '发现问题',
      missing: null,
      questions: [1, 2, 3],
      covered: [1, 3],
      uncovered: [
        {
          number: 2,
          statedAt: { number: 2, literal: '问题二', path: '题面/A 题.md', line: 2 },
        },
      ],
    });
  });

  it('passes when every question is mentioned', () => {
    const paper: SourceText[] = [{ path: 'main.tex', text: '问题 1\n第二问\nQ3' }];
    const report = checkQuestionCoverage([problem], paper);

    expect(report.verdict).toBe('通过');
    expect(report.uncovered).toEqual([]);
  });

  it('cannot run without a problem statement, a paper or a question number', () => {
    const paper: SourceText[] = [{ path: 'main.tex', text: '问题一' }];

    expect(checkQuestionCoverage([], paper)).toMatchObject({
      verdict: '无法执行',
      missing: 'problem-statement',
    });
    expect(checkQuestionCoverage([problem], [])).toMatchObject({
      verdict: '无法执行',
      missing: 'paper-source',
    });
    expect(checkQuestionCoverage([{ path: 'p.md', text: '请建立模型' }], paper)).toMatchObject({
      verdict: '无法执行',
      missing: 'question-numbers',
    });
  });
});

interface Piece {
  style: number;
  filler: string;
  before: string;
  after: string;
  file: number;
}

/** Text between mentions; it can never be read as, or change, a question number. */
const fillerArb = fc.string({
  unit: fc.constantFrom(...Array.from('模型数据分析求解ab x。\n：的')),
  maxLength: 8,
});

const pieceArb: fc.Arbitrary<Piece> = fc
  .tuple(
    fc.nat({ max: STYLES.length - 1 }),
    fillerArb,
    fc.constantFrom('\n', '。', '：', ' ', '，'),
    fc.constantFrom('：', '。', '\n', '的', ' 的', '，'),
    fc.nat({ max: 2 })
  )
  .map(([style, filler, before, after, file]) => ({ style, filler, before, after, file }));

function render(n: number, piece: Piece): string {
  return `${piece.filler}${piece.before}${STYLES[piece.style](n)}${piece.after}`;
}

const PAPER_PATHS = ['main.tex', 'sec/分析 结果.typ', 'appendix.md'];

/** A mention of question n inside a comment of the paper file `file`. */
function commented(n: number, piece: Piece): string {
  const mention = STYLES[piece.style](n);
  switch (piece.file) {
    case 0:
      return `\n% 待补充 ${mention}\n`;
    case 1:
      return piece.style % 2 === 0 ? `\n// 待补充 ${mention}\n` : `/* ${mention} */`;
    default:
      return `<!-- ${mention} -->`;
  }
}

const scenarioArb = fc
  .uniqueArray(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 8 })
  .chain((questions) =>
    fc.tuple(
      fc.constant(questions),
      fc.subarray(questions),
      fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 3 }),
      fc.array(pieceArb, { minLength: questions.length, maxLength: questions.length }),
      fc.array(pieceArb, { minLength: questions.length + 3, maxLength: questions.length + 3 }),
      fc.array(pieceArb, { minLength: questions.length, maxLength: questions.length }),
      fc.constantFrom('题面.md', 'problem statement.txt')
    )
  );

// Feature: mathmodel-parity-and-beyond, Property 43: 问题编号覆盖
describe('Property 43: 问题编号覆盖', () => {
  it('finds exactly the stated questions and reports those the paper never mentions', () => {
    fc.assert(
      fc.property(
        scenarioArb,
        ([questions, mentioned, extras, problemPieces, paperPieces, commentPieces, problemPath]) => {
          const problemText = questions.map((n, i) => render(n, problemPieces[i])).join('');

          // Numbers the paper mentions: some stated questions plus some the statement lacks.
          const paperNumbers = [...mentioned, ...extras.filter((n) => !questions.includes(n))];
          const chunks: string[][] = PAPER_PATHS.map(() => []);
          paperNumbers.forEach((n, i) => {
            const piece = paperPieces[i];
            chunks[piece.file].push(render(n, piece));
          });
          // The rest appear only inside comments, which must not count.
          questions
            .filter((n) => !mentioned.includes(n))
            .forEach((n, i) => {
              const piece = commentPieces[i];
              chunks[piece.file].push(commented(n, piece));
            });
          const paper = PAPER_PATHS.map((path, i) => ({ path, text: chunks[i].join('') }));

          const report = checkQuestionCoverage([{ path: problemPath, text: problemText }], paper);

          const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
          const expectedUncovered = sorted(questions.filter((n) => !mentioned.includes(n)));
          expect(report.questions).toEqual(sorted(questions));
          expect(report.covered).toEqual(sorted(mentioned));
          expect(report.uncovered.map(({ number }) => number)).toEqual(expectedUncovered);
          expect(report.uncovered.every(({ statedAt }) => statedAt.path === problemPath)).toBe(
            true
          );
          expect(report.verdict).toBe(expectedUncovered.length === 0 ? '通过' : '发现问题');
        }
      ),
      pbtParams
    );
  });
});

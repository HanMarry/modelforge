/**
 * Question coverage (spec mathmodel-parity-and-beyond, requirement 18.1, Property 43): every
 * question number stated in the problem statement must appear at least once in the paper
 * sources, in a heading or a paragraph.
 *
 * Recognised ways of writing question n, after NFKC normalisation (so full-width `Ｑ１` and
 * `问题（２）` and circled `问题①` count as their ASCII forms):
 *
 * - `问题` + Chinese numeral or digits, with optional spaces, LaTeX `~` or an opening bracket:
 *   `问题三`, `问题 3`, `问题~3`, `问题（3）`. A list joined by `、` names several questions:
 *   `问题一、二`.
 * - `第` + numeral + `问` or `个问题`: `第三问`, `第 3 个问题`, `第一、二问`.
 * - `Q` + digits, not preceded by a letter, digit or `_`: `Q3` (but not `FAQ3`, `2023Q4`, `Q_3`).
 *
 * Deliberately not recognised: bare list markers such as `(1)` or `1.`, which also number
 * equations, sub-items and references; ranges (`问题1-3`, `问题一至三`); lists joined by `和`/`，`;
 * `子问题` (sub-problems of a model); English `Problem 1`/`Task 1`. Numbers outside 1–99 are
 * ignored, so `问题2023` is not question 2023. `问题一般`, `问题十分` and similar words are not
 * question numbers.
 *
 * Comments are ignored in paper sources (LaTeX `%`, Typst `//` and `/* *\/`, Markdown
 * `<!-- -->`), chosen by file extension.
 */

import {
  sourceLanguageOf,
  splitLines,
  stripComments,
  type PaperCheckVerdict,
  type SourceText,
} from './common';

export const MAX_QUESTION_NUMBER = 99;

export interface QuestionMention {
  number: number;
  /** The words as written (NFKC-normalised), for example `问题三` or `Q3`. */
  literal: string;
  path: string;
  /** 1-based line in `path`. */
  line: number;
}

export interface UncoveredQuestion {
  number: number;
  /** Where the problem statement first states the question, for jumping to it. */
  statedAt: QuestionMention;
}

/** Input the check needs but did not get (requirement 18.7). */
export type QuestionCoverageMissing = 'problem-statement' | 'paper-source' | 'question-numbers';

export interface QuestionCoverageReport {
  verdict: PaperCheckVerdict;
  /** Set only when the verdict is `无法执行`. */
  missing: QuestionCoverageMissing | null;
  /** Question numbers stated in the problem statement, ascending. */
  questions: number[];
  /** Questions the paper mentions, ascending. */
  covered: number[];
  /** Questions the paper never mentions, ascending. */
  uncovered: UncoveredQuestion[];
}

const CHINESE_DIGITS = '一二三四五六七八九';

/**
 * Words where 一 or 十 after `问题` is not a number: 问题一般, 问题一样, 问题十分… Only words
 * that rarely start a heading are listed, so `问题一定价`, `问题一时间序列` still count.
 */
const IDIOM_AFTER_ONE = '般样旦直些起致切再律概向味贯';
const IDIOM_AFTER_TEN = '分足';

const LIST_SEPARATOR = /[\s~]*、[\s~]*/;

interface QuestionPattern {
  regex: RegExp;
  /** Whether the character after the match may turn the last numeral into a word. */
  checkIdiom: boolean;
}

// Group 1 holds one numeral, or several joined by `、`.
const PATTERNS: readonly QuestionPattern[] = [
  {
    regex:
      /(?<!子)问题[\s~]*(?:\([\s~]*)?((?:\d+|[一二三四五六七八九十]+)(?:[\s~]*、[\s~]*(?:\d+|[一二三四五六七八九十]+))*)/g,
    checkIdiom: true,
  },
  {
    regex:
      /第[\s~]*((?:\d+|[一二三四五六七八九十]+)(?:[\s~]*、[\s~]*(?:\d+|[一二三四五六七八九十]+))*)[\s~]*(?:个问题|问)/g,
    checkIdiom: false,
  },
  { regex: /(?<![A-Za-z0-9_])Q(\d+)/g, checkIdiom: false },
];

function chineseDigit(ch: string): number {
  return CHINESE_DIGITS.indexOf(ch) + 1;
}

/** 一…九十九 in the usual forms: 三, 十, 十三, 三十, 三十三 (and 一十三). Anything else is `null`. */
function parseChineseNumeral(numeral: string): number | null {
  const ten = numeral.indexOf('十');
  if (ten === -1) {
    return numeral.length === 1 ? chineseDigit(numeral) || null : null;
  }
  const tensPart = numeral.slice(0, ten);
  const onesPart = numeral.slice(ten + 1);
  if (tensPart.length > 1 || onesPart.length > 1) {
    return null;
  }
  const tens = tensPart === '' ? 1 : chineseDigit(tensPart);
  const ones = onesPart === '' ? 0 : chineseDigit(onesPart);
  if (tens === 0 || (onesPart !== '' && ones === 0)) {
    return null;
  }
  return tens * 10 + ones;
}

/**
 * The integer a question numeral stands for: ASCII digits (`3`, `03`) or a Chinese numeral
 * (`三`, `十二`). `null` for anything else or outside 1–`MAX_QUESTION_NUMBER`.
 */
export function parseQuestionNumeral(numeral: string): number | null {
  const value = /^\d+$/.test(numeral) ? Number(numeral) : parseChineseNumeral(numeral);
  return value !== null && value >= 1 && value <= MAX_QUESTION_NUMBER ? value : null;
}

function isIdiom(numeral: string, following: string): boolean {
  if (following === '') {
    return false;
  }
  if (numeral === '一') {
    return IDIOM_AFTER_ONE.includes(following);
  }
  if (numeral === '十') {
    return IDIOM_AFTER_TEN.includes(following);
  }
  return false;
}

/** Every question number written in `file`, in order of appearance, comments excluded. */
export function extractQuestionMentions(file: SourceText): QuestionMention[] {
  const text = stripComments(file.text, sourceLanguageOf(file.path));
  const mentions: QuestionMention[] = [];
  splitLines(text).forEach((rawLine, lineIndex) => {
    const line = rawLine.normalize('NFKC');
    const found: Array<{ offset: number; mention: QuestionMention }> = [];
    for (const { regex, checkIdiom } of PATTERNS) {
      for (const match of line.matchAll(regex)) {
        const offset = match.index ?? 0;
        const numerals = match[1].split(LIST_SEPARATOR);
        const following = line.charAt(offset + match[0].length);
        numerals.forEach((numeral, position) => {
          if (checkIdiom && position === numerals.length - 1 && isIdiom(numeral, following)) {
            return;
          }
          const number = parseQuestionNumeral(numeral);
          if (number !== null) {
            found.push({
              offset,
              mention: { number, literal: match[0], path: file.path, line: lineIndex + 1 },
            });
          }
        });
      }
    }
    // Stable sort keeps list members in their written order.
    found.sort((a, b) => a.offset - b.offset);
    for (const { mention } of found) {
      mentions.push(mention);
    }
  });
  return mentions;
}

function cannotRun(missing: QuestionCoverageMissing): QuestionCoverageReport {
  return { verdict: '无法执行', missing, questions: [], covered: [], uncovered: [] };
}

/**
 * Compares the question numbers of the problem statement with those the paper mentions.
 * `无法执行` when there is no problem statement, no paper source, or no recognisable question
 * number in the problem statement (a vacuous pass would hide that the check did nothing).
 */
export function checkQuestionCoverage(
  problemFiles: readonly SourceText[],
  paperFiles: readonly SourceText[]
): QuestionCoverageReport {
  if (problemFiles.length === 0) {
    return cannotRun('problem-statement');
  }
  if (paperFiles.length === 0) {
    return cannotRun('paper-source');
  }

  const stated = new Map<number, QuestionMention>();
  for (const file of problemFiles) {
    for (const mention of extractQuestionMentions(file)) {
      if (!stated.has(mention.number)) {
        stated.set(mention.number, mention);
      }
    }
  }
  if (stated.size === 0) {
    return cannotRun('question-numbers');
  }

  const mentioned = new Set<number>();
  for (const file of paperFiles) {
    for (const mention of extractQuestionMentions(file)) {
      mentioned.add(mention.number);
    }
  }

  const statements = [...stated.values()].sort((a, b) => a.number - b.number);
  const covered = statements.filter(({ number }) => mentioned.has(number));
  const uncovered = statements.filter(({ number }) => !mentioned.has(number));
  return {
    verdict: uncovered.length === 0 ? '通过' : '发现问题',
    missing: null,
    questions: statements.map(({ number }) => number),
    covered: covered.map(({ number }) => number),
    uncovered: uncovered.map((statedAt) => ({ number: statedAt.number, statedAt })),
  };
}

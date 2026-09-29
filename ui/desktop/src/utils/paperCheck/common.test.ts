import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  dirnameOf,
  isEscaped,
  isWithin,
  joinProjectPath,
  lineAt,
  lineStarts,
  normalizeProjectPath,
  sourceLanguageOf,
  splitLines,
  stripComments,
  type SourceLanguage,
} from './common';

describe('sourceLanguageOf', () => {
  it.each<[string, SourceLanguage]>([
    ['paper/main.tex', 'latex'],
    ['论文 终稿\\MAIN.TEX', 'latex'],
    ['old.ltx', 'latex'],
    ['paper/main.typ', 'typst'],
    ['README.md', 'markdown'],
    ['notes.markdown', 'markdown'],
    ['题面.txt', 'plain'],
    ['tex', 'plain'],
    ['dir.tex/file', 'plain'],
  ])('%s is %s', (path, language) => {
    expect(sourceLanguageOf(path)).toBe(language);
  });
});

describe('stripComments', () => {
  it('removes LaTeX comments but keeps \\%', () => {
    expect(stripComments('a % c\nb \\% d % e\n', 'latex')).toBe('a \nb \\% d \n');
    // `\\` is a line break, so the `%` after it starts a comment.
    expect(stripComments('x\\\\% c', 'latex')).toBe('x\\\\');
  });

  it('removes Typst line and nested block comments, not // in strings or URLs', () => {
    const text = [
      'a // c',
      '#link("https://x.org") // d',
      '/* x',
      ' y */ z',
      'https://e.org/p',
      '"s // t"',
      '/* a /* b */ c */d',
    ].join('\n');

    expect(stripComments(text, 'typst')).toBe(
      ['a ', '#link("https://x.org") ', '', ' z', 'https://e.org/p', '"s // t"', 'd'].join('\n')
    );
  });

  it('removes Markdown HTML comments, including an unterminated one', () => {
    expect(stripComments('a <!-- b\nc --> d', 'markdown')).toBe('a \n d');
    expect(stripComments('a\n<!-- open\nstill', 'markdown')).toBe('a\n\n');
  });

  it('leaves plain text alone apart from line endings', () => {
    expect(stripComments('% 问题一\r\n// Q2\r<!-- x -->', 'plain')).toBe(
      '% 问题一\n// Q2\n<!-- x -->'
    );
  });

  it('keeps every line at its number', () => {
    const textArb = fc.string({
      unit: fc.constantFrom(...Array.from('a问%\\/*":<!-> \n\r')),
      maxLength: 60,
    });
    const languageArb = fc.constantFrom<SourceLanguage>('latex', 'typst', 'markdown', 'plain');

    fc.assert(
      fc.property(textArb, languageArb, (text, language) => {
        expect(splitLines(stripComments(text, language))).toHaveLength(splitLines(text).length);
      }),
      pbtParams
    );
  });
});

describe('isEscaped', () => {
  it('counts the backslashes before a character', () => {
    expect(isEscaped('\\%', 1)).toBe(true);
    expect(isEscaped('\\\\%', 2)).toBe(false);
    expect(isEscaped('%', 0)).toBe(false);
  });
});

describe('lineAt', () => {
  it('maps offsets to 1-based lines', () => {
    const starts = lineStarts('a\nbc\n\nd');

    expect(starts).toEqual([0, 2, 5, 6]);
    expect([0, 1, 2, 4, 5, 6].map((offset) => lineAt(starts, offset))).toEqual([1, 1, 2, 2, 3, 4]);
  });
});

describe('project paths', () => {
  it('normalises separators, . and ..', () => {
    expect(normalizeProjectPath('a\\b/./c/../d')).toBe('a/b/d');
    expect(normalizeProjectPath('/论文 终稿//图 1.png/')).toBe('论文 终稿/图 1.png');
    expect(normalizeProjectPath('../x')).toBeNull();
    expect(normalizeProjectPath('a/../..')).toBeNull();
    expect(normalizeProjectPath('')).toBe('');
  });

  it('joins relative to a directory', () => {
    expect(joinProjectPath('paper', '../fig/a.png')).toBe('fig/a.png');
    expect(joinProjectPath('', 'sec/intro.tex')).toBe('sec/intro.tex');
    expect(joinProjectPath('', '../a')).toBeNull();
    expect(dirnameOf('paper/sec/intro.tex')).toBe('paper/sec');
    expect(dirnameOf('main.tex')).toBe('');
  });

  it('tells whether a path lies below a directory', () => {
    expect(isWithin('', 'a/b')).toBe(true);
    expect(isWithin('paper', 'paper/fig/a.png')).toBe(true);
    expect(isWithin('paper', 'paper')).toBe(true);
    expect(isWithin('paper', 'paper2/a.png')).toBe(false);
  });
});

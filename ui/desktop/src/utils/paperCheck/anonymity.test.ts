import { describe, expect, it } from 'vitest';
import { anonymityTerms, checkAnonymity, findAnonymityHits } from './anonymity';
import type { PdfPageText } from './pdfTextLayer';

const profile = {
  names: ['张三、李四', 'Wang Wu', ' ', '王', '张 三'],
  school: '某某大学',
  team: '数模小队',
};

function page(number: number, texts: string[]): PdfPageText {
  return {
    page: number,
    width: 595,
    height: 842,
    items: texts.map((text, i) => ({ text, x: 72 + i * 12, y: 700, angle: 0, endOfLine: false })),
  };
}

describe('anonymityTerms', () => {
  it('splits lists of names, drops one-character terms and repeats', () => {
    expect(anonymityTerms(profile)).toEqual([
      { term: '张三', field: 'name' },
      { term: '李四', field: 'name' },
      { term: 'Wang Wu', field: 'name' },
      { term: '某某大学', field: 'school' },
      { term: '数模小队', field: 'team' },
    ]);
  });
});

describe('findAnonymityHits', () => {
  it('lists source lines and PDF pages, ignoring case, spaces and comments', () => {
    const sources = [
      {
        path: 'paper/main.tex',
        text: ['\\author{张三}', '% 李四 wrote this', 'Thanks to WangWu.'].join('\n'),
      },
      { path: 'paper/cumcm.cls', text: '\\fancyhead[L]{某某 大学}\n% 数模小队' },
    ];
    const pdf = { path: 'paper/main.pdf', pages: [page(1, ['数', '模', '小', '队']), page(2, ['正文'])] };

    expect(findAnonymityHits(anonymityTerms(profile), sources, pdf)).toEqual([
      { term: '张三', field: 'name', path: 'paper/main.tex', line: 1 },
      { term: 'Wang Wu', field: 'name', path: 'paper/main.tex', line: 3 },
      { term: '某某大学', field: 'school', path: 'paper/cumcm.cls', line: 1 },
      { term: '数模小队', field: 'team', path: 'paper/main.pdf', page: 1 },
    ]);
  });
});

describe('checkAnonymity', () => {
  const clean = [{ path: 'main.typ', text: '= 摘要\n本文 // 张三\n研究了……' }];

  it('passes when no term appears', () => {
    expect(checkAnonymity(profile, clean, { path: 'main.pdf', pages: [page(1, ['摘要'])] })).toEqual(
      { verdict: '通过', missing: null, hits: [], unreadablePdf: null }
    );
  });

  it('cannot pass when the PDF text cannot be read', () => {
    expect(checkAnonymity(profile, clean, { path: 'main.pdf', pages: null })).toMatchObject({
      verdict: '发现问题',
      unreadablePdf: 'main.pdf',
    });
  });

  it('cannot run without terms or without anything to search', () => {
    expect(checkAnonymity({ names: [], school: ' ', team: 'A' }, clean, null)).toMatchObject({
      verdict: '无法执行',
      missing: 'profile',
    });
    expect(checkAnonymity(profile, [], null)).toMatchObject({
      verdict: '无法执行',
      missing: 'paper-source',
    });
  });
});

import { describe, expect, it } from 'vitest';
import { REVIEW_DIMENSIONS, type ReviewRecord } from './reviewModel';
import {
  normalizePaperPath,
  parseStoredRecord,
  recordFileAttempt,
  reviewPaperFormat,
  reviewRecordFileName,
  sortRecords,
} from './reviewRecord';

function record(completedAt: string, paper = 'paper/main.tex'): ReviewRecord {
  return {
    paper,
    competitionId: 'cumcm',
    completedAt,
    dimensions: REVIEW_DIMENSIONS.map((name) => ({ name, score: 6, reasons: ['理由'] })),
    suggestions: [{ text: '改写摘要', location: { section: '摘要', page: 1 } }],
  };
}

describe('normalizePaperPath', () => {
  it('normalizes separators and drops empty and dot segments', () => {
    expect(normalizePaperPath('paper\\sections\\.\\intro.tex')).toBe('paper/sections/intro.tex');
    expect(normalizePaperPath('paper//main.tex')).toBe('paper/main.tex');
    expect(normalizePaperPath('论文 终稿/main.md')).toBe('论文 终稿/main.md');
  });

  it('refuses paths that are absolute, empty or climb out of the project', () => {
    for (const raw of ['', '.', '/etc/passwd', 'C:/x.tex', 'c:x.tex', '\\\\server\\share\\a.tex']) {
      expect(normalizePaperPath(raw)).toBeNull();
    }
    expect(normalizePaperPath('../a.tex')).toBeNull();
    expect(normalizePaperPath('paper/../../a.tex')).toBeNull();
    expect(normalizePaperPath('paper/../a.tex')).toBeNull();
    expect(normalizePaperPath('a\0.tex')).toBeNull();
    expect(normalizePaperPath(42)).toBeNull();
  });
});

describe('reviewPaperFormat', () => {
  it('maps the extensions the review skill reads', () => {
    expect(reviewPaperFormat('paper/Main.TEX')).toBe('latex');
    expect(reviewPaperFormat('notes.md')).toBe('markdown');
    expect(reviewPaperFormat('notes.markdown')).toBe('markdown');
    expect(reviewPaperFormat('out/paper.pdf')).toBe('pdf');
    expect(reviewPaperFormat('paper.typ')).toBeNull();
    expect(reviewPaperFormat('.tex')).toBeNull();
    expect(reviewPaperFormat('README')).toBeNull();
  });
});

describe('record file names', () => {
  it('uses the UTC time without colons and counts same-millisecond suffixes', () => {
    const time = new Date('2026-09-29T10:15:30.123Z');
    expect(reviewRecordFileName(time)).toBe('2026-09-29T10-15-30.123Z.json');
    expect(reviewRecordFileName(time, 2)).toBe('2026-09-29T10-15-30.123Z-2.json');
    expect(recordFileAttempt('2026-09-29T10-15-30.123Z.json')).toBe(0);
    expect(recordFileAttempt('2026-09-29T10-15-30.123Z-12.json')).toBe(12);
  });

  it('sorts oldest first, then by the order records were written', () => {
    const early = { record: record('2026-09-01T00:00:00.000Z'), fileName: 'b.json' };
    const same = '2026-09-02T00:00:00.000Z';
    const second = { record: record(same), fileName: '2026-09-02T00-00-00.000Z-1.json' };
    const first = { record: record(same), fileName: '2026-09-02T00-00-00.000Z.json' };
    expect(sortRecords([second, first, early])).toEqual([early, first, second]);
  });
});

describe('parseStoredRecord', () => {
  it('accepts a complete record of the same paper', () => {
    const stored = record('2026-09-01T00:00:00.000Z');
    expect(parseStoredRecord(JSON.parse(JSON.stringify(stored)), 'paper/main.tex')).toEqual(stored);
  });

  it('rejects other papers, missing metadata and incomplete reviews', () => {
    const stored = record('2026-09-01T00:00:00.000Z');
    expect(parseStoredRecord(stored, 'paper/other.tex')).toBeNull();
    expect(parseStoredRecord({ ...stored, competitionId: ' ' }, stored.paper)).toBeNull();
    expect(parseStoredRecord({ ...stored, completedAt: 'yesterday' }, stored.paper)).toBeNull();
    expect(
      parseStoredRecord({ ...stored, dimensions: stored.dimensions.slice(1) }, stored.paper)
    ).toBeNull();
    expect(parseStoredRecord(null, stored.paper)).toBeNull();
  });
});

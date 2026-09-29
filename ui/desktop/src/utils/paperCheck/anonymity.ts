/**
 * Anonymity (spec mathmodel-parity-and-beyond, requirement 18.6): where the competition requires
 * anonymous papers, the members' names, the school and the team name must not appear in the
 * paper sources or the PDF. Every place they do is listed with its file and line (sources) or
 * page (PDF).
 *
 * Pure functions: the caller passes the source texts and the PDF's text layer.
 *
 * Terms are the entered values; an entry holding several names separated by `、`, `,`, `，`,
 * `;`, `；`, `/` or `|` is split. Terms shorter than two characters are ignored, as they would
 * match everywhere. Matching ignores case, Unicode compatibility forms (NFKC) and whitespace
 * (including LaTeX `~`), so `Zhang San` also finds `ZhangSan` and a name the PDF splits into
 * single characters is still found. Comments in LaTeX, Typst and Markdown sources are ignored:
 * they do not reach the PDF.
 */

import type { AnonymityTerms } from '../../types/paperCheckApi';
import {
  sourceLanguageOf,
  splitLines,
  stripComments,
  type PaperCheckVerdict,
  type SourceLanguage,
  type SourceText,
} from './common';
import { pageText, type PdfPageText } from './pdfTextLayer';

export type AnonymityField = 'name' | 'school' | 'team';

export interface AnonymityTerm {
  term: string;
  field: AnonymityField;
}

export interface AnonymityHit {
  term: string;
  field: AnonymityField;
  /** Project-relative path of the source or the PDF. */
  path: string;
  /** 1-based line, for sources. */
  line?: number;
  /** 1-based page, for the PDF. */
  page?: number;
}

export interface AnonymityPdf {
  path: string;
  /** `null` when the PDF exists but its text layer could not be read. */
  pages: PdfPageText[] | null;
}

export interface AnonymityReport {
  verdict: PaperCheckVerdict;
  /** `profile`: no usable term was entered; `paper-source`: nothing to search. */
  missing: 'profile' | 'paper-source' | null;
  hits: AnonymityHit[];
  /** The PDF whose text could not be read; the check then cannot pass. */
  unreadablePdf: string | null;
}

const SEPARATORS = /[、,，;；/|]/;

function folded(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s~]+/g, '');
}

/** The search terms: split, trimmed, at least two characters, each once. */
export function anonymityTerms(input: AnonymityTerms): AnonymityTerm[] {
  const terms: AnonymityTerm[] = [];
  const seen = new Set<string>();
  const add = (value: string, field: AnonymityField): void => {
    const term = value.trim();
    const key = folded(term);
    if ([...key].length >= 2 && !seen.has(key)) {
      seen.add(key);
      terms.push({ term, field });
    }
  };
  for (const name of input.names) {
    for (const part of name.split(SEPARATORS)) {
      add(part, 'name');
    }
  }
  add(input.school, 'school');
  add(input.team, 'team');
  return terms;
}

function languageOf(path: string): SourceLanguage {
  const lower = path.toLowerCase();
  return lower.endsWith('.cls') || lower.endsWith('.sty') ? 'latex' : sourceLanguageOf(path);
}

/** Every line of the sources and every page of the PDF that contains a term. */
export function findAnonymityHits(
  terms: readonly AnonymityTerm[],
  sources: readonly SourceText[],
  pdf: AnonymityPdf | null
): AnonymityHit[] {
  const keyed = terms.map((term) => ({ ...term, key: folded(term.term) }));
  const hits: AnonymityHit[] = [];
  for (const source of sources) {
    const lines = splitLines(stripComments(source.text, languageOf(source.path)));
    lines.forEach((line, index) => {
      const text = folded(line);
      for (const { term, field, key } of keyed) {
        if (text.includes(key)) {
          hits.push({ term, field, path: source.path, line: index + 1 });
        }
      }
    });
  }
  for (const page of pdf?.pages ?? []) {
    const text = folded(pageText(page));
    for (const { term, field, key } of keyed) {
      if (text.includes(key)) {
        hits.push({ term, field, path: pdf?.path ?? '', page: page.page });
      }
    }
  }
  return hits;
}

/** Requirement 18.6: lists every place a term appears. */
export function checkAnonymity(
  input: AnonymityTerms,
  sources: readonly SourceText[],
  pdf: AnonymityPdf | null
): AnonymityReport {
  const terms = anonymityTerms(input);
  if (terms.length === 0) {
    return { verdict: '无法执行', missing: 'profile', hits: [], unreadablePdf: null };
  }
  if (sources.length === 0 && pdf === null) {
    return { verdict: '无法执行', missing: 'paper-source', hits: [], unreadablePdf: null };
  }
  const hits = findAnonymityHits(terms, sources, pdf);
  const unreadablePdf = pdf !== null && pdf.pages === null ? pdf.path : null;
  return {
    verdict: hits.length === 0 && unreadablePdf === null ? '通过' : '发现问题',
    missing: null,
    hits,
    unreadablePdf,
  };
}

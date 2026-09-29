/**
 * Reference verification (spec mathmodel-parity-and-beyond, requirement 18.4): every entry of
 * the reference list is looked up in Crossref, by DOI when it has one and by its title
 * otherwise, waiting at most 10 seconds per entry. Entries Crossref does not confirm are listed
 * with their number in the list; timeouts and network failures are marked "未核实（网络原因）"
 * separately from "无法核实".
 *
 * Reference lists, numbered in the order the reader sees them:
 * - BibTeX (`\bibliography`, `\addbibresource`, Typst `bibliography("….bib")`): the cited
 *   entries in order of first citation, as numeric styles such as `gbt7714-numerical`, `unsrt`
 *   and Typst's default print them; `\nocite{*}` appends the uncited entries in file order.
 *   Citations are LaTeX `\cite`-family commands, Typst and Pandoc `@key`, `#cite(<key>)`.
 *   Alphabetical styles number differently; the key is always given as well.
 * - LaTeX `thebibliography` with `\bibitem`.
 * - A "参考文献"/"References"/"Bibliography" heading (Markdown `#`, LaTeX `\section*{…}`)
 *   followed by `[1] …`, `1. …` or `- …` items.
 *
 * A DOI lookup confirms the entry unless the entry has a title and Crossref's title for the DOI
 * shares less than half of its character pairs with it. A title search confirms it when a
 * result's title is at least 80 % similar (Sørensen–Dice on character pairs after removing
 * everything but letters and digits); for free-text entries without a recognisable title, when
 * a result's title appears in the entry. HTTP 404 means not found; 429, 5xx, timeouts and
 * connection errors are network reasons.
 */

import {
  lineAt,
  lineStarts,
  sourceLanguageOf,
  splitLines,
  stripComments,
  type PaperCheckVerdict,
  type SourceText,
} from './common';

export const CROSSREF_BASE_URL = 'https://api.crossref.org';
export const REFERENCE_TIMEOUT_MS = 10_000;
const DEFAULT_CONCURRENCY = 4;
const MAX_REFERENCES = 300;
const USER_AGENT = 'ModelForge-PaperCheck/1.0 (https://github.com/HanMarry/modelforge)';

export interface BibEntry {
  /** Lower-case entry type, `article`, `book`, … */
  type: string;
  key: string;
  /** Lower-case field names; values without the outer braces or quotes. */
  fields: Record<string, string>;
  /** 1-based line of the `@`. */
  line: number;
}

export interface ReferenceEntry {
  /** 1-based number in the reference list. */
  index: number;
  /** Citation key, for BibTeX and `\bibitem` entries. */
  key?: string;
  title?: string;
  doi?: string;
  author?: string;
  year?: string;
  /** The entry as plain text, used for display and for searching free-text entries. */
  text: string;
  /** Project-relative file where the entry is written. */
  path: string;
  line: number;
}

export type ReferenceUnverifiedReason =
  | 'doi-not-found'
  | 'doi-title-mismatch'
  | 'no-match'
  | 'no-identifier';

export type ReferenceVerification =
  | { entry: ReferenceEntry; status: 'verified' }
  | { entry: ReferenceEntry; status: 'unverified'; reason: ReferenceUnverifiedReason }
  | { entry: ReferenceEntry; status: 'network' };

/** The subset of `fetch` the lookups need, so tests and the check process can supply it. */
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal: globalThis.AbortSignal }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export interface CrossrefOptions {
  fetch: FetchLike;
  /** Defaults to `CROSSREF_BASE_URL`. */
  baseUrl?: string;
  /** Per entry, response body included; defaults to `REFERENCE_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Lookups in flight at once; defaults to 4. */
  concurrency?: number;
}

export interface ReferencesReport {
  verdict: PaperCheckVerdict;
  /** `offline`: online verification was not requested; `network`: no lookup got an answer. */
  missing: 'references' | 'offline' | 'network' | null;
  entries: number;
  unverified: Array<Extract<ReferenceVerification, { status: 'unverified' }>>;
  network: Array<Extract<ReferenceVerification, { status: 'network' }>>;
}

function skipSpace(text: string, index: number): number {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) {
    i++;
  }
  return i;
}

/** End (exclusive) of the balanced group opening at `start`, or `-1`. */
function groupEnd(text: string, start: number, open: string, close: string): number {
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
        return i + 1;
      }
    }
  }
  return -1;
}

/** Removes TeX markup from a field or item: commands keep their argument, braces go. */
export function plainTeX(text: string): string {
  return text
    .replace(/\\(?:url|href)\s*\{([^}]*)\}(?:\s*\{([^}]*)\})?/g, (_all, url: string) => url)
    .replace(/\\[`'^"~=.]\s*\{?([A-Za-z])\}?/g, '$1')
    .replace(/\\(?:textit|textbf|emph|textrm|textsc|texttt|mbox|text)\s*\{/g, '{')
    .replace(/\\\\|~/g, ' ')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\[A-Za-z]+\*?/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** BibTeX entries of a `.bib` file; `@comment`, `@preamble` and `@string` are skipped. */
export function parseBibtex(text: string): BibEntry[] {
  const entries: BibEntry[] = [];
  const starts = lineStarts(text);
  const pattern = /@([A-Za-z]+)\s*([{(])/g;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const type = match[1].toLowerCase();
    const open = match[2];
    const close = open === '{' ? '}' : ')';
    const bodyStart = match.index + match[0].length - 1;
    const end = groupEnd(text, bodyStart, open, close);
    const bodyEnd = end === -1 ? text.length : end - 1;
    pattern.lastIndex = end === -1 ? text.length : end;
    if (type === 'comment' || type === 'preamble' || type === 'string') {
      continue;
    }
    const body = text.slice(bodyStart + 1, bodyEnd);
    const comma = body.indexOf(',');
    const key = (comma === -1 ? body : body.slice(0, comma)).trim();
    if (key === '') {
      continue;
    }
    entries.push({
      type,
      key,
      fields: comma === -1 ? {} : parseFields(body.slice(comma + 1)),
      line: lineAt(starts, match.index),
    });
  }
  return entries;
}

function parseFields(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let i = 0;
  while (i < body.length) {
    i = skipSpace(body, i);
    const name = /^[A-Za-z][\w\-:.+]*/.exec(body.slice(i));
    if (name === null) {
      break;
    }
    i = skipSpace(body, i + name[0].length);
    if (body[i] !== '=') {
      break;
    }
    i = skipSpace(body, i + 1);
    const parts: string[] = [];
    for (;;) {
      if (body[i] === '{') {
        const end = groupEnd(body, i, '{', '}');
        const stop = end === -1 ? body.length : end;
        parts.push(body.slice(i + 1, stop - 1));
        i = stop;
      } else if (body[i] === '"') {
        let j = i + 1;
        let depth = 0;
        for (; j < body.length; j++) {
          if (body[j] === '\\') {
            j++;
          } else if (body[j] === '{') {
            depth++;
          } else if (body[j] === '}') {
            depth--;
          } else if (body[j] === '"' && depth === 0) {
            break;
          }
        }
        parts.push(body.slice(i + 1, j));
        i = j + 1;
      } else {
        const bare = /^[^,\s#}]+/.exec(body.slice(i));
        if (bare === null) {
          break;
        }
        parts.push(bare[0]);
        i += bare[0].length;
      }
      i = skipSpace(body, i);
      if (body[i] !== '#') {
        break;
      }
      i = skipSpace(body, i + 1);
    }
    fields[name[0].toLowerCase()] = parts.join('').replace(/\s+/g, ' ').trim();
    i = skipSpace(body, i);
    if (body[i] === ',') {
      i++;
    }
  }
  return fields;
}

/** A DOI in its bare form (`10.1000/xyz`), from a DOI field, a doi.org URL or free text. */
export function findDoi(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const match = /\b(10\.\d{4,9}\/[^\s"<>{}]+)/i.exec(text);
  return match === null ? undefined : match[1].replace(/[.,;:)\]]+$/, '');
}

const LATEX_CITE =
  /\\[A-Za-z]*cite[A-Za-z]*\*?(?:\s*\[[^\]]*\]){0,2}\s*\{([^}]*)\}/g;
const TYPST_CITE = /#cite\(\s*(?:<([^>\s]+)>|label\(\s*"([^"]+)"\s*\))/g;
const AT_CITE = /(?<![\w.@\\])@([A-Za-z0-9_][\w\-:./]*)/g;

/**
 * Citation keys in order of first appearance, comments excluded; `*` stands for `\nocite{*}`.
 * `@key` counts in Typst and Markdown only.
 */
export function extractCitations(file: SourceText): string[] {
  const language = sourceLanguageOf(file.path);
  const text = stripComments(file.text, language);
  const found: Array<{ offset: number; key: string }> = [];
  if (language === 'latex') {
    for (const match of text.matchAll(LATEX_CITE)) {
      for (const key of match[1].split(',')) {
        if (key.trim() !== '') {
          found.push({ offset: match.index ?? 0, key: key.trim() });
        }
      }
    }
  } else if (language === 'typst' || language === 'markdown') {
    for (const match of text.matchAll(TYPST_CITE)) {
      found.push({ offset: match.index ?? 0, key: match[1] ?? match[2] });
    }
    for (const match of text.matchAll(AT_CITE)) {
      found.push({ offset: match.index ?? 0, key: match[1].replace(/[.:/]+$/, '') });
    }
  }
  const keys: string[] = [];
  for (const { key } of found.sort((a, b) => a.offset - b.offset)) {
    if (!keys.includes(key)) {
      keys.push(key);
    }
  }
  return keys;
}

function entryFromBib(entry: BibEntry, index: number, path: string): ReferenceEntry {
  const field = (name: string): string | undefined => {
    const value = entry.fields[name];
    return value === undefined || value.trim() === '' ? undefined : plainTeX(value);
  };
  const title = field('title');
  const author = field('author');
  const year = field('year') ?? field('date')?.slice(0, 4);
  const doi = findDoi(entry.fields.doi) ?? findDoi(entry.fields.url);
  const text = [author, title, field('journal') ?? field('booktitle') ?? field('publisher'), year]
    .filter((part): part is string => part !== undefined)
    .join('. ');
  return {
    index,
    key: entry.key,
    ...(title === undefined ? {} : { title }),
    ...(doi === undefined ? {} : { doi }),
    ...(author === undefined ? {} : { author }),
    ...(year === undefined ? {} : { year }),
    text: text === '' ? entry.key : text,
    path,
    line: entry.line,
  };
}

/**
 * The printed BibTeX list: cited entries in order of first citation, then, with `\nocite{*}`,
 * the remaining entries in file order. Keys match case-sensitively first, then ignoring case.
 */
export function referencesFromBib(
  bibFiles: ReadonlyArray<{ path: string; entries: BibEntry[] }>,
  citedKeys: readonly string[]
): ReferenceEntry[] {
  const all = bibFiles.flatMap(({ path, entries }) => entries.map((entry) => ({ path, entry })));
  const byKey = new Map<string, { path: string; entry: BibEntry }>();
  const byFoldedKey = new Map<string, { path: string; entry: BibEntry }>();
  for (const item of all) {
    if (!byKey.has(item.entry.key)) {
      byKey.set(item.entry.key, item);
    }
    const folded = item.entry.key.toLowerCase();
    if (!byFoldedKey.has(folded)) {
      byFoldedKey.set(folded, item);
    }
  }
  const ordered: Array<{ path: string; entry: BibEntry }> = [];
  const add = (item: { path: string; entry: BibEntry } | undefined): void => {
    if (item !== undefined && !ordered.includes(item)) {
      ordered.push(item);
    }
  };
  for (const key of citedKeys) {
    if (key !== '*') {
      add(byKey.get(key) ?? byFoldedKey.get(key.toLowerCase()));
    }
  }
  if (citedKeys.includes('*')) {
    all.forEach(add);
  }
  return ordered.map(({ path, entry }, i) => entryFromBib(entry, i + 1, path));
}

/** A title in a GB/T 7714 entry: `作者. 题名[J]. 刊名, …`. */
function gbTitle(text: string): string | undefined {
  const match = /^(?:[^.．。[\]]+[.．。]\s*)?([^[\]]{4,}?)\s*\[[A-Z]{1,2}(?:\/OL)?\]/.exec(text);
  return match === null ? undefined : match[1].trim();
}

function freeTextEntry(text: string, index: number, path: string, line: number): ReferenceEntry {
  const plain = plainTeX(text);
  const title = gbTitle(plain);
  const doi = findDoi(plain);
  return {
    index,
    ...(title === undefined ? {} : { title }),
    ...(doi === undefined ? {} : { doi }),
    text: plain,
    path,
    line,
  };
}

/** `\bibitem` entries of `thebibliography` environments, numbered in order. */
export function extractBibitems(file: SourceText): ReferenceEntry[] {
  if (sourceLanguageOf(file.path) !== 'latex') {
    return [];
  }
  const text = stripComments(file.text, 'latex');
  const starts = lineStarts(text);
  const entries: ReferenceEntry[] = [];
  for (const begin of text.matchAll(/\\begin\{thebibliography\}(?:\s*\{[^}]*\})?/g)) {
    const bodyStart = (begin.index ?? 0) + begin[0].length;
    const endAt = text.indexOf('\\end{thebibliography}', bodyStart);
    const body = text.slice(bodyStart, endAt === -1 ? text.length : endAt);
    const items = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}([\s\S]*?)(?=\\bibitem\b|$)/g;
    for (const item of body.matchAll(items)) {
      const offset = bodyStart + (item.index ?? 0);
      const entry = freeTextEntry(item[2], entries.length + 1, file.path, lineAt(starts, offset));
      entries.push({ ...entry, key: item[1].trim() });
    }
  }
  return entries;
}

const REFERENCE_HEADING =
  /^\s*(?:#{1,6}\s*|\\(?:sub)*section\*?\s*\{\s*)(?:参考文献|參考文獻|references|bibliography)\s*\}?\s*$/i;
const ANY_HEADING = /^\s*(?:#{1,6}\s|\\(?:sub)*section\b|\\chapter\b|\\appendix\b|\\end\{document\})/;
const LIST_ITEM = /^\s*(?:\[\d+\]|\d+[.)、]|[-*+]|\\item(?:\[[^\]]*\])?)\s*(.+)$/;

/** Items under a "参考文献"/"References" heading in Markdown or LaTeX. */
export function extractListedReferences(file: SourceText): ReferenceEntry[] {
  const language = sourceLanguageOf(file.path);
  if (language !== 'markdown' && language !== 'latex') {
    return [];
  }
  const lines = splitLines(stripComments(file.text, language));
  const entries: ReferenceEntry[] = [];
  let inList = false;
  let current: { text: string; line: number } | null = null;
  const flush = (): void => {
    if (current !== null && current.text.trim() !== '') {
      entries.push(freeTextEntry(current.text, entries.length + 1, file.path, current.line));
    }
    current = null;
  };
  lines.forEach((line, index) => {
    if (REFERENCE_HEADING.test(line)) {
      flush();
      inList = true;
      return;
    }
    if (!inList) {
      return;
    }
    if (ANY_HEADING.test(line)) {
      flush();
      inList = false;
      return;
    }
    if (/^\s*\\(?:begin|end)\{/.test(line)) {
      // `\begin{enumerate}` and the like around the items.
      return;
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null) {
      flush();
      current = { text: item[1], line: index + 1 };
    } else if (line.trim() === '') {
      flush();
    } else if (current !== null) {
      current.text += ` ${line.trim()}`;
    }
  });
  flush();
  return entries;
}

/**
 * The paper's reference list: BibTeX entries when a `.bib` file is used, otherwise
 * `thebibliography` items, otherwise items under a references heading.
 */
export function collectReferences(
  sources: readonly SourceText[],
  bibFiles: readonly SourceText[]
): ReferenceEntry[] {
  let entries: ReferenceEntry[];
  if (bibFiles.length > 0) {
    const cited: string[] = [];
    for (const source of sources) {
      for (const key of extractCitations(source)) {
        if (!cited.includes(key)) {
          cited.push(key);
        }
      }
    }
    entries = referencesFromBib(
      bibFiles.map(({ path, text }) => ({ path, entries: parseBibtex(text) })),
      cited
    );
  } else {
    entries = sources.flatMap(extractBibitems);
    if (entries.length === 0) {
      entries = sources.flatMap(extractListedReferences);
    }
    entries = entries.map((entry, i) => ({ ...entry, index: i + 1 }));
  }
  return entries.slice(0, MAX_REFERENCES);
}

/** Letters and digits only, lower case, TeX markup removed. */
export function normalizeTitle(title: string): string {
  return plainTeX(title)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function bigrams(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const chars = [...text];
  for (let i = 0; i + 1 < chars.length; i++) {
    const pair = chars[i] + chars[i + 1];
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Sørensen–Dice coefficient on character pairs of the normalised titles, 0 to 1. */
export function titleSimilarity(a: string, b: string): number {
  const left = normalizeTitle(a);
  const right = normalizeTitle(b);
  if (left === right) {
    return left === '' ? 0 : 1;
  }
  if ([...left].length < 2 || [...right].length < 2) {
    return 0;
  }
  const leftPairs = bigrams(left);
  const rightPairs = bigrams(right);
  let shared = 0;
  let total = 0;
  for (const count of leftPairs.values()) {
    total += count;
  }
  for (const [pair, count] of rightPairs) {
    total += count;
    shared += Math.min(count, leftPairs.get(pair) ?? 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}

type LookupResult =
  | { kind: 'ok'; body: unknown }
  | { kind: 'not-found' }
  | { kind: 'rejected' }
  | { kind: 'network' };

async function lookup(url: string, options: CrossrefOptions): Promise<LookupResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? REFERENCE_TIMEOUT_MS);
  try {
    const response = await options.fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return { kind: 'not-found' };
    }
    if (response.status === 429 || response.status >= 500) {
      return { kind: 'network' };
    }
    if (!response.ok) {
      return { kind: 'rejected' };
    }
    return { kind: 'ok', body: await response.json() };
  } catch {
    // Aborted after the timeout, connection refused, DNS failure, or a truncated body.
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function crossrefTitles(value: unknown): string[] {
  const title = (value as { title?: unknown } | null)?.title;
  return Array.isArray(title) ? title.filter((t): t is string => typeof t === 'string') : [];
}

function baseUrl(options: CrossrefOptions): string {
  return (options.baseUrl ?? CROSSREF_BASE_URL).replace(/\/+$/, '');
}

/** Looks one entry up in Crossref (18.4). Never throws. */
export async function verifyReference(
  entry: ReferenceEntry,
  options: CrossrefOptions
): Promise<ReferenceVerification> {
  if (entry.doi !== undefined) {
    const doiUrl = `${baseUrl(options)}/works/${encodeURIComponent(entry.doi)}`;
    const result = await lookup(doiUrl, options);
    if (result.kind === 'network') {
      return { entry, status: 'network' };
    }
    if (result.kind !== 'ok') {
      return { entry, status: 'unverified', reason: 'doi-not-found' };
    }
    const titles = crossrefTitles((result.body as { message?: unknown } | null)?.message);
    if (
      entry.title !== undefined &&
      titles.length > 0 &&
      titles.every((title) => titleSimilarity(title, entry.title ?? '') < 0.5)
    ) {
      return { entry, status: 'unverified', reason: 'doi-title-mismatch' };
    }
    return { entry, status: 'verified' };
  }

  const query =
    entry.title !== undefined
      ? [entry.title, entry.author, entry.year].filter((part) => part !== undefined).join(' ')
      : entry.text;
  if (normalizeTitle(query).length < 6) {
    return { entry, status: 'unverified', reason: 'no-identifier' };
  }
  const params = new URLSearchParams({
    'query.bibliographic': query,
    rows: '5',
    select: 'DOI,title',
  });
  const result = await lookup(`${baseUrl(options)}/works?${params.toString()}`, options);
  if (result.kind === 'network') {
    return { entry, status: 'network' };
  }
  if (result.kind !== 'ok') {
    return { entry, status: 'unverified', reason: 'no-match' };
  }
  const items = (result.body as { message?: { items?: unknown } } | null)?.message?.items;
  const titles = Array.isArray(items) ? items.flatMap(crossrefTitles) : [];
  const text = normalizeTitle(entry.text);
  const matched = titles.some((title) =>
    entry.title !== undefined
      ? titleSimilarity(title, entry.title) >= 0.8
      : normalizeTitle(title).length >= 8 && text.includes(normalizeTitle(title))
  );
  if (!matched) {
    return { entry, status: 'unverified', reason: 'no-match' };
  }
  return { entry, status: 'verified' };
}

/** Looks every entry up, a few at a time; results keep the order of `entries`. */
export async function verifyReferences(
  entries: readonly ReferenceEntry[],
  options: CrossrefOptions
): Promise<ReferenceVerification[]> {
  const results: ReferenceVerification[] = new Array(entries.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < entries.length) {
      const index = next++;
      results[index] = await verifyReference(entries[index], options);
    }
  };
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const workers = Math.max(1, Math.min(concurrency, entries.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

/**
 * Requirement 18.4: the verdict over the reference list. `verifications` is `null` when online
 * verification was not requested.
 */
export function summarizeReferences(
  entries: readonly ReferenceEntry[],
  verifications: readonly ReferenceVerification[] | null
): ReferencesReport {
  const base = { entries: entries.length, unverified: [], network: [] };
  if (entries.length === 0) {
    return { verdict: '无法执行', missing: 'references', ...base };
  }
  if (verifications === null) {
    return { verdict: '无法执行', missing: 'offline', ...base };
  }
  const unverified: ReferencesReport['unverified'] = [];
  const network: ReferencesReport['network'] = [];
  for (const verification of verifications) {
    if (verification.status === 'unverified') {
      unverified.push(verification);
    } else if (verification.status === 'network') {
      network.push(verification);
    }
  }
  if (network.length === verifications.length) {
    return { verdict: '无法执行', missing: 'network', entries: entries.length, unverified, network };
  }
  return {
    verdict: unverified.length + network.length === 0 ? '通过' : '发现问题',
    missing: null,
    entries: entries.length,
    unverified,
    network,
  };
}

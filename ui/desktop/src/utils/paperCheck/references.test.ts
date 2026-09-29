// @vitest-environment node
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectReferences,
  extractBibitems,
  extractCitations,
  extractListedReferences,
  findDoi,
  parseBibtex,
  plainTeX,
  referencesFromBib,
  summarizeReferences,
  titleSimilarity,
  verifyReference,
  verifyReferences,
  type CrossrefOptions,
  type FetchLike,
  type ReferenceEntry,
} from './references';

const BIB = [
  '% comment line',
  '@comment{jabref-meta: databaseType:bibtex;}',
  '@string{jnl = "Journal of Tests"}',
  '@article{zhang2020,',
  '  author = {Zhang, San and Li, Si},',
  '  title = {Grey Prediction of {Population} Growth},',
  '  journal = jnl,',
  '  year = 2020,',
  '  doi = {https://doi.org/10.1000/ok},',
  '}',
  '@book{wang2019,',
  '  title = "Mathematical Modeling",',
  '  author = "Wang Wu",',
  '  publisher = {Higher Education Press},',
  '  year = {2019}',
  '}',
  '@misc(web2021, title = {数据来源} # { 说明}, url = {https://example.org/data})',
].join('\n');

describe('parseBibtex', () => {
  it('reads entries with braces, quotes, bare values, concatenation and parentheses', () => {
    expect(parseBibtex(BIB)).toEqual([
      {
        type: 'article',
        key: 'zhang2020',
        fields: {
          author: 'Zhang, San and Li, Si',
          title: 'Grey Prediction of {Population} Growth',
          journal: 'jnl',
          year: '2020',
          doi: 'https://doi.org/10.1000/ok',
        },
        line: 4,
      },
      {
        type: 'book',
        key: 'wang2019',
        fields: {
          title: 'Mathematical Modeling',
          author: 'Wang Wu',
          publisher: 'Higher Education Press',
          year: '2019',
        },
        line: 11,
      },
      {
        type: 'misc',
        key: 'web2021',
        fields: { title: '数据来源 说明', url: 'https://example.org/data' },
        line: 17,
      },
    ]);
  });
});

describe('reference lists', () => {
  it('orders BibTeX entries by first citation and appends the rest for \\nocite{*}', () => {
    const main = {
      path: 'paper/main.tex',
      text: [
        '如文献\\cite{wang2019}所述，灰色预测\\citep[见][第3页]{zhang2020, wang2019}。',
        '% \\cite{commented}',
        '\\nocite{*}',
      ].join('\n'),
    };
    expect(extractCitations(main)).toEqual(['wang2019', 'zhang2020', '*']);

    const entries = referencesFromBib([{ path: 'paper/refs.bib', entries: parseBibtex(BIB) }], [
      'wang2019',
      'zhang2020',
      '*',
    ]);
    expect(entries.map(({ index, key }) => [index, key])).toEqual([
      [1, 'wang2019'],
      [2, 'zhang2020'],
      [3, 'web2021'],
    ]);
    expect(entries[1]).toEqual({
      index: 2,
      key: 'zhang2020',
      title: 'Grey Prediction of Population Growth',
      doi: '10.1000/ok',
      author: 'Zhang, San and Li, Si',
      year: '2020',
      text: 'Zhang, San and Li, Si. Grey Prediction of Population Growth. jnl. 2020',
      path: 'paper/refs.bib',
      line: 4,
    });
    expect(referencesFromBib([{ path: 'r.bib', entries: parseBibtex(BIB) }], ['ZHANG2020']))
      .toHaveLength(1);
  });

  it('finds Typst and Pandoc citations but not e-mail addresses', () => {
    expect(
      extractCitations({
        path: 'main.typ',
        text: '@zhang2020 的方法与 #cite(<wang2019>) 以及 @fig-1。联系 a@b.com',
      })
    ).toEqual(['zhang2020', 'wang2019', 'fig-1']);
    expect(extractCitations({ path: 'paper.md', text: '见 [@zhang2020; @wang2019].' })).toEqual([
      'zhang2020',
      'wang2019',
    ]);
  });

  it('reads thebibliography items with GB/T 7714 titles and DOIs', () => {
    const file = {
      path: 'main.tex',
      text: [
        '\\begin{thebibliography}{99}',
        '\\bibitem{a} 张三, 李四. 基于灰色预测的人口模型[J]. 数学建模, 2020, 3(2): 1-5.',
        '\\bibitem[Smith(2019)]{b} Smith J. A \\textit{genetic algorithm} for routing[C]//Proc. 2019. doi:10.1000/ga.',
        '\\end{thebibliography}',
      ].join('\n'),
    };
    expect(extractBibitems(file)).toEqual([
      {
        index: 1,
        key: 'a',
        title: '基于灰色预测的人口模型',
        text: '张三, 李四. 基于灰色预测的人口模型[J]. 数学建模, 2020, 3(2): 1-5.',
        path: 'main.tex',
        line: 2,
      },
      {
        index: 2,
        key: 'b',
        title: 'A genetic algorithm for routing',
        doi: '10.1000/ga',
        text: 'Smith J. A genetic algorithm for routing[C]//Proc. 2019. doi:10.1000/ga.',
        path: 'main.tex',
        line: 3,
      },
    ]);
  });

  it('reads items under a references heading until the next heading', () => {
    const file = {
      path: 'paper.md',
      text: [
        '# 论文',
        '正文 [1]。',
        '## 参考文献',
        '[1] 张三. 灰色预测[J]. 数学, 2020.',
        '2. Smith J. Genetic algorithms',
        '   for routing[M]. Springer, 2019.',
        '- 网络资料 https://example.org',
        '',
        '## 附录',
        '[3] not a reference',
      ].join('\n'),
    };
    expect(extractListedReferences(file)).toEqual([
      {
        index: 1,
        title: '灰色预测',
        text: '张三. 灰色预测[J]. 数学, 2020.',
        path: 'paper.md',
        line: 4,
      },
      {
        index: 2,
        title: 'Genetic algorithms for routing',
        text: 'Smith J. Genetic algorithms for routing[M]. Springer, 2019.',
        path: 'paper.md',
        line: 5,
      },
      { index: 3, text: '网络资料 https://example.org', path: 'paper.md', line: 7 },
    ]);
  });

  it('prefers BibTeX, then thebibliography, then listed items', () => {
    const tex = { path: 'main.tex', text: '\\cite{wang2019}\n\\begin{thebibliography}{9}\\bibitem{x} X.\\end{thebibliography}' };
    expect(collectReferences([tex], [{ path: 'refs.bib', text: BIB }]).map(({ key }) => key)).toEqual(
      ['wang2019']
    );
    expect(collectReferences([tex], []).map(({ key }) => key)).toEqual(['x']);
    expect(collectReferences([{ path: 'a.md', text: '# References\n1. Only item' }], [])).toHaveLength(1);
  });

  it('normalises DOIs, TeX and titles', () => {
    expect(findDoi('https://doi.org/10.1000/xyz.')).toBe('10.1000/xyz');
    expect(findDoi('see doi:10.1234/ABC-1)')).toBe('10.1234/ABC-1');
    expect(findDoi('no doi here')).toBeUndefined();
    expect(findDoi(undefined)).toBeUndefined();
    expect(plainTeX('Caf\\\'{e} \\emph{and} 50\\% {Tea}~time')).toBe('Cafe and 50% Tea time');
    expect(titleSimilarity('Grey Prediction of Population Growth', 'grey prediction of population growth.')).toBe(1);
    expect(titleSimilarity('abc', '')).toBe(0);
    expect(titleSimilarity('Grey prediction', 'Fluid dynamics of oceans')).toBeLessThan(0.3);
  });
});

// Task 23.11: references.ts against a local stand-in for the Crossref REST API.
describe('verifyReference with a mock Crossref service', () => {
  let server: http.Server;
  let baseUrl = '';
  const held: ServerResponse[] = [];
  const seen: Array<{ path: string; query: string | null; userAgent: string | undefined }> = [];

  const reply = (res: ServerResponse, status: number, body?: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const query = url.searchParams.get('query.bibliographic');
    seen.push({ path: decodeURIComponent(url.pathname), query, userAgent: req.headers['user-agent'] });
    if (url.pathname.startsWith('/works/')) {
      const doi = decodeURIComponent(url.pathname.slice('/works/'.length));
      switch (doi) {
        case '10.1000/ok':
          return reply(res, 200, { message: { DOI: doi, title: ['Grey prediction of population growth'] } });
        case '10.1000/other':
          return reply(res, 200, { message: { DOI: doi, title: ['Turbulence in shallow water'] } });
        case '10.1000/busy':
          return reply(res, 503);
        case '10.1000/slow':
          held.push(res);
          return undefined;
        default:
          return reply(res, 404, 'Resource not found.');
      }
    }
    if (url.pathname === '/works') {
      const items = (query ?? '').toLowerCase().includes('genetic algorithm')
        ? [{ DOI: '10.1000/ga', title: ['A genetic algorithm for vehicle routing'] }, { title: ['Other'] }]
        : [{ title: ['Unrelated work'] }];
      return reply(res, 200, { message: { items } });
    }
    return reply(res, 404);
  };

  const fetchLike: FetchLike = (url, init) => fetch(url, init);
  const options = (): CrossrefOptions => ({ fetch: fetchLike, baseUrl, timeoutMs: 500 });

  const entry = (fields: Partial<ReferenceEntry>): ReferenceEntry => ({
    index: 1,
    text: fields.title ?? 'entry',
    path: 'refs.bib',
    line: 1,
    ...fields,
  });

  beforeAll(async () => {
    server = http.createServer(handle);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });

  afterAll(async () => {
    for (const res of held) {
      res.destroy();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('confirms a DOI and sends it to /works/{doi} with a User-Agent', async () => {
    const ok = entry({ doi: '10.1000/ok', title: 'Grey Prediction of Population Growth' });
    expect(await verifyReference(ok, options())).toEqual({ entry: ok, status: 'verified' });
    expect(seen.at(-1)).toMatchObject({ path: '/works/10.1000/ok' });
    expect(seen.at(-1)?.userAgent).toContain('ModelForge');
  });

  it('reports an unknown DOI and a DOI registered for another title', async () => {
    const missing = entry({ doi: '10.1000/missing' });
    expect(await verifyReference(missing, options())).toEqual({
      entry: missing,
      status: 'unverified',
      reason: 'doi-not-found',
    });
    const other = entry({ doi: '10.1000/other', title: 'Grey Prediction of Population Growth' });
    expect(await verifyReference(other, options())).toEqual({
      entry: other,
      status: 'unverified',
      reason: 'doi-title-mismatch',
    });
  });

  it('marks server errors, timeouts and unreachable hosts as network reasons', async () => {
    const busy = entry({ doi: '10.1000/busy' });
    expect(await verifyReference(busy, options())).toEqual({ entry: busy, status: 'network' });

    const slow = entry({ doi: '10.1000/slow' });
    const started = Date.now();
    expect(await verifyReference(slow, options())).toEqual({ entry: slow, status: 'network' });
    expect(Date.now() - started).toBeLessThan(5000);

    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', () => resolve()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const unreachable = entry({ doi: '10.1000/ok' });
    expect(
      await verifyReference(unreachable, { fetch: fetchLike, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 500 })
    ).toEqual({ entry: unreachable, status: 'network' });
  });

  it('searches by title without a DOI and by the whole text without a title', async () => {
    const found = entry({ title: 'A Genetic Algorithm for Vehicle Routing', author: 'Smith J' });
    expect(await verifyReference(found, options())).toEqual({ entry: found, status: 'verified' });
    expect(seen.at(-1)?.query).toBe('A Genetic Algorithm for Vehicle Routing Smith J');

    const unknown = entry({ title: 'Nonexistent study of imaginary things' });
    expect(await verifyReference(unknown, options())).toEqual({
      entry: unknown,
      status: 'unverified',
      reason: 'no-match',
    });

    const freeText = entry({ text: 'Smith J. 2019. A genetic algorithm for vehicle routing. Proc.' });
    expect(await verifyReference(freeText, options())).toEqual({ entry: freeText, status: 'verified' });
  });

  it('does not query entries without a DOI or enough text', async () => {
    const before = seen.length;
    const bare = entry({ text: 'x' });
    expect(await verifyReference(bare, options())).toEqual({
      entry: bare,
      status: 'unverified',
      reason: 'no-identifier',
    });
    expect(seen).toHaveLength(before);
  });

  it('verifies a list in order and summarises it', async () => {
    const list = [
      entry({ index: 1, doi: '10.1000/ok' }),
      entry({ index: 2, doi: '10.1000/missing' }),
      entry({ index: 3, doi: '10.1000/busy' }),
      entry({ index: 4, title: 'A genetic algorithm for vehicle routing' }),
    ];
    const results = await verifyReferences(list, { ...options(), concurrency: 2 });
    expect(results.map(({ entry: e, status }) => [e.index, status])).toEqual([
      [1, 'verified'],
      [2, 'unverified'],
      [3, 'network'],
      [4, 'verified'],
    ]);

    const report = summarizeReferences(list, results);
    expect(report.verdict).toBe('发现问题');
    expect(report.unverified.map(({ entry: e }) => e.index)).toEqual([2]);
    expect(report.network.map(({ entry: e }) => e.index)).toEqual([3]);

    expect(summarizeReferences(list.slice(0, 1), results.slice(0, 1)).verdict).toBe('通过');
    expect(summarizeReferences(list.slice(2, 3), results.slice(2, 3))).toMatchObject({
      verdict: '无法执行',
      missing: 'network',
    });
    expect(summarizeReferences(list, null)).toMatchObject({ verdict: '无法执行', missing: 'offline' });
    expect(summarizeReferences([], [])).toMatchObject({ verdict: '无法执行', missing: 'references' });
  });
});

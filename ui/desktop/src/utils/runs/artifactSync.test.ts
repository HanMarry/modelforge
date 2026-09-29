import { describe, expect, it } from 'vitest';
import type { ArtifactEntry, ArtifactIndex } from '../../types/artifactStatus';
import {
  applyRunStarted,
  emptyArtifactIndex,
  getArtifactEntry,
  markVerified,
} from '../artifactStatus';
import { FILE_HASH_MISSING, FILE_HASH_UNREADABLE } from '../runRecord';
import {
  CODE_TEXT,
  INPUT_TEXT,
  LATER_RUN_ID,
  OUTPUT_TEXT,
  RUN_ID,
  runRecord,
  sha256,
} from '../../test/runRecordFixtures';
import {
  applyNewRuns,
  artifactFileChecks,
  fileOnlyPaths,
  inspectionPaths,
  parseArtifactIndex,
  sameArtifactIndex,
  serializeArtifactIndex,
  staleCheckPaths,
  syncDiscoveredFiles,
} from './artifactSync';

const OUT = 'results/out.csv';

function entry(path: string, overrides: Partial<ArtifactEntry> = {}): ArtifactEntry {
  return {
    path,
    status: '已发现文件',
    runId: null,
    failure: null,
    verification: null,
    staleReasons: [],
    ...overrides,
  };
}

function indexOf(...entries: ArtifactEntry[]): ArtifactIndex {
  const index = emptyArtifactIndex();
  for (const item of entries) {
    Object.defineProperty(index.entries, item.path, {
      value: item,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return index;
}

describe('artifacts.json', () => {
  it('round-trips an index with the entries in path order', () => {
    const index = indexOf(
      entry('results/b.csv', { status: '已生成', runId: RUN_ID }),
      entry('figures/a.png'),
      entry('paper/main.pdf', {
        status: '已过期',
        runId: RUN_ID,
        verification: { verifiedAt: '2026-09-20T10:20:05+08:00', runId: RUN_ID },
        staleReasons: [{ kind: 'input-changed', path: 'data/in.csv' }],
      }),
      entry('results/failed.csv', { status: '执行失败', runId: RUN_ID, failure: '超时' })
    );
    const text = serializeArtifactIndex(index);

    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text).entries)).toEqual([
      'figures/a.png',
      'paper/main.pdf',
      'results/b.csv',
      'results/failed.csv',
    ]);
    const parsed = parseArtifactIndex(text);
    expect(parsed).not.toBeNull();
    expect(sameArtifactIndex(parsed as ArtifactIndex, index)).toBe(true);
  });

  it('rejects files that are not an index and drops malformed entries', () => {
    expect(parseArtifactIndex('{ not json')).toBeNull();
    expect(parseArtifactIndex('[]')).toBeNull();
    expect(parseArtifactIndex(JSON.stringify({ schemaVersion: 2, entries: {} }))).toBeNull();
    expect(parseArtifactIndex(JSON.stringify({ schemaVersion: 1 }))).toBeNull();

    const good = entry(OUT, { status: '已生成', runId: RUN_ID });
    const parsed = parseArtifactIndex(
      JSON.stringify({
        schemaVersion: 1,
        entries: {
          [OUT]: good,
          'results/other-key.csv': entry('results/not-the-key.csv'),
          '../escape.csv': entry('../escape.csv'),
          'results/bad-status.csv': { ...entry('results/bad-status.csv'), status: 'done' },
          'results/bad-run.csv': { ...entry('results/bad-run.csv'), runId: 'run-1' },
          'results/bad-reason.csv': {
            ...entry('results/bad-reason.csv'),
            staleReasons: [{ kind: 'renamed', path: 'x' }],
          },
          'results/bad-failure.csv': { ...entry('results/bad-failure.csv'), failure: 'crashed' },
        },
      })
    );

    expect(parsed?.entries).toEqual({ [OUT]: good });
  });

  it('keeps a file named __proto__ as an ordinary entry', () => {
    const stored = JSON.stringify(entry('__proto__'));
    const parsed = parseArtifactIndex(`{"schemaVersion":1,"entries":{"__proto__":${stored}}}`);

    expect(parsed).not.toBeNull();
    const index = parsed as ArtifactIndex;
    expect(Object.getPrototypeOf(index.entries)).toBe(Object.prototype);
    expect(getArtifactEntry(index, '__proto__')).toEqual(entry('__proto__'));
    expect(serializeArtifactIndex(index)).toContain('"__proto__"');
  });
});

describe('applyNewRuns', () => {
  it('applies a record the index has not taken in and is idempotent afterwards', () => {
    const record = runRecord();
    const once = applyNewRuns(emptyArtifactIndex(), [record]);

    expect(getArtifactEntry(once, OUT)).toEqual(entry(OUT, { status: '已生成', runId: RUN_ID }));
    expect(applyNewRuns(once, [record])).toBe(once);

    // A verification survives a rescan of the same records (requirement 17.2).
    const verified = markVerified(
      once,
      new Map([[RUN_ID, record]]),
      OUT,
      new Date('2026-09-20T02:20:05.500Z')
    );
    expect(verified.ok).toBe(true);
    const again = applyNewRuns(verified.index, [record]);
    expect(getArtifactEntry(again, OUT)?.status).toBe('已验证');
    expect(getArtifactEntry(again, OUT)?.verification?.runId).toBe(RUN_ID);
  });

  it('applies records oldest first, whatever order they come in', () => {
    const older = runRecord();
    const newer = runRecord({ runId: LATER_RUN_ID, exitCode: 2, failure: '非零退出码' });

    for (const records of [
      [older, newer],
      [newer, older],
    ]) {
      const index = applyNewRuns(emptyArtifactIndex(), records);
      expect(getArtifactEntry(index, OUT)).toEqual(
        entry(OUT, { status: '执行失败', runId: LATER_RUN_ID, failure: '非零退出码' })
      );
      // An old record found late does not overwrite the later run.
      expect(applyNewRuns(index, [older])).toBe(index);
    }
  });

  it('ends a pending run, also when the record got a new suffix', () => {
    const pending = applyRunStarted(emptyArtifactIndex(), RUN_ID, [OUT, 'results/never.csv']);

    const finished = applyNewRuns(pending, [runRecord()]);
    expect(getArtifactEntry(finished, OUT)?.status).toBe('已生成');
    expect(getArtifactEntry(finished, 'results/never.csv')?.status).toBe('未开始');

    const renamed = '20260920T101530123-zzzzzz';
    const collided = applyNewRuns(pending, [runRecord({ runId: renamed })]);
    expect(getArtifactEntry(collided, OUT)).toEqual(
      entry(OUT, { status: '已生成', runId: renamed })
    );
  });

  it('leaves a newer pending run alone when an older record turns up', () => {
    const pending = applyRunStarted(emptyArtifactIndex(), LATER_RUN_ID, [OUT]);

    expect(applyNewRuns(pending, [runRecord()])).toBe(pending);
  });
});

describe('syncDiscoveredFiles', () => {
  it('discovers result files and forgets discovered files that are gone', () => {
    const state = indexOf(
      entry('results/gone.csv'),
      entry('results/declared.csv', { status: '未开始' }),
      entry('results/never.csv', { status: '未开始' }),
      entry(OUT, { status: '已过期', runId: RUN_ID, staleReasons: [{ kind: 'missing', path: OUT }] })
    );
    const scanned = ['figures/new.png', 'results/declared.csv'];

    const next = syncDiscoveredFiles(state, scanned, new Set(scanned));

    expect(Object.keys(next.entries).sort()).toEqual([
      'figures/new.png',
      'results/declared.csv',
      'results/never.csv',
      OUT,
    ]);
    expect(getArtifactEntry(next, 'figures/new.png')).toEqual(entry('figures/new.png'));
    expect(getArtifactEntry(next, 'results/declared.csv')?.status).toBe('已发现文件');
    expect(getArtifactEntry(next, OUT)).toBe(getArtifactEntry(state, OUT));
    expect(fileOnlyPaths(next).sort()).toEqual([
      'figures/new.png',
      'results/declared.csv',
      'results/never.csv',
    ]);
  });

  it('returns the index itself when nothing changed', () => {
    const state = indexOf(entry('figures/a.png'));

    expect(syncDiscoveredFiles(state, ['figures/a.png'], new Set(['figures/a.png']))).toBe(state);
  });
});

describe('file comparison', () => {
  const record = runRecord({
    inputs: [
      { path: 'data/in.csv', sha256: sha256(INPUT_TEXT) },
      { path: 'data/extra.csv', sha256: sha256('extra') },
      { path: 'data/locked.csv', sha256: sha256('locked') },
      // Read and rewritten by the run: compared with what it wrote.
      { path: 'data/cache.csv', sha256: sha256('before') },
    ],
    outputs: [
      { path: OUT, sha256: sha256(OUTPUT_TEXT) },
      { path: 'data/cache.csv', sha256: sha256('after') },
    ],
  });

  it('lists what a detection pass has to hash', () => {
    const state = indexOf(
      entry(OUT, { status: '已生成', runId: RUN_ID }),
      entry('results/old.csv', { status: '已验证', runId: LATER_RUN_ID }),
      entry('figures/a.png')
    );

    expect(staleCheckPaths(state, new Map([[RUN_ID, record]])).sort()).toEqual([
      'code/q1.py',
      'data/cache.csv',
      'data/extra.csv',
      'data/in.csv',
      'data/locked.csv',
      OUT,
    ]);
    expect(inspectionPaths(OUT, record)).toEqual([
      'code/q1.py',
      'data/in.csv',
      'data/extra.csv',
      'data/locked.csv',
      'data/cache.csv',
      OUT,
    ]);
  });

  it('compares the code, the inputs and the Artifact with the record', () => {
    const hashes = new Map([
      ['code/q1.py', sha256(CODE_TEXT)],
      ['data/in.csv', sha256('edited')],
      ['data/extra.csv', FILE_HASH_MISSING],
      ['data/locked.csv', FILE_HASH_UNREADABLE],
      ['data/cache.csv', sha256('after')],
      [OUT, sha256('changed by hand')],
    ]);

    expect(
      artifactFileChecks(OUT, record, hashes).map(({ path, role, state }) => [path, role, state])
    ).toEqual([
      ['code/q1.py', 'code', 'match'],
      ['data/in.csv', 'input', 'changed'],
      ['data/extra.csv', 'input', 'missing'],
      ['data/locked.csv', 'input', 'unreadable'],
      ['data/cache.csv', 'input', 'match'],
      [OUT, 'artifact', 'changed'],
    ]);
  });

  it('says so when the record has no output hash for the Artifact', () => {
    const checks = artifactFileChecks('results/unlisted.csv', record, new Map());

    expect(checks[checks.length - 1]).toEqual({
      path: 'results/unlisted.csv',
      role: 'artifact',
      recorded: null,
      current: FILE_HASH_MISSING,
      state: 'missing',
    });
    const present = artifactFileChecks(
      'results/unlisted.csv',
      record,
      new Map([['results/unlisted.csv', sha256('x')]])
    );
    expect(present[present.length - 1].state).toBe('unrecorded');
  });
});

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactsChangedEvent } from '../../types/runsApi';
import { getArtifactEntry } from '../artifactStatus';
import { serializeRunRecord } from '../runRecord';
import {
  CODE_TEXT,
  INPUT_TEXT,
  LATER_RUN_ID,
  OUTPUT_TEXT,
  RUN_ID,
  runRecord,
} from '../../test/runRecordFixtures';
import {
  createArtifactStore,
  isRelevantChange,
  type ArtifactStore,
  type WatchProject,
} from './artifactStore';
import { parseArtifactIndex, sameArtifactIndex } from './artifactSync';
import { createRunRecordReader } from './runRecordFiles';

const OUT = 'results/out.csv';
const RECORD_PATH = `.modelforge/runs/${RUN_ID}.json`;
const quiet = () => undefined;

const tempDirs: string[] = [];
const stores: ArtifactStore[] = [];

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, ...relative.split('/'));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
}

/** A Project whose run of `code/q1.py` wrote `results/out.csv`, plus a figure. */
async function project(extra: Record<string, string> = {}): Promise<string> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-store-')));
  tempDirs.push(root);
  await writeFiles(root, {
    'data/in.csv': INPUT_TEXT,
    'code/q1.py': CODE_TEXT,
    [OUT]: OUTPUT_TEXT,
    'figures/plot.png': 'png',
    [RECORD_PATH]: serializeRunRecord(runRecord()),
    ...extra,
  });
  return root;
}

function store(options: Parameters<typeof createArtifactStore>[0] = {}): ArtifactStore {
  const created = createArtifactStore({ watch: null, log: quiet, ...options });
  stores.push(created);
  return created;
}

afterEach(async () => {
  stores.splice(0).forEach((created) => created.close());
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Artifact store', () => {
  it('applies records, discovers result files and saves the index on opening', async () => {
    const root = await project();
    const artifacts = store();
    const changes: ArtifactsChangedEvent[] = [];
    artifacts.subscribe((event) => changes.push(event));

    const index = await artifacts.getIndex(root);

    expect(getArtifactEntry(index, OUT)).toMatchObject({ status: '已生成', runId: RUN_ID });
    expect(getArtifactEntry(index, 'figures/plot.png')).toMatchObject({ status: '已发现文件' });
    // Inputs and code are not Artifacts.
    expect(getArtifactEntry(index, 'data/in.csv')).toBeUndefined();
    const saved = parseArtifactIndex(
      await fs.readFile(path.join(root, '.modelforge', 'artifacts.json'), 'utf8')
    );
    expect(saved && sameArtifactIndex(saved, index)).toBe(true);
    expect(changes).toEqual([{ projectDir: root, index }]);

    // Nothing changed: the next pass keeps the index and tells nobody.
    expect(await artifacts.checkStale(root)).toBe(index);
    expect(changes).toHaveLength(1);
  });

  it('keeps a verification across restarts and outdates it when an input changes', async () => {
    const root = await project();
    const first = store({ now: () => new Date('2026-09-20T02:20:05.900Z') });
    await first.getIndex(root);

    const verified = await first.verify(root, OUT);
    expect(verified.ok).toBe(true);

    // Requirement 17.2: the verification survives a restart.
    const restarted = store();
    const reread = await restarted.getIndex(root);
    expect(getArtifactEntry(reread, OUT)).toMatchObject({
      status: '已验证',
      runId: RUN_ID,
      verification: { runId: RUN_ID },
    });

    await fs.writeFile(path.join(root, 'data', 'in.csv'), 'edited\n');
    const stale = await restarted.checkStale(root);
    expect(getArtifactEntry(stale, OUT)).toMatchObject({
      status: '已过期',
      runId: RUN_ID,
      verification: { runId: RUN_ID },
      staleReasons: [{ kind: 'input-changed', path: 'data/in.csv' }],
    });

    // Requirement 17.7: an outdated result cannot be verified.
    const refused = await restarted.verify(root, OUT);
    expect(refused).toMatchObject({ ok: false, reason: 'not-generated' });
  });

  it('reports a result changed outside ModelForge and a missing input', async () => {
    const root = await project();
    const artifacts = store();
    await artifacts.getIndex(root);

    await fs.writeFile(path.join(root, ...OUT.split('/')), 'edited by hand\n');
    expect(getArtifactEntry(await artifacts.checkStale(root), OUT)).toMatchObject({
      status: '已过期',
      staleReasons: [{ kind: 'output-modified', path: OUT }],
    });

    const other = await project();
    await artifacts.getIndex(other);
    await fs.rm(path.join(other, 'data', 'in.csv'));
    expect(getArtifactEntry(await artifacts.checkStale(other), OUT)).toMatchObject({
      status: '已过期',
      staleReasons: [{ kind: 'missing', path: 'data/in.csv' }],
    });
  });

  it('shows the record behind a result and how its files compare', async () => {
    const root = await project();
    const artifacts = store();
    await fs.writeFile(path.join(root, 'data', 'in.csv'), 'edited\n');

    const inspection = await artifacts.inspect(root, OUT);

    expect(inspection.record?.runId).toBe(RUN_ID);
    expect(inspection.files.map(({ path: file, role, state }) => [file, role, state])).toEqual([
      ['code/q1.py', 'code', 'match'],
      ['data/in.csv', 'input', 'changed'],
      [OUT, 'artifact', 'match'],
    ]);

    const figure = await artifacts.inspect(root, 'figures/plot.png');
    expect(figure.entry?.status).toBe('已发现文件');
    expect(figure.record).toBeNull();
    expect(figure.files).toEqual([]);
  });

  it('lists the records, reports broken files and skips metadata and partial writes', async () => {
    const root = await project({
      [`.modelforge/runs/${RUN_ID}.meta.json`]: '{ "method": "linear regression" }',
      '.modelforge/runs/.run-4f2a.tmp': '{ "schemaVersion": 1,',
      [`.modelforge/runs/${LATER_RUN_ID}.json`]: '{ "schemaVersion": 1,',
      '.modelforge/runs/bad.json': '{}',
    });
    const artifacts = store();

    const loaded = await artifacts.listRuns(root);

    expect(loaded.records.map((record) => record.path)).toEqual([RECORD_PATH]);
    expect(loaded.problems.map((problem) => problem.path)).toEqual([
      `.modelforge/runs/${LATER_RUN_ID}.json`,
      '.modelforge/runs/bad.json',
    ]);
    expect(loaded.problems[0].parseErrorAt).toBeDefined();
    expect(loaded.problems[1].missing).toContain('runId');
    // The broken files do not keep the valid record from counting (requirement 16.5).
    expect(getArtifactEntry(await artifacts.getIndex(root), OUT)?.status).toBe('已生成');
  });

  it('follows a run from its start notice to its record', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-run-')));
    tempDirs.push(root);
    await writeFiles(root, { 'data/in.csv': INPUT_TEXT, 'code/q1.py': CODE_TEXT });
    await fs.mkdir(path.join(root, '.modelforge'));
    const artifacts = store();

    const started = await artifacts.runStarted({
      workingDir: root,
      runId: RUN_ID,
      declaredOutputs: [OUT, '../escape.csv', '.modelforge/notes.json'],
    });
    expect(Object.keys(started.entries)).toEqual([OUT]);
    expect(getArtifactEntry(started, OUT)).toMatchObject({ status: '执行中', runId: RUN_ID });

    await writeFiles(root, { [OUT]: OUTPUT_TEXT, [RECORD_PATH]: serializeRunRecord(runRecord()) });
    const finished = await artifacts.runFinished({
      workingDir: root,
      runId: RUN_ID,
      recordPath: RECORD_PATH,
    });
    expect(getArtifactEntry(finished, OUT)).toMatchObject({ status: '已生成', runId: RUN_ID });

    // A start notice that arrives after the record is already over.
    expect(
      await artifacts.runStarted({ workingDir: root, runId: RUN_ID, declaredOutputs: [OUT] })
    ).toEqual(finished);
  });

  /** A Project with the code and data of a run that has not started yet. */
  async function emptyRunProject(): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-run-')));
    tempDirs.push(root);
    await writeFiles(root, { 'data/in.csv': INPUT_TEXT, 'code/q1.py': CODE_TEXT });
    await fs.mkdir(path.join(root, '.modelforge'));
    return root;
  }

  const recordMissing = { kind: 'record-missing', path: RECORD_PATH };

  it('keeps a live run 执行中 and ends it when its record cannot be read', async () => {
    const root = await emptyRunProject();
    const artifacts = store();
    await artifacts.runStarted({
      workingDir: root,
      runId: RUN_ID,
      declaredOutputs: [OUT],
      toolCallId: 'call-1',
    });

    // Passes while the run goes on leave it alone.
    expect(getArtifactEntry(await artifacts.checkStale(root), OUT)?.status).toBe('执行中');

    await writeFiles(root, { [OUT]: OUTPUT_TEXT, [RECORD_PATH]: '{ "schemaVersion": 1,' });
    const finished = await artifacts.runFinished({
      workingDir: root,
      runId: RUN_ID,
      recordPath: RECORD_PATH,
      toolCallId: 'call-1',
    });
    expect(getArtifactEntry(finished, OUT)).toMatchObject({
      status: '已过期',
      runId: RUN_ID,
      staleReasons: [recordMissing],
    });

    // Once the record is repaired, the next pass applies it.
    await writeFiles(root, { [RECORD_PATH]: serializeRunRecord(runRecord()) });
    expect(getArtifactEntry(await artifacts.checkStale(root), OUT)).toMatchObject({
      status: '已生成',
      runId: RUN_ID,
      staleReasons: [],
    });
  });

  it('ends a run whose record was written under another suffix', async () => {
    const root = await emptyRunProject();
    const renamed = `${RUN_ID.slice(0, 18)}-zzzzzz`;
    const renamedPath = `.modelforge/runs/${renamed}.json`;
    const artifacts = store();
    await artifacts.runStarted({
      workingDir: root,
      runId: RUN_ID,
      declaredOutputs: [OUT, 'results/never.csv'],
      toolCallId: 'call-2',
    });

    await writeFiles(root, {
      [OUT]: OUTPUT_TEXT,
      [renamedPath]: serializeRunRecord(runRecord({ runId: renamed })),
    });
    const finished = await artifacts.runFinished({
      workingDir: root,
      runId: renamed,
      recordPath: renamedPath,
      toolCallId: 'call-2',
    });

    expect(getArtifactEntry(finished, OUT)).toMatchObject({ status: '已生成', runId: renamed });
    expect(getArtifactEntry(finished, 'results/never.csv')).toMatchObject({
      status: '未开始',
      runId: null,
    });
  });

  it('ends a run that left no record once its tool call is over', async () => {
    const root = await emptyRunProject();
    const artifacts = store();
    await artifacts.runStarted({ workingDir: root, runId: RUN_ID, declaredOutputs: [OUT] });

    // The renderer reports the end of the tool call as the end of the run it started.
    const ended = await artifacts.runFinished({
      workingDir: root,
      runId: RUN_ID,
      recordPath: RECORD_PATH,
    });

    expect(getArtifactEntry(ended, OUT)).toMatchObject({
      status: '已过期',
      staleReasons: [recordMissing],
    });
  });

  it('ends on opening what an earlier session left 执行中', async () => {
    const root = await emptyRunProject();
    const before = store();
    await before.runStarted({ workingDir: root, runId: RUN_ID, declaredOutputs: [OUT] });
    before.close();

    // A restart: the kernel that ran it is gone, and no record was written.
    const index = await store().getIndex(root);

    expect(getArtifactEntry(index, OUT)).toMatchObject({
      status: '已过期',
      runId: RUN_ID,
      staleReasons: [recordMissing],
    });
  });

  it('outdates the Artifacts of a resumed step whose record is missing', async () => {
    const root = await project();
    const artifacts = store();
    expect(getArtifactEntry(await artifacts.getIndex(root), OUT)?.status).toBe('已生成');
    await fs.rm(path.join(root, ...RECORD_PATH.split('/')));

    const index = await artifacts.markResumeStale(root, { id: 'fit', runIds: [RUN_ID] }, [
      { kind: 'record-missing', runId: RUN_ID },
    ]);

    expect(getArtifactEntry(index, OUT)).toMatchObject({
      status: '已过期',
      runId: RUN_ID,
      staleReasons: [recordMissing],
    });
    // Saved, so the panel shows it after a restart too.
    expect(getArtifactEntry(await store().getIndex(root), OUT)?.status).toBe('已过期');
  });

  it('refuses malformed requests', async () => {
    const root = await project();
    const artifacts = store();

    await expect(artifacts.getIndex('relative/project')).rejects.toMatchObject({
      code: 'INVALID_PROJECT',
    });
    await expect(artifacts.getIndex(path.join(root, 'missing'))).rejects.toMatchObject({
      code: 'INVALID_PROJECT',
    });
    await expect(artifacts.verify(root, '../outside.csv')).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
    await expect(
      artifacts.runFinished({ workingDir: root, runId: RUN_ID, recordPath: '../other.json' })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
    await expect(
      artifacts.runStarted({ workingDir: root, runId: '../../x', declaredOutputs: [] })
    ).rejects.toMatchObject({ code: 'INVALID_EVENT' });
  });

  it('leaves a folder that is not a ModelForge Project untouched', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'modelforge-plain-')));
    tempDirs.push(root);
    await writeFiles(root, { 'results/table.csv': '1\n' });

    const index = await store().getIndex(root);

    expect(getArtifactEntry(index, 'results/table.csv')?.status).toBe('已发现文件');
    await expect(fs.stat(path.join(root, '.modelforge'))).rejects.toThrow();
  });

  it('runs a detection pass shortly after a relevant change', async () => {
    const root = await project();
    const hooks: { onChange?: (relativePath: string | null) => void } = {};
    const close = vi.fn();
    const watch: WatchProject = (_root, onChange) => {
      hooks.onChange = onChange;
      return { close };
    };
    const reader = createRunRecordReader();
    const load = vi.fn(reader.load);
    const artifacts = store({ watch, records: { load }, debounceMs: 10, maxWaitMs: 50 });
    const changes: ArtifactsChangedEvent[] = [];

    await artifacts.getIndex(root);
    artifacts.subscribe((event) => changes.push(event));
    expect(hooks.onChange).toBeDefined();
    // While the watcher saw nothing, opening the Project again needs no pass.
    await artifacts.getIndex(root);
    expect(load).toHaveBeenCalledTimes(1);

    // The index's own writes are not changes.
    hooks.onChange?.('.modelforge/artifacts.json');
    hooks.onChange?.(path.join('.modelforge', '.artifacts.json.123.abc.tmp'));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(load).toHaveBeenCalledTimes(1);

    await fs.writeFile(path.join(root, 'data', 'in.csv'), 'edited\n');
    hooks.onChange?.(path.join('data', 'in.csv'));
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(getArtifactEntry(changes[0].index, OUT)?.status).toBe('已过期');

    artifacts.close();
    expect(close).toHaveBeenCalled();
  });

  it('tells which changes can affect an Artifact', () => {
    expect(isRelevantChange(null)).toBe(true);
    expect(isRelevantChange('data/in.csv')).toBe(true);
    expect(isRelevantChange('paper\\main.pdf')).toBe(true);
    expect(isRelevantChange(`.modelforge/runs/${RUN_ID}.json`)).toBe(true);
    expect(isRelevantChange(`.modelforge\\runs\\${RUN_ID}.json`)).toBe(true);
    expect(isRelevantChange('.modelforge/artifacts.json')).toBe(false);
    expect(isRelevantChange(`.modelforge/runs/${RUN_ID}.meta.json`)).toBe(false);
    expect(isRelevantChange('.modelforge/runs/.run-4f2a.tmp')).toBe(false);
    expect(isRelevantChange('.modelforge/tasks/t1.json')).toBe(false);
    expect(isRelevantChange('.git/index')).toBe(false);
    expect(isRelevantChange('node_modules/pkg/index.js')).toBe(false);
  });
});

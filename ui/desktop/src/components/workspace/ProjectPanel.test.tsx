import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { ArtifactEntry, ArtifactIndex } from '../../types/artifactStatus';
import type { ArtifactInspection, ArtifactsChangedEvent } from '../../types/runsApi';
import type { ProjectArtifact, ProjectSnapshot, ProjectStage } from '../../types/workspaceApi';
import { RUN_ID, runRecord, sha256, CODE_TEXT } from '../../test/runRecordFixtures';
import ProjectPanel from './ProjectPanel';

const originalElectron = window.electron;
const scan = vi.fn();
const compose = vi.fn();
const openFile = vi.fn();
const artifactsGet = vi.fn();
const artifactsInspect = vi.fn();
const artifactsVerify = vi.fn();
const artifactsCheckStale = vi.fn();
const unsubscribe = vi.fn();
let pushArtifactsChanged: ((event: ArtifactsChangedEvent) => void) | undefined;
const onArtifactsChanged = vi.fn((callback: (event: ArtifactsChangedEvent) => void) => {
  pushArtifactsChanged = callback;
  return unsubscribe;
});

const OUT = 'results/out.csv';
const FIGURE = 'figures/plot.png';

function file(root: string, relativePath: string, stage: ProjectStage): ProjectArtifact {
  const name = relativePath.split('/').pop() ?? relativePath;
  return {
    name,
    relativePath,
    path: `${root}/${relativePath}`,
    isDirectory: false,
    size: 12,
    modifiedAt: 1,
    stage,
  };
}

function snapshot(root: string, filename = 'source.csv'): ProjectSnapshot {
  return {
    root,
    scannedAt: 1,
    limited: false,
    unreadableDirectories: 0,
    artifacts: [file(root, `data/${filename}`, 'inputs')],
  };
}

/** A Project with input data, a computed result and a figure. */
function resultSnapshot(root: string): ProjectSnapshot {
  return {
    ...snapshot(root),
    artifacts: [
      file(root, 'data/source.csv', 'inputs'),
      file(root, OUT, 'results'),
      file(root, FIGURE, 'figures'),
    ],
  };
}

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
  const byPath = Object.fromEntries(entries.map((item) => [item.path, item]));
  return { schemaVersion: 1, entries: byPath };
}

function inspection(overrides: Partial<ArtifactInspection> = {}): ArtifactInspection {
  return { path: OUT, entry: null, record: null, files: [], ...overrides };
}

const panel = (workingDir: string) => (
  <IntlTestWrapper>
    <ProjectPanel workingDir={workingDir} onCompose={compose} onOpenFile={openFile} />
  </IntlTestWrapper>
);

beforeEach(() => {
  vi.clearAllMocks();
  pushArtifactsChanged = undefined;
  artifactsGet.mockResolvedValue({ ok: true, data: indexOf() });
  artifactsInspect.mockResolvedValue({ ok: true, data: inspection() });
  window.electron = {
    ...originalElectron,
    workspaceScanProject: scan,
    artifactsGet,
    artifactsInspect,
    artifactsVerify,
    artifactsCheckStale,
    onArtifactsChanged,
  };
});
afterEach(() => {
  window.electron = originalElectron;
});

describe('project workflow', () => {
  it('shows real file evidence, opens the file, and prepares a draft without submitting it', async () => {
    scan.mockResolvedValue(snapshot('/project'));
    render(panel('/project'));
    const file = await screen.findByRole('button', { name: 'data/source.csv' });
    fireEvent.click(file);
    expect(openFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/project/data/source.csv' })
    );
    fireEvent.click(screen.getAllByRole('button', { name: 'Prepare model plan' })[0]);
    expect(compose).toHaveBeenCalledWith(expect.stringContaining('model_plan.md'));
    expect(compose).toHaveBeenCalledWith(expect.stringContaining('/project'));
    expect(screen.getByRole('status')).toHaveTextContent('Added to your draft');
    expect(screen.getByText('1 of 6 material types found')).toBeVisible();
  });

  it('ignores a late response from the previous project', async () => {
    let resolveOld!: (value: ProjectSnapshot) => void;
    scan.mockImplementation((root: string) =>
      root === '/old'
        ? new Promise((resolve) => {
            resolveOld = resolve;
          })
        : Promise.resolve(snapshot('/new', 'new.csv'))
    );
    const view = render(panel('/old'));
    view.rerender(panel('/new'));
    await screen.findByRole('button', { name: 'data/new.csv' });
    resolveOld(snapshot('/old', 'old.csv'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'data/old.csv' })).not.toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'data/new.csv' })).toBeVisible();
  });

  it('shows a recoverable error and retries', async () => {
    scan
      .mockRejectedValueOnce(new Error('not available'))
      .mockResolvedValueOnce(snapshot('/project'));
    render(panel('/project'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not read this project');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'data/source.csv' })).toBeVisible();
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('does not count an empty file as available material', async () => {
    const empty = snapshot('/project');
    empty.artifacts[0].size = 0;
    empty.limited = true;
    scan.mockResolvedValue(empty);
    render(panel('/project'));
    expect(await screen.findByText('0 of 6 material types found')).toBeVisible();
    expect(screen.getByText(/Some folders were not scanned/)).toBeVisible();
    expect(screen.getByRole('button', { name: /data\/source.csv/ })).toHaveTextContent(
      'Empty file'
    );
  });
});

describe('artifact status', () => {
  it('shows one status per result and flags a file changed outside ModelForge', async () => {
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsGet.mockResolvedValue({
      ok: true,
      data: indexOf(
        entry(OUT, {
          status: '已过期',
          runId: RUN_ID,
          staleReasons: [{ kind: 'output-modified', path: OUT }],
        }),
        entry(FIGURE),
        entry('results/pending.csv', { status: '执行中', runId: RUN_ID })
      ),
    });
    render(panel('/project'));

    expect(
      await screen.findByRole('button', { name: `Out of date: show details for ${OUT}` })
    ).toHaveTextContent('Out of date');
    expect(
      screen.getByRole('button', { name: `File found: show details for ${FIGURE}` })
    ).toBeVisible();
    expect(screen.getByText('Changed outside ModelForge')).toBeVisible();
    // Inputs are not Artifacts, so they carry no status.
    expect(
      screen.queryByRole('button', { name: /show details for data\/source.csv/ })
    ).not.toBeInTheDocument();
    // A tracked output that is not in the file lists still shows its status.
    expect(screen.getByText('Other tracked results')).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Running: show details for results/pending.csv' })
    ).toBeVisible();
    expect(artifactsGet).toHaveBeenCalledWith('/project');
    // The file itself still opens from its own button.
    fireEvent.click(screen.getByRole('button', { name: OUT }));
    expect(openFile).toHaveBeenCalledWith(expect.objectContaining({ relativePath: OUT }));
  });

  it('shows the run record behind a selected result', async () => {
    const verified = entry(OUT, {
      status: '已验证',
      runId: RUN_ID,
      verification: { verifiedAt: '2026-09-20T10:20:05+08:00', runId: RUN_ID },
    });
    const record = runRecord();
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsGet.mockResolvedValue({ ok: true, data: indexOf(verified) });
    artifactsInspect.mockResolvedValue({
      ok: true,
      data: inspection({
        entry: verified,
        record,
        files: [
          {
            path: 'code/q1.py',
            role: 'code',
            recorded: sha256(CODE_TEXT),
            current: sha256(CODE_TEXT),
            state: 'match',
          },
          {
            path: 'data/in.csv',
            role: 'input',
            recorded: record.inputs[0].sha256,
            current: sha256('edited'),
            state: 'changed',
          },
          {
            path: OUT,
            role: 'artifact',
            recorded: record.outputs[0].sha256,
            current: record.outputs[0].sha256,
            state: 'match',
          },
        ],
      }),
    });
    render(panel('/project'));

    fireEvent.click(
      await screen.findByRole('button', { name: `Verified: show details for ${OUT}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Result details' });
    expect(await within(dialog).findByText(RUN_ID)).toBeVisible();
    expect(artifactsInspect).toHaveBeenCalledWith('/project', OUT);
    expect(within(dialog).getByText('python code/q1.py')).toBeVisible();
    expect(within(dialog).getByText('Exit code')).toBeVisible();
    expect(within(dialog).getByText('0')).toBeVisible();
    expect(within(dialog).getByText(record.startedAt)).toBeVisible();
    expect(within(dialog).getByText(record.endedAt)).toBeVisible();
    expect(within(dialog).getByText('42')).toBeVisible();
    expect(
      within(dialog).getByText(`Recorded SHA-256: ${sha256(CODE_TEXT)}`)
    ).toBeVisible();
    expect(within(dialog).getByText('data/in.csv')).toBeVisible();
    expect(within(dialog).getByText('Changed since the run')).toBeVisible();
    expect(within(dialog).getAllByText('Matches the record')).toHaveLength(2);
    expect(
      within(dialog).getByText(`Verified at 2026-09-20T10:20:05+08:00 against run ${RUN_ID}`)
    ).toBeVisible();
    // Already verified: nothing left to mark.
    expect(
      within(dialog).queryByRole('button', { name: 'Mark as verified' })
    ).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says so when a result has no run record', async () => {
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsGet.mockResolvedValue({ ok: true, data: indexOf(entry(FIGURE)) });
    artifactsInspect.mockResolvedValue({
      ok: true,
      data: inspection({ path: FIGURE, entry: entry(FIGURE) }),
    });
    render(panel('/project'));

    fireEvent.click(
      await screen.findByRole('button', { name: `File found: show details for ${FIGURE}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Result details' });
    expect(await within(dialog).findByText('No run record')).toBeVisible();
  });

  it('shows why "Mark as verified" was refused', async () => {
    const found = indexOf(entry(FIGURE));
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsGet.mockResolvedValue({ ok: true, data: found });
    artifactsInspect.mockResolvedValue({
      ok: true,
      data: inspection({ path: FIGURE, entry: entry(FIGURE) }),
    });
    artifactsVerify.mockResolvedValue({
      ok: true,
      data: { ok: false, index: found, reason: 'not-generated' },
    });
    render(panel('/project'));

    fireEvent.click(
      await screen.findByRole('button', { name: `File found: show details for ${FIGURE}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Result details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as verified' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'only a result with the status Generated can be verified. This one is File found.'
    );
    expect(artifactsVerify).toHaveBeenCalledWith('/project', FIGURE);
    // The status is unchanged.
    expect(
      screen.getByRole('button', { name: `File found: show details for ${FIGURE}` })
    ).toBeVisible();
  });

  it('marks a generated result as verified', async () => {
    const generated = entry(OUT, { status: '已生成', runId: RUN_ID });
    const verified = entry(OUT, {
      status: '已验证',
      runId: RUN_ID,
      verification: { verifiedAt: '2026-09-20T10:20:05+08:00', runId: RUN_ID },
    });
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsGet.mockResolvedValue({ ok: true, data: indexOf(generated) });
    artifactsInspect.mockResolvedValue({
      ok: true,
      data: inspection({ entry: generated, record: runRecord() }),
    });
    artifactsVerify.mockResolvedValue({ ok: true, data: { ok: true, index: indexOf(verified) } });
    render(panel('/project'));

    fireEvent.click(
      await screen.findByRole('button', { name: `Generated: show details for ${OUT}` })
    );
    const dialog = await screen.findByRole('dialog', { name: 'Result details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark as verified' }));

    expect(
      await screen.findByRole('button', { name: `Verified: show details for ${OUT}` })
    ).toBeVisible();
    await waitFor(() =>
      expect(
        within(dialog).queryByRole('button', { name: 'Mark as verified' })
      ).not.toBeInTheDocument()
    );
  });

  it('follows the index the main process pushes for this Project only', async () => {
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsGet.mockResolvedValue({
      ok: true,
      data: indexOf(entry(OUT, { status: '已生成', runId: RUN_ID })),
    });
    render(panel('/project'));
    await screen.findByRole('button', { name: `Generated: show details for ${OUT}` });

    act(() => {
      pushArtifactsChanged?.({
        projectDir: '/elsewhere',
        index: indexOf(entry(OUT, { status: '执行失败', runId: RUN_ID, failure: '超时' })),
      });
    });
    expect(
      screen.getByRole('button', { name: `Generated: show details for ${OUT}` })
    ).toBeVisible();

    act(() => {
      pushArtifactsChanged?.({
        projectDir: '/project',
        index: indexOf(
          entry(OUT, {
            status: '已过期',
            runId: RUN_ID,
            staleReasons: [{ kind: 'input-changed', path: 'data/in.csv' }],
          })
        ),
      });
    });
    expect(
      screen.getByRole('button', { name: `Out of date: show details for ${OUT}` })
    ).toBeVisible();
  });

  it('checks for outdated results on demand', async () => {
    scan.mockResolvedValue(resultSnapshot('/project'));
    artifactsCheckStale
      .mockResolvedValueOnce({ ok: true, data: indexOf(entry(OUT, { status: '已过期' })) })
      .mockResolvedValueOnce({ ok: false, error: { code: 'READ_FAILED', message: 'denied' } });
    render(panel('/project'));
    await screen.findByRole('button', { name: OUT });

    fireEvent.click(screen.getByRole('button', { name: 'Check for outdated results' }));
    expect(
      await screen.findByRole('button', { name: `Out of date: show details for ${OUT}` })
    ).toBeVisible();
    expect(artifactsCheckStale).toHaveBeenCalledWith('/project');

    fireEvent.click(screen.getByRole('button', { name: 'Check for outdated results' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not check the results. Try again.'
    );
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type {
  RunCompareCandidate,
  RunCompareCandidates,
  RunCompareResult,
  RunCompareSide,
} from '../../types/runCompareApi';
import type { RunRecord } from '../../types/runRecord';
import RunComparePanel from './RunComparePanel';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../utils/sendSessionTask', () => ({ sendSessionTask: mocks.send }));

const RUN_A = '20260920T101530123-aaaaaa';
const RUN_B = '20260921T090000000-bbbbbb';
const RUN_C = '20260919T080000000-cccccc';
const HASH = '1'.repeat(64);

const originalElectron = window.electron;
const list = vi.fn();
const compare = vi.fn();
const compose = vi.fn();
const openFile = vi.fn();

function candidate(runId: string, overrides: Partial<RunCompareCandidate> = {}) {
  const run: RunCompareCandidate = {
    runId,
    command: 'python code/model.py',
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:16:35.623+08:00',
    exitCode: 0,
    failure: null,
    method: null,
    ...overrides,
  };
  return run;
}

const CANDIDATES: RunCompareCandidates = {
  runs: [
    candidate(RUN_B, { method: 'simulated annealing', exitCode: 1, failure: '非零退出码' }),
    candidate(RUN_A, { method: 'genetic algorithm' }),
    candidate(RUN_C),
  ],
  problems: [{ path: '.modelforge/runs/broken.json', missing: [], invalid: ['runId'] }],
};

function record(runId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schemaVersion: 1,
    runId,
    inputs: [{ path: 'data/a.csv', sha256: HASH }],
    inputsTruncated: false,
    code: { path: 'code/model.py', sha256: HASH },
    config: { provider: 'openai', model: 'gpt', runtime: 'python 3.12' },
    command: 'python code/model.py',
    dependencies: [],
    seed: '42',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:16:35.123+08:00',
    outputs: [],
    outputsTruncated: false,
    ...overrides,
  };
}

function side(runId: string, overrides: Partial<RunCompareSide> = {}): RunCompareSide {
  return {
    record: record(runId),
    meta: null,
    metaProblem: null,
    flags: [],
    failure: null,
    verifiedAt: null,
    ...overrides,
  };
}

function comparison(overrides: Partial<RunCompareResult> = {}): RunCompareResult {
  return {
    rows: [
      {
        kind: 'param',
        name: 'population',
        a: { present: true, text: '200' },
        b: { present: true, text: '100' },
        highlight: true,
      },
      {
        kind: 'param',
        name: 'temperature',
        a: { present: false, text: '—' },
        b: { present: true, text: '5' },
        highlight: false,
      },
      {
        kind: 'metric',
        name: 'rmse',
        a: { present: true, text: '0.1' },
        b: { present: true, text: '0.1' },
        highlight: false,
      },
    ],
    inputMismatch: ['data/a.csv'],
    a: side(RUN_A, {
      meta: {
        method: 'genetic algorithm',
        params: [{ name: 'population', value: 200 }],
        metrics: [{ name: 'rmse', value: 0.1 }],
      },
      flags: ['stale'],
      verifiedAt: '2026-09-20T10:20:05+08:00',
    }),
    b: side(RUN_B, {
      record: record(RUN_B, { exitCode: 1, failure: '非零退出码' }),
      flags: ['failed'],
      failure: '非零退出码',
    }),
    artifactIndex: 'present',
    ...overrides,
  };
}

interface PanelOptions {
  workingDir?: string;
  route?: string;
  isAgentActive?: boolean;
}

function renderPanel({
  workingDir = '/project',
  route = '/pair?resumeSessionId=session-1',
  isAgentActive = false,
}: PanelOptions = {}) {
  const ui = (dir: string, agentActive: boolean) => (
    <MemoryRouter initialEntries={[route]}>
      <IntlTestWrapper>
        <RunComparePanel
          workingDir={dir}
          active
          isAgentActive={agentActive}
          onOpenFile={openFile}
          onCompose={compose}
        />
      </IntlTestWrapper>
    </MemoryRouter>
  );
  const view = render(ui(workingDir, isAgentActive));
  return { ...view, switchProject: (dir: string) => view.rerender(ui(dir, isAgentActive)) };
}

const HINT = /Select exactly two run records of the same project/;
const hint = () => screen.getByText(HINT);
const checkbox = (runId: string) => screen.getByRole('checkbox', { name: new RegExp(runId) });
const compareButton = () => screen.getByRole('button', { name: 'Compare' });
const generateButton = () => screen.getByRole('button', { name: 'Generate comparison paragraph' });

async function openComparison() {
  fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(RUN_A) }));
  fireEvent.click(checkbox(RUN_B));
  fireEvent.click(compareButton());
  await screen.findByRole('columnheader', { name: /Run A/ });
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ ok: true, data: CANDIDATES });
  compare.mockResolvedValue({ ok: true, data: comparison() });
  window.electron = { ...originalElectron, runsCompareList: list, runsCompare: compare };
});

afterEach(() => {
  window.electron = originalElectron;
});

describe('RunComparePanel selection (requirement 21.4)', () => {
  it('enables Compare only while exactly two runs are selected', async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(RUN_A) }));
    expect(list).toHaveBeenCalledWith('/project');
    expect(compareButton()).toBeDisabled();
    expect(hint()).toHaveTextContent('Selected: 1');

    fireEvent.click(checkbox(RUN_B));
    expect(compareButton()).toBeEnabled();
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();

    fireEvent.click(checkbox(RUN_C));
    expect(compareButton()).toBeDisabled();
    expect(hint()).toHaveTextContent('Selected: 3');

    fireEvent.click(checkbox(RUN_C));
    fireEvent.click(compareButton());
    await screen.findByRole('columnheader', { name: /Run A/ });
    expect(compare).toHaveBeenCalledWith({ projectDir: '/project', runIdA: RUN_A, runIdB: RUN_B });
  });

  it('shows the hint and a disabled Compare before anything is selected', async () => {
    renderPanel();

    await screen.findByRole('checkbox', { name: new RegExp(RUN_A) });
    expect(compareButton()).toBeDisabled();
    expect(compareButton()).toHaveAccessibleDescription(
      /Select exactly two run records of the same project to compare them\. Selected: 0/
    );
  });

  it('drops the selection and the comparison when the project changes', async () => {
    const view = renderPanel({ workingDir: '/project-a' });
    await openComparison();

    view.switchProject('/project-b');

    await waitFor(() => expect(list).toHaveBeenLastCalledWith('/project-b'));
    await screen.findByRole('checkbox', { name: new RegExp(RUN_A) });
    expect(checkbox(RUN_A)).not.toBeChecked();
    expect(checkbox(RUN_B)).not.toBeChecked();
    expect(compareButton()).toBeDisabled();
    expect(screen.queryByRole('columnheader', { name: /Run A/ })).not.toBeInTheDocument();
  });

  it('lists record files that could not be read', async () => {
    renderPanel();

    expect(await screen.findByText('Run record files that could not be read: 1')).toBeVisible();
    expect(screen.getByText('.modelforge/runs/broken.json (invalid: runId)')).toBeInTheDocument();
  });

  it('reports a list that cannot be loaded and retries', async () => {
    list
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'READ_FAILED', message: 'EACCES: permission denied' },
      })
      .mockResolvedValueOnce({ ok: true, data: CANDIDATES });
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load the run records.');
    expect(alert).toHaveTextContent('EACCES: permission denied');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('checkbox', { name: new RegExp(RUN_A) })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('shows an empty state for a project without runs', async () => {
    list.mockResolvedValue({ ok: true, data: { runs: [], problems: [] } });
    renderPanel();

    expect(await screen.findByText(/No run records in this project yet/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Compare' })).not.toBeInTheDocument();
  });
});

describe('RunComparePanel comparison view', () => {
  it('shows both runs side by side with the input warning and the side markers', async () => {
    renderPanel();
    await openComparison();

    const warning = screen.getByRole('alert');
    expect(warning).toHaveTextContent('Input data differs; the comparison may be invalid.');
    expect(within(warning).getByText('data/a.csv')).toBeVisible();

    expect(screen.getByRole('columnheader', { name: /Run A/ })).toHaveTextContent('Out of date');
    expect(screen.getByRole('columnheader', { name: /Run B/ })).toHaveTextContent(
      'Failed: non-zero exit code'
    );

    const runIdRow = screen.getByRole('row', { name: /Run ID/ });
    expect(runIdRow).toHaveTextContent(RUN_A);
    expect(runIdRow).toHaveTextContent(RUN_B);
    expect(screen.getByRole('row', { name: /Method/ })).toHaveTextContent('genetic algorithm—');
    expect(screen.getByRole('row', { name: /Started/ })).toHaveTextContent(
      '2026-09-20 10:15:30 +08:00'
    );
    expect(screen.getByRole('row', { name: /Duration/ })).toHaveTextContent('0:01:05');
    expect(screen.getByRole('row', { name: /Exit code/ })).toHaveTextContent('Exit code01');
    expect(screen.getByRole('row', { name: /Verification/ })).toHaveTextContent(
      'Verified at 2026-09-20 10:20:05 +08:00Not verified'
    );

    const population = screen.getByRole('row', { name: /population/ });
    expect(within(population).getByText(/Values differ/)).toBeInTheDocument();
    expect(population).toHaveTextContent('200');
    expect(population).toHaveTextContent('100');
    const temperature = screen.getByRole('row', { name: /temperature/ });
    expect(within(temperature).queryByText(/Values differ/)).not.toBeInTheDocument();
    expect(temperature).toHaveTextContent('—');
  });

  it('says so when the inputs agree and verdicts are unknown', async () => {
    compare.mockResolvedValue({
      ok: true,
      data: comparison({
        inputMismatch: [],
        artifactIndex: 'missing',
        a: side(RUN_A),
        b: side(RUN_B),
      }),
    });
    renderPanel();
    await openComparison();

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Both runs read the same input files.')).toBeVisible();
    expect(screen.getByRole('row', { name: /Verification/ })).toHaveTextContent(
      'Unknown, no artifact status yet'
    );
  });

  it('reports a comparison that failed', async () => {
    compare.mockResolvedValue({
      ok: false,
      error: { code: 'RUN_NOT_FOUND', message: '.modelforge/runs/x.json does not exist' },
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('checkbox', { name: new RegExp(RUN_A) }));
    fireEvent.click(checkbox(RUN_B));
    fireEvent.click(compareButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not compare these runs.');
    expect(alert).toHaveTextContent('.modelforge/runs/x.json does not exist');
  });
});

describe('RunComparePanel comparison paragraph (requirement 21.3, 21.6)', () => {
  it('sends the writing task to the current session and reports success', async () => {
    mocks.send.mockResolvedValue({ ok: true });
    renderPanel();
    await openComparison();

    fireEvent.click(generateButton());

    expect(
      await screen.findByText('The comparison paragraph is in the current chat.')
    ).toBeVisible();
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [sessionId, task, timeoutMs] = mocks.send.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(timeoutMs).toBe(120_000);
    expect(task).toContain(`"${RUN_A}"`);
    expect(task).toContain(`"${RUN_B}"`);
    expect(task).toContain('"population" = 200');
    expect(task).toContain('输入数据不一致，对比结论可能无效');
    expect(task).toContain('"data/a.csv"');
    expect(task).toContain('验证结论：已验证');
    expect(compose).not.toHaveBeenCalled();
  });

  it.each([
    ['kernelUnavailable', 'Paragraph not generated: the Kernel is not available.'],
    ['timeout', 'Paragraph not generated: the Kernel did not finish within 120 seconds.'],
    ['kernelError', 'Paragraph not generated: the Kernel returned an error.'],
  ])('shows the %s category and lets the user retry', async (reason, text) => {
    let settle!: (outcome: unknown) => void;
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    renderPanel();
    await openComparison();

    fireEvent.click(generateButton());
    expect(
      await screen.findByText('Writing the paragraph in the current chat, up to 120 seconds…')
    ).toBeVisible();
    expect(generateButton()).toBeDisabled();

    settle({ ok: false, reason, detail: 'detail from the kernel' });

    expect(await screen.findByText(text)).toBeVisible();
    expect(screen.getByText('Details: detail from the kernel')).toBeVisible();
    expect(generateButton()).toBeEnabled();
    // The view and the selection stay (requirement 21.6).
    expect(screen.getByRole('columnheader', { name: /Run A/ })).toBeVisible();
    expect(checkbox(RUN_A)).toBeChecked();
    expect(checkbox(RUN_B)).toBeChecked();
    expect(screen.getByText('Input data differs; the comparison may be invalid.')).toBeVisible();

    mocks.send.mockResolvedValueOnce({ ok: true });
    fireEvent.click(generateButton());
    expect(
      await screen.findByText('The comparison paragraph is in the current chat.')
    ).toBeVisible();
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('puts the task into the chat input when the panel has no session', async () => {
    renderPanel({ route: '/' });
    await openComparison();

    fireEvent.click(generateButton());

    expect(
      screen.getByText('The writing task was added to the chat input. Send it to start.')
    ).toBeVisible();
    expect(compose).toHaveBeenCalledWith(expect.stringContaining(RUN_A));
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('waits while the chat is busy', async () => {
    renderPanel({ isAgentActive: true });
    await openComparison();

    expect(generateButton()).toBeDisabled();
    expect(
      screen.getByText('The current chat is still working. Try again when it finishes.')
    ).toBeVisible();
  });
});

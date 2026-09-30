import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatProvider } from '../../contexts/ChatContext';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { DataFileEntry, DataFileListResult, DataPreview } from '../../types/datasets';
import DatasetsView from './DatasetsView';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  target: vi.fn(),
  kernel: vi.fn(),
  seed: vi.fn(),
}));
vi.mock('../../utils/sendSessionTask', () => ({
  sendSessionTask: mocks.send,
  sessionTaskTarget: mocks.target,
  kernelUnavailableReason: mocks.kernel,
}));
vi.mock('../../utils/composerSeed', () => ({ seedComposer: mocks.seed }));
vi.mock('../../utils/workingDir', () => ({ getInitialWorkingDir: () => '/project' }));

const originalElectron = window.electron;
const list = vi.fn();
const previewFile = vi.fn();
const watch = vi.fn();
const unwatch = vi.fn();
const openPath = vi.fn();
let notifyChanged: ((root: string) => void) | null = null;
const onChanged = vi.fn((callback: (root: string) => void) => {
  notifyChanged = callback;
  return () => {
    notifyChanged = null;
  };
});

const FILE_A: DataFileEntry = {
  relativePath: 'data/a.csv',
  name: 'a.csv',
  size: 1536,
  modifiedAt: new Date(2026, 8, 20, 10, 15, 30).getTime(),
};
const FILE_B: DataFileEntry = {
  relativePath: 'raw/b.xlsx',
  name: 'b.xlsx',
  size: 3 * 1024 * 1024,
  modifiedAt: new Date(2026, 8, 19, 8, 5, 59).getTime(),
};

function listing(files: DataFileEntry[], total = files.length): DataFileListResult {
  return { files, total, truncated: total > files.length };
}

const PREVIEW: DataPreview = {
  fields: ['year', 'value'],
  totalRows: 2,
  previewRows: [
    [2024, 1.5],
    [2025, null],
  ],
  types: ['整数', '浮点数'],
  missingCounts: [0, 1],
  sheetNames: [],
  activeSheet: '',
};

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderView(sessionId = 'session-1') {
  const chat = { sessionId, name: 'Chat', messages: [], recipe: null, recipeParameterValues: null };
  return render(
    <MemoryRouter initialEntries={['/datasets']}>
      <IntlTestWrapper>
        <ChatProvider chat={chat} setChat={vi.fn()}>
          <Routes>
            <Route path="/datasets" element={<DatasetsView />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </ChatProvider>
      </IntlTestWrapper>
    </MemoryRouter>
  );
}

const generateButton = () => screen.getByRole('button', { name: 'Generate data description' });
const fileButton = (path: RegExp) => screen.getByRole('button', { name: path });

async function selectFileA() {
  fireEvent.click(await screen.findByRole('button', { name: /data\/a\.csv/ }));
  await screen.findByRole('heading', { name: 'data/a.csv' });
}

function deferSend() {
  let settle!: (outcome: unknown) => void;
  mocks.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      })
  );
  return (outcome: unknown) => settle(outcome);
}

beforeEach(() => {
  vi.clearAllMocks();
  notifyChanged = null;
  list.mockResolvedValue({ ok: true, data: listing([FILE_A, FILE_B]) });
  previewFile.mockResolvedValue({ ok: true, data: PREVIEW });
  watch.mockResolvedValue({ ok: true, data: null });
  unwatch.mockResolvedValue({ ok: true, data: null });
  openPath.mockResolvedValue(undefined);
  mocks.target.mockImplementation((sessionId: string | null) => sessionId || null);
  mocks.kernel.mockResolvedValue(null);
  window.electron = {
    ...originalElectron,
    datasetsList: list,
    datasetsPreview: previewFile,
    datasetsWatch: watch,
    datasetsUnwatch: unwatch,
    onDatasetsChanged: onChanged,
    workspaceOpenPath: openPath,
  };
});

afterEach(() => {
  window.electron = originalElectron;
});

describe('DatasetsView file list (requirement 10.1, 10.7)', () => {
  it('shows the empty state with the four supported formats and a disabled action', async () => {
    list.mockResolvedValue({ ok: true, data: listing([]) });
    renderView();

    expect(await screen.findByText('No data files to preview in this project')).toBeVisible();
    expect(screen.getByText('Supports .csv, .xlsx, .json, .parquet')).toBeVisible();
    expect(generateButton()).toBeDisabled();
    expect(generateButton()).toHaveAccessibleDescription('Select a file to generate a description');
    expect(list).toHaveBeenCalledWith('/project');
    expect(watch).toHaveBeenCalledWith('/project');
  });

  it('lists relative paths with size, time to the minute and the 1000-item notice', async () => {
    list.mockResolvedValue({ ok: true, data: listing([FILE_A, FILE_B], 1200) });
    renderView();

    expect(await screen.findByText('Showing first 1000 of 1200')).toBeVisible();
    expect(fileButton(/data\/a\.csv/)).toHaveTextContent('1.5 KB · 2026-09-20 10:15');
    expect(fileButton(/raw\/b\.xlsx/)).toHaveTextContent('3.0 MB · 2026-09-19 08:05');
    expect(screen.queryByText('No data files to preview in this project')).not.toBeInTheDocument();
  });

  it('reloads the list when the watched project changes', async () => {
    renderView();
    await screen.findByRole('button', { name: /data\/a\.csv/ });
    expect(list).toHaveBeenCalledTimes(1);

    notifyChanged?.('/elsewhere');
    notifyChanged?.('/project');

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('shows why a preview failed and offers the external program', async () => {
    previewFile.mockResolvedValue({
      ok: false,
      error: { code: 'TOO_LARGE', message: '250.0 MB exceeds the 200 MB limit' },
    });
    renderView();
    await selectFileA();

    expect(await screen.findByText('TOO_LARGE: 250.0 MB exceeds the 200 MB limit')).toBeVisible();
    expect(previewFile).toHaveBeenCalledWith({
      root: '/project',
      filePath: '/project/data/a.csv',
      sheet: undefined,
    });
    const [openButton] = screen.getAllByRole('button', { name: 'Open with system program' });
    fireEvent.click(openButton);
    expect(openPath).toHaveBeenCalledWith('/project/data/a.csv');
  });
});

describe('DatasetsView data description (requirement 10.3, 10.6)', () => {
  it('is disabled until a file is selected, then sends the task to the current chat', async () => {
    const settle = deferSend();
    renderView();
    await screen.findByRole('button', { name: /data\/a\.csv/ });
    expect(generateButton()).toBeDisabled();

    await selectFileA();
    expect(generateButton()).toBeEnabled();
    expect(await screen.findByRole('columnheader', { name: /year/ })).toBeVisible();

    fireEvent.click(generateButton());

    expect(
      await screen.findByText('Describing data/a.csv in the current chat, up to 10 minutes…')
    ).toBeVisible();
    expect(generateButton()).toBeDisabled();
    expect(mocks.target).toHaveBeenCalledWith('session-1', '/project');
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const [sessionId, task, timeoutMs] = mocks.send.mock.calls[0];
    expect(sessionId).toBe('session-1');
    expect(task).toContain('"data/a.csv"');
    expect(task).not.toContain('/project/data/a.csv');
    expect(timeoutMs).toBe(600_000);

    settle({ ok: true });

    expect(await screen.findByText('The description of data/a.csv is in the current chat.')).toBeVisible();
    expect(generateButton()).toBeEnabled();
    expect(mocks.seed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Open chat' }));
    expect(await screen.findByTestId('location')).toHaveTextContent(
      '/pair?resumeSessionId=session-1'
    );
  });

  it.each([
    ['kernelUnavailable', 'The task for data/a.csv was not sent: the Kernel is not available.'],
    ['timeout', 'No description for data/a.csv: the Kernel did not finish within 10 minutes.'],
    ['kernelError', 'No description for data/a.csv: sending failed or the Kernel returned an error.'],
    [
      'busy',
      'The current chat is still working, so the task for data/a.csv was not sent. Try again when it finishes.',
    ],
  ])('reports the %s category, keeps the selection and retries', async (reason, text) => {
    mocks.send.mockResolvedValueOnce({ ok: false, reason, detail: 'detail from the kernel' });
    renderView();
    await selectFileA();

    fireEvent.click(generateButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).toHaveTextContent('Details: detail from the kernel');
    expect(fileButton(/data\/a\.csv/)).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'data/a.csv' })).toBeVisible();
    expect(generateButton()).toBeEnabled();

    mocks.send.mockResolvedValueOnce({ ok: true });
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('The description of data/a.csv is in the current chat.')).toBeVisible();
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1][1]).toContain('"data/a.csv"');
  });

  it('clears a finished status when another file is selected', async () => {
    mocks.send.mockResolvedValueOnce({ ok: false, reason: 'kernelError', detail: 'boom' });
    renderView();
    await selectFileA();
    fireEvent.click(generateButton());
    await screen.findByRole('alert');

    fireEvent.click(fileButton(/raw\/b\.xlsx/));

    await screen.findByRole('heading', { name: 'raw/b.xlsx' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(generateButton()).toBeEnabled();
  });

  it('puts the task into the home composer when no chat of this project is open', async () => {
    renderView('');
    await selectFileA();

    fireEvent.click(generateButton());

    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/$/);
    expect(mocks.seed).toHaveBeenCalledTimes(1);
    expect(mocks.seed.mock.calls[0][0]).toContain('"data/a.csv"');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('reports an unavailable Kernel without a chat and retries', async () => {
    mocks.kernel.mockResolvedValueOnce('shim failed to start');
    renderView('');
    await selectFileA();

    fireEvent.click(generateButton());

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'The task for data/a.csv was not sent: the Kernel is not available.'
    );
    expect(alert).toHaveTextContent('Details: shim failed to start');
    expect(mocks.seed).not.toHaveBeenCalled();

    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/$/);
    expect(mocks.seed).toHaveBeenCalledTimes(1);
  });
});

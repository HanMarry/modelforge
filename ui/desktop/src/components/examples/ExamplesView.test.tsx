import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { ExampleEntry, ExampleManifest } from '../../types/catalog';
import ExamplesView from './ExamplesView';

const mocks = vi.hoisted(() => ({ openProject: vi.fn() }));
vi.mock('../../utils/pendingProject', () => ({ requestOpenProject: mocks.openProject }));

const originalElectron = window.electron;
const examplesList = vi.fn();
const directoryChooser = vi.fn();
const createFromExample = vi.fn();
const addRecentDir = vi.fn();
const openSolution = vi.fn();
const openExternal = vi.fn();

function manifest(overrides: Partial<ExampleManifest>): ExampleManifest {
  return {
    id: 'example',
    title: 'Example',
    category: '优化类',
    source: 'ModelForge 原创',
    license: { type: 'CC BY 4.0', redistributable: true, note: '可自由使用与再分发，需署名' },
    problemFile: 'problem.md',
    attachments: ['data.csv'],
    solution: [{ question: '问题一', file: 'solution/q1.md' }],
    ...overrides,
  };
}

const ORIGINAL: ExampleEntry = {
  manifest: manifest({ id: 'bike-demand', title: '共享单车需求预测', category: '预测/统计类' }),
  needsDownload: false,
};
const EVALUATION: ExampleEntry = {
  manifest: manifest({ id: 'campus-eval', title: '校园食堂综合评价', category: '综合评价类' }),
  needsDownload: false,
};
const OFFICIAL_URL = 'https://www.mcm.edu.cn/html_cn/node/example.html';
const REAL: ExampleEntry = {
  manifest: manifest({
    id: 'cumcm-2023-a',
    title: '2023 国赛 A 题 定日镜场的优化设计',
    category: '优化类',
    source: '全国大学生数学建模竞赛',
    license: { type: '版权归主办方所有', redistributable: false, note: '不随安装包分发' },
    officialUrl: OFFICIAL_URL,
  }),
  needsDownload: true,
};
const ENTRIES = [ORIGINAL, EVALUATION, REAL];

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderView(state?: { exampleId: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: '/examples', state }]}>
      <IntlTestWrapper>
        <Routes>
          <Route path="/examples" element={<ExamplesView />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </IntlTestWrapper>
    </MemoryRouter>
  );
}

const entryButton = (entry: ExampleEntry) =>
  screen.getByRole('button', { name: (name) => name.startsWith(entry.manifest.title) });

/** The detail fields (category, source, license) of the selected example. */
function detailFields(): HTMLElement {
  return screen.getByText('Category:').closest('dl') as HTMLElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  examplesList.mockResolvedValue(ENTRIES);
  directoryChooser.mockResolvedValue({ canceled: false, filePaths: ['/parent'] });
  addRecentDir.mockResolvedValue(undefined);
  openExternal.mockResolvedValue({ ok: true });
  window.electron = {
    ...originalElectron,
    examplesList,
    directoryChooser,
    projectCreateFromExample: createFromExample,
    addRecentDir,
    exampleOpenSolution: openSolution,
    openExternal,
  };
});

afterEach(() => {
  window.electron = originalElectron;
});

describe('ExamplesView list (requirement 9.2)', () => {
  it('lists every example with its title and category and marks the ones to download', async () => {
    renderView();

    await screen.findByRole('heading', { name: ORIGINAL.manifest.title });
    for (const entry of ENTRIES) {
      const button = entryButton(entry);
      expect(button).toHaveTextContent(entry.manifest.title);
      expect(button).toHaveTextContent(entry.manifest.category);
    }
    expect(entryButton(REAL)).toHaveTextContent('Download required');
    expect(entryButton(ORIGINAL)).not.toHaveTextContent('Download required');
  });

  it('shows the category, source and license type of each example', async () => {
    renderView();
    await screen.findByRole('heading', { name: ORIGINAL.manifest.title });

    for (const entry of ENTRIES) {
      fireEvent.click(entryButton(entry));

      expect(screen.getByRole('heading', { name: entry.manifest.title })).toBeVisible();
      const fields = within(detailFields());
      expect(fields.getByText(entry.manifest.category)).toBeVisible();
      expect(fields.getByText(entry.manifest.source)).toBeVisible();
      expect(fields.getByText(entry.manifest.license.type)).toBeVisible();
      expect(screen.getByText(entry.manifest.license.note)).toBeVisible();
    }
  });

  it('shows an empty state when no example is complete', async () => {
    examplesList.mockResolvedValue([]);
    renderView();

    expect(await screen.findByText('No examples available')).toBeVisible();
    expect(screen.queryByText('Category:')).not.toBeInTheDocument();
  });

  it('selects the example a home card asked for', async () => {
    renderView({ exampleId: REAL.manifest.id });

    expect(await screen.findByRole('heading', { name: REAL.manifest.title })).toBeVisible();
  });
});

describe('ExamplesView problems that are not shipped (requirement 9.6)', () => {
  it('shows the official source and download hint instead of creating a project', async () => {
    renderView({ exampleId: REAL.manifest.id });
    await screen.findByRole('heading', { name: REAL.manifest.title });

    expect(screen.getByText('Official source')).toBeVisible();
    expect(
      screen.getByText('Download the statement and attachments to get started')
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Create and open' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: OFFICIAL_URL }));
    expect(openExternal).toHaveBeenCalledWith(OFFICIAL_URL);
  });
});

describe('ExamplesView creating a project (requirement 9.3, 9.5)', () => {
  it('keeps the location after a failure and opens the created project', async () => {
    createFromExample
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'ENOSPC', message: 'Not enough disk space' },
      })
      .mockResolvedValueOnce({ ok: true, data: { projectDir: '/parent/共享单车需求预测' } });
    renderView();
    await screen.findByRole('heading', { name: ORIGINAL.manifest.title });

    const createButton = () => screen.getByRole('button', { name: 'Create and open' });
    expect(createButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }));
    expect(await screen.findByText('/parent')).toBeVisible();
    expect(createButton()).toBeEnabled();

    fireEvent.click(createButton());

    expect(await screen.findByText('Not enough disk space')).toBeVisible();
    expect(createFromExample).toHaveBeenCalledWith({
      exampleId: ORIGINAL.manifest.id,
      name: ORIGINAL.manifest.title,
      parentDir: '/parent',
    });
    expect(screen.getByText('/parent')).toBeVisible();
    expect(mocks.openProject).not.toHaveBeenCalled();

    fireEvent.click(createButton());

    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/$/);
    expect(addRecentDir).toHaveBeenCalledWith('/parent/共享单车需求预测');
    expect(mocks.openProject).toHaveBeenCalledWith('/parent/共享单车需求预测');
  });

  it('shows the reference approach by sub-question', async () => {
    openSolution.mockResolvedValue({
      ok: true,
      data: {
        sections: [
          { question: '问题一', content: '先做描述统计。' },
          { question: '问题二', content: '再建立回归模型。' },
        ],
      },
    });
    renderView();
    await screen.findByRole('heading', { name: ORIGINAL.manifest.title });

    fireEvent.click(screen.getByRole('button', { name: 'Reference approach' }));

    expect(await screen.findByRole('heading', { name: '问题一' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '问题二' })).toBeVisible();
    expect(screen.getByText('再建立回归模型。')).toBeVisible();
    expect(openSolution).toHaveBeenCalledWith(ORIGINAL.manifest.id);
  });
});

import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPETITION_CATALOG } from '../../catalog/competitionRules';
import { IntlTestWrapper } from '../../i18n/test-utils';
import CompetitionsView from './CompetitionsView';

const mocks = vi.hoisted(() => ({ openProject: vi.fn() }));
vi.mock('../../utils/pendingProject', () => ({ requestOpenProject: mocks.openProject }));

const originalElectron = window.electron;
const openExternal = vi.fn();
const directoryChooser = vi.fn();
const createFromTemplate = vi.fn();
const addRecentDir = vi.fn();

const NAMES = COMPETITION_CATALOG.competitions.map((competition) => competition.name);
const CUMCM = '全国大学生数学建模竞赛';
const MCM = '美国大学生数学建模竞赛（MCM/ICM）';

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>;
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/competitions']}>
      <IntlTestWrapper>
        <Routes>
          <Route path="/competitions" element={<CompetitionsView />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </IntlTestWrapper>
    </MemoryRouter>
  );
}

/** Competition names in list order; list entries are the buttons that start with a name. */
function listedNames(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .map((text) => NAMES.find((name) => text.startsWith(name)))
    .filter((name): name is string => name !== undefined);
}

const keywordInput = () => screen.getByPlaceholderText('Search by name');
const statusButton = (label: string) => screen.getByRole('button', { name: label });

beforeEach(() => {
  vi.clearAllMocks();
  // Only the clock is fake, so statuses are fixed while React and the queries use real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 8, 5, 12, 0, 0));
  directoryChooser.mockResolvedValue({ canceled: false, filePaths: ['/parent'] });
  addRecentDir.mockResolvedValue(undefined);
  openExternal.mockResolvedValue({ ok: true });
  window.electron = {
    ...originalElectron,
    openExternal,
    directoryChooser,
    projectCreateFromTemplate: createFromTemplate,
    addRecentDir,
  };
});

afterEach(() => {
  vi.useRealTimers();
  window.electron = originalElectron;
});

describe('CompetitionsView list', () => {
  it('lists all eight competitions with the running one first and the data date', () => {
    renderView();

    expect(screen.getByText(`Data updated：${COMPETITION_CATALOG.updatedAt}`)).toBeVisible();
    const names = listedNames();
    expect(names).toHaveLength(8);
    expect(new Set(names)).toEqual(new Set(NAMES));
    expect(names[0]).toBe(CUMCM);
    expect(screen.getByRole('button', { name: new RegExp(`^${CUMCM}`) })).toHaveTextContent(
      'Running'
    );
  });
});

describe('CompetitionsView filters (requirement 8.6, 8.7)', () => {
  it('combines status and keyword, then clears both from the empty state', () => {
    renderView();

    fireEvent.click(statusButton('Running'));
    expect(listedNames()).toEqual([CUMCM]);

    fireEvent.click(statusButton('Ended'));
    expect(listedNames()).toEqual([CUMCM, '华数杯', 'MathorCup', MCM, '统计建模大赛']);

    fireEvent.change(keywordInput(), { target: { value: 'mcm' } });
    expect(listedNames()).toEqual([MCM]);

    fireEvent.change(keywordInput(), { target: { value: 'no such contest' } });
    expect(listedNames()).toEqual([]);
    expect(screen.getByText('No competitions match your filter')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(listedNames()).toHaveLength(8);
    expect(keywordInput()).toHaveValue('');
    expect(screen.queryByText('No competitions match your filter')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
  });

  it('matches the keyword as a case-insensitive substring of the name', () => {
    renderView();

    fireEvent.change(keywordInput(), { target: { value: 'MCM' } });
    expect(listedNames()).toEqual(['APMCM 亚太赛', MCM]);

    fireEvent.change(keywordInput(), { target: { value: 'mathor' } });
    expect(listedNames()).toEqual(['MathorCup']);
    expect(keywordInput()).toHaveAttribute('maxlength', '50');
  });

  it('shows the not-started group when that status is chosen', () => {
    renderView();

    fireEvent.click(statusButton('Not started'));

    // Contest dates not announced count as not started and sort after the dated one.
    expect(listedNames()).toEqual(['APMCM 亚太赛', '电工杯', '深圳杯']);
  });
});

describe('CompetitionsView details', () => {
  it('falls back to the generic template and shows unannounced data (requirement 8.2, 8.9)', () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /^深圳杯/ }));

    expect(screen.getByRole('heading', { name: '深圳杯' })).toBeVisible();
    expect(screen.getByText('No matching template')).toBeVisible();
    expect(screen.getByText('No examples yet')).toBeVisible();
    expect(screen.getByText('Generic paper template')).toBeVisible();
    const website = screen.getByText('Website:').closest('div') as HTMLElement;
    expect(within(website).getByText('To be announced')).toBeVisible();
    expect(within(website).queryByRole('button')).not.toBeInTheDocument();
  });

  it('opens the official site and links the examples', async () => {
    renderView();

    fireEvent.click(screen.getByRole('button', { name: /https:\/\/www\.mcm\.edu\.cn\// }));
    expect(openExternal).toHaveBeenCalledWith('https://www.mcm.edu.cn/');
    expect(screen.getByText('cumcm、cumcm-latex、cumcm-typst')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'cumcm-2023-a' }));
    expect(await screen.findByTestId('location')).toHaveTextContent('/examples');
  });
});

describe('CompetitionsView start preparing (requirement 8.3, 8.8)', () => {
  it('keeps the input after a failure and opens the created project', async () => {
    createFromTemplate
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'PROJECT_EXISTS', message: 'A project with this name already exists' },
      })
      .mockResolvedValueOnce({ ok: true, data: { projectDir: '/parent/国赛备赛' } });
    renderView();

    fireEvent.click(screen.getByRole('button', { name: 'Start preparing' }));
    const createButton = () => screen.getByRole('button', { name: 'Create project' });
    expect(createButton()).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Project name'), { target: { value: '国赛备赛' } });
    fireEvent.click(screen.getByRole('button', { name: 'Choose save location' }));
    expect(await screen.findByText('/parent')).toBeVisible();
    expect(createButton()).toBeEnabled();

    fireEvent.click(createButton());

    expect(await screen.findByText('A project with this name already exists')).toBeVisible();
    expect(createFromTemplate).toHaveBeenCalledWith({
      competitionId: 'cumcm',
      name: '国赛备赛',
      parentDir: '/parent',
    });
    expect(screen.getByLabelText('Project name')).toHaveValue('国赛备赛');
    expect(screen.getByText('/parent')).toBeVisible();
    expect(mocks.openProject).not.toHaveBeenCalled();

    fireEvent.click(createButton());

    expect(await screen.findByTestId('location')).toHaveTextContent(/^\/$/);
    expect(addRecentDir).toHaveBeenCalledWith('/parent/国赛备赛');
    expect(mocks.openProject).toHaveBeenCalledWith('/parent/国赛备赛');
  });
});

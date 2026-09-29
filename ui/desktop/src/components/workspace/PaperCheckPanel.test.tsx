import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { PaperCheckReport } from '../../types/paperCheckApi';
import type { ProjectArtifact, ProjectSnapshot } from '../../types/workspaceApi';
import PaperCheckPanel from './PaperCheckPanel';

function artifact(relativePath: string, stage: ProjectArtifact['stage']): ProjectArtifact {
  return {
    name: relativePath.slice(relativePath.lastIndexOf('/') + 1),
    path: `/project/${relativePath}`,
    relativePath,
    stage,
    isDirectory: false,
    size: 1,
    modifiedAt: 1,
  };
}

const snapshot: ProjectSnapshot = {
  root: '/project',
  scannedAt: 0,
  artifacts: [
    artifact('notes.md', 'paper'),
    artifact('paper/main.tex', 'paper'),
    artifact('paper/refs.bib', 'paper'),
    artifact('data.csv', 'inputs'),
  ],
  limited: false,
  unreadableDirectories: 0,
};

const report: PaperCheckReport = {
  items: [
    {
      id: 'question-coverage',
      verdict: '发现问题',
      issues: [
        {
          code: 'question-uncovered',
          params: { number: 3 },
          message: '题面中的问题 3 在论文中没有出现',
          file: '题目/problem.md',
          line: 7,
        },
      ],
    },
    { id: 'number-consistency', verdict: '通过', issues: [] },
    {
      id: 'figure-labels',
      verdict: '发现问题',
      issues: [
        {
          code: 'figure-missing',
          params: { missing: 'x-label,y-unit' },
          message: '',
          file: 'paper/fig/a.svg',
        },
      ],
    },
    { id: 'references', verdict: '无法执行', issues: [], reason: 'offline' },
    {
      id: 'pdf-freshness',
      verdict: '发现问题',
      issues: [{ code: 'pdf-missing', params: { pdf: 'paper/main.pdf' }, message: '' }],
    },
    {
      id: 'anonymity',
      verdict: '发现问题',
      issues: [
        {
          code: 'anonymity-hit',
          params: { term: '某某大学', field: 'school' },
          message: '',
          file: 'paper/main.pdf',
          page: 2,
        },
      ],
    },
  ],
  finishedAt: '2026-09-29T08:00:00.000Z',
};

const electron = {
  workspaceScanProject: vi.fn(),
  paperCheckRun: vi.fn(),
};

const onOpenFile = vi.fn();

function panel() {
  return (
    <IntlTestWrapper>
      <PaperCheckPanel
        workingDir="/project"
        active
        isAgentActive={false}
        onOpenFile={onOpenFile}
        onCompose={vi.fn()}
      />
    </IntlTestWrapper>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  electron.workspaceScanProject.mockResolvedValue(snapshot);
  electron.paperCheckRun.mockResolvedValue({ ok: true, data: report });
  (window as unknown as { electron: unknown }).electron = electron;
});

describe('PaperCheckPanel', () => {
  it('offers the paper sources, main file first, and runs the check on the chosen one', async () => {
    render(panel());

    const select = await screen.findByRole('combobox', { name: 'Paper source' });
    await waitFor(() => expect(select).toHaveValue('paper/main.tex'));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'paper/main.tex',
      'notes.md',
    ]);

    fireEvent.change(screen.getByRole('textbox', { name: 'School' }), {
      target: { value: '某某大学' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));

    await waitFor(() =>
      expect(electron.paperCheckRun).toHaveBeenCalledWith({
        projectDir: '/project',
        paperPath: 'paper/main.tex',
        online: false,
        anonymity: { names: [''], school: '某某大学', team: '' },
      })
    );
    expect(JSON.parse(window.localStorage.getItem('modelforge.paperCheck.profile') ?? '{}')).toMatchObject(
      { school: '某某大学', anonymous: true }
    );
  });

  it('sends online verification and leaves anonymity out when the rules do not ask for it', async () => {
    render(panel());
    await screen.findByRole('option', { name: 'paper/main.tex' });

    fireEvent.click(screen.getByRole('checkbox', { name: /Verify references online/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /requires anonymous papers/ }));
    expect(screen.queryByRole('textbox', { name: 'School' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));

    await waitFor(() =>
      expect(electron.paperCheckRun).toHaveBeenCalledWith({
        projectDir: '/project',
        paperPath: 'paper/main.tex',
        online: true,
      })
    );
    expect(window.localStorage.getItem('modelforge.paperCheck.online')).toBe('true');
  });

  it('shows every verdict with its issue count and opens issues at their location', async () => {
    render(panel());
    await screen.findByRole('option', { name: 'paper/main.tex' });
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));

    expect(await screen.findByText('Question 3 is never mentioned in the paper')).toBeInTheDocument();
    expect(screen.getByText('Numbers match results')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getAllByText('Issues found')).toHaveLength(4);
    expect(screen.getByText('Could not run')).toBeInTheDocument();
    expect(screen.getByText('Online verification is off.')).toBeInTheDocument();
    expect(screen.getByText('Missing x-axis label and y-axis unit')).toBeInTheDocument();
    expect(screen.getByText('PDF missing: paper/main.pdf')).toBeInTheDocument();
    expect(screen.getAllByText('1 issue')).toHaveLength(4);
    expect(screen.getAllByText('0 issues')).toHaveLength(2);

    fireEvent.click(screen.getByText('Question 3 is never mentioned in the paper'));
    expect(onOpenFile).toHaveBeenLastCalledWith(
      {
        name: 'problem.md',
        path: '/project/题目/problem.md',
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
      },
      { line: 7 }
    );

    expect(screen.getByText('paper/main.pdf, page 2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('School “某某大学” appears here'));
    expect(onOpenFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: '/project/paper/main.pdf' }),
      { page: 2 }
    );

    // An issue without a file is plain text, not a button.
    expect(screen.getByText('PDF missing: paper/main.pdf').closest('button')).toBeNull();
  });

  it('collapses a check and shows why the check itself failed', async () => {
    electron.paperCheckRun.mockResolvedValueOnce({
      ok: false,
      error: { code: 'OUTSIDE_PROJECT', message: 'The paper must be inside the project' },
    });
    render(panel());
    await screen.findByRole('option', { name: 'paper/main.tex' });
    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The check could not run: The paper must be inside the project folder.'
    );

    fireEvent.click(screen.getByRole('button', { name: 'Run check' }));
    const toggle = (await screen.findByText('Question coverage')).closest('button');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle as HTMLElement);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Question 3 is never mentioned in the paper')).not.toBeInTheDocument();
  });

  it('explains when the project has no paper source', async () => {
    electron.workspaceScanProject.mockResolvedValue({ ...snapshot, artifacts: [] });
    render(panel());

    expect(
      await screen.findByText('No LaTeX, Typst or Markdown paper source found in this project.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run check' })).toBeDisabled();
  });
});

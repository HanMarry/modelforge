import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { ProjectSnapshot } from '../../types/workspaceApi';
import ProjectPanel from './ProjectPanel';

const originalElectron = window.electron;
const scan = vi.fn();
const compose = vi.fn();
const openFile = vi.fn();
function snapshot(root: string, filename = 'source.csv'): ProjectSnapshot {
  return {
    root,
    scannedAt: 1,
    limited: false,
    unreadableDirectories: 0,
    artifacts: [
      {
        name: filename,
        relativePath: `data/${filename}`,
        path: `${root}/data/${filename}`,
        isDirectory: false,
        size: 12,
        modifiedAt: 1,
        stage: 'inputs',
      },
    ],
  };
}
const panel = (workingDir: string) => (
  <IntlTestWrapper>
    <ProjectPanel workingDir={workingDir} onCompose={compose} onOpenFile={openFile} />
  </IntlTestWrapper>
);

beforeEach(() => {
  vi.clearAllMocks();
  window.electron = { ...originalElectron, workspaceScanProject: scan };
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

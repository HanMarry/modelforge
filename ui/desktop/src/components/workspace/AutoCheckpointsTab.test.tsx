import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { AutoCheckpoint, AutoCheckpointResult } from '../../types/workspaceApi';
import AutoCheckpointsTab from './AutoCheckpointsTab';

const originalElectron = window.electron;
const list = vi.fn();
const diff = vi.fn();
const restore = vi.fn();

function checkpoint(overrides: Partial<AutoCheckpoint> = {}): AutoCheckpoint {
  return {
    id: 'abc123',
    shortId: 'abc1234',
    createdAt: new Date('2026-01-02T03:04:05Z').getTime(),
    sessionId: 's1',
    turn: 1,
    kind: 'auto',
    filesChanged: 2,
    ...overrides,
  };
}

function ok<T>(value: T): AutoCheckpointResult<T> {
  return { ok: true, value };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.electron = { ...originalElectron, checkpointList: list, checkpointDiff: diff, checkpointRestore: restore };
});

afterEach(() => {
  window.electron = originalElectron;
});

const tab = (isAgentActive = false) => (
  <IntlTestWrapper>
    <AutoCheckpointsTab workingDir="/project" isAgentActive={isAgentActive} />
  </IntlTestWrapper>
);

describe('AutoCheckpointsTab', () => {
  it('disables restore while the agent is running', async () => {
    list.mockResolvedValue(ok([checkpoint()]));
    render(tab(true));
    await screen.findByText('abc1234');

    const restoreButton = screen.getByRole('button', { name: 'Restore to here' });
    expect(restoreButton).toBeDisabled();
    fireEvent.click(restoreButton);
    expect(diff).not.toHaveBeenCalled();
  });

  it('shows the created time and changed file count in the confirm dialog', async () => {
    list.mockResolvedValue(ok([checkpoint()]));
    diff.mockResolvedValue(
      ok({ files: [{ status: 'M', path: 'paper.md', binary: false }], textByPath: {} })
    );
    render(tab(false));
    await screen.findByText('abc1234');

    fireEvent.click(screen.getByRole('button', { name: 'Restore to here' }));
    await waitFor(() => expect(diff).toHaveBeenCalledWith('/project', 'abc123', 'worktree'));

    expect(await screen.findByText('Restore this snapshot?')).toBeVisible();
    expect(screen.getByText(/1 files will change/)).toBeVisible();
    expect(screen.getByText(/2026-01-02/)).toBeVisible();
  });
});

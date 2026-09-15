import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WorkspaceFilesPanel from './WorkspaceFilesPanel';
import { IntlTestWrapper } from '../../i18n/test-utils';

vi.mock('./preview/FilePreview', () => ({ default: () => <div>File content preview</div> }));
const original = window.electron;
const read = vi.fn();
const write = vi.fn();
const entry = {
  name: 'large.csv',
  path: '/project/large.csv',
  size: 3000000,
  modifiedAt: 1,
  isDirectory: false,
};
beforeEach(() => {
  read.mockReset();
  write.mockReset();
  window.electron = {
    ...original,
    workspaceListDirectory: vi.fn().mockResolvedValue([entry]),
    workspaceReadFile: read,
    workspaceWriteFile: write,
  };
});
afterEach(() => {
  window.electron = original;
});

it('does not allow a truncated preview to overwrite the complete file', async () => {
  read.mockResolvedValue({
    path: entry.path,
    content: 'partial contents',
    size: entry.size,
    truncated: true,
    binary: false,
    error: null,
  });
  render(
    <IntlTestWrapper>
      <WorkspaceFilesPanel workingDir="/project" isWide />
    </IntlTestWrapper>
  );
  fireEvent.click(await screen.findByRole('button', { name: /large.csv/ }));
  expect(await screen.findByText(/Large file preview is read-only/)).toBeVisible();
  expect(screen.queryByTitle('Edit')).not.toBeInTheDocument();
  expect(write).not.toHaveBeenCalled();
});

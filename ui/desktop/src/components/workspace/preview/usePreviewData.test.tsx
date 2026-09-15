import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { usePreviewData } from './usePreviewData';
import type { WorkspaceEntry } from '../../../types/workspaceApi';

const original = window.electron;
const read = vi.fn();
const entry: WorkspaceEntry = {
  name: 'data.csv',
  path: '/project/data.csv',
  size: 10,
  modifiedAt: 1,
  isDirectory: false,
};
const contents = {
  path: entry.path,
  content: 'a,b\n1,2',
  size: 10,
  truncated: false,
  binary: false,
  error: null,
};
beforeEach(() => {
  read.mockReset();
  window.electron = { ...original, workspaceReadFile: read };
});
afterEach(() => {
  window.electron = original;
});

it('keeps read errors visible and retries instead of showing an empty table', async () => {
  read.mockRejectedValueOnce(new Error('Access denied')).mockResolvedValueOnce(contents);
  const { result } = renderHook(() => usePreviewData(entry));
  await waitFor(() => expect(result.current.bytes?.error).toBe('Access denied'));
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.text?.content).toBe(contents.content));
  expect(result.current.bytes).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
});

it('clears old content immediately when selecting a different file', async () => {
  read.mockResolvedValueOnce(contents).mockImplementationOnce(() => new Promise(() => {}));
  const { result, rerender } = renderHook(({ file }) => usePreviewData(file), {
    initialProps: { file: entry },
  });
  await waitFor(() => expect(result.current.text?.content).toBe(contents.content));
  rerender({ file: { ...entry, path: '/project/other.csv', name: 'other.csv' } });
  expect(result.current.text).toBeNull();
  expect(result.current.loading).toBe(true);
});

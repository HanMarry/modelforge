import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmOverwriteRequest_unstable,
  ConfirmOverwriteResponse_unstable,
} from '@aaif/goose-acp-client';
import {
  cancelOverwrite,
  requestAcpOverwriteConfirm,
  setOverwriteConfirmHandler,
  type OverwriteConfirmHandler,
} from '../overwriteConfirm';

const request: ConfirmOverwriteRequest_unstable = {
  sessionId: 'session-1',
  taskId: 'task-1',
  stepId: 'fit',
  workingDir: '/projects/q1',
  files: [{ path: 'results/out.csv', size: 2048, modifiedAt: '2026-09-20T10:15:30.123+08:00' }],
};

const confirming: OverwriteConfirmHandler = async () => ({ action: 'confirm' });

describe('confirm-overwrite requests', () => {
  const restorers: Array<() => void> = [];

  afterEach(() => {
    restorers.splice(0).reverse().forEach((restore) => restore());
    vi.restoreAllMocks();
  });

  it('keeps the files until a handler is installed', async () => {
    await expect(requestAcpOverwriteConfirm(request)).resolves.toEqual({ action: 'cancel' });
    await expect(cancelOverwrite(request)).resolves.toEqual({ action: 'cancel' });
  });

  it('asks the installed handler and puts the previous one back', async () => {
    const handler = vi.fn(confirming);
    const restore = setOverwriteConfirmHandler(handler);

    await expect(requestAcpOverwriteConfirm(request)).resolves.toEqual({ action: 'confirm' });
    expect(handler).toHaveBeenCalledExactlyOnceWith(request);

    restore();
    await expect(requestAcpOverwriteConfirm(request)).resolves.toEqual({ action: 'cancel' });
  });

  it('does not let a stale restore remove a newer handler', async () => {
    const first: OverwriteConfirmHandler = async () => ({ action: 'cancel' });
    const restoreFirst = setOverwriteConfirmHandler(first);
    restorers.push(restoreFirst, setOverwriteConfirmHandler(confirming));

    restoreFirst();

    await expect(requestAcpOverwriteConfirm(request)).resolves.toEqual({ action: 'confirm' });
  });

  it('cancels when the handler fails or answers something else', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const failing: OverwriteConfirmHandler = async () => {
      throw new Error('dialog closed');
    };
    restorers.push(setOverwriteConfirmHandler(failing));
    await expect(requestAcpOverwriteConfirm(request)).resolves.toEqual({ action: 'cancel' });
    expect(consoleError).toHaveBeenCalledOnce();

    const unknownAction = { action: 'overwrite' } as unknown as ConfirmOverwriteResponse_unstable;
    restorers.push(setOverwriteConfirmHandler(async () => unknownAction));
    await expect(requestAcpOverwriteConfirm(request)).resolves.toEqual({ action: 'cancel' });
  });
});

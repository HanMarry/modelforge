/**
 * Entry point for the paper-check `utilityProcess` (requirement 18, task 23.8), built by
 * `forge.config.ts` as `.vite/build/paperCheckRunnerMain.js`. C0 skeleton: answers every request
 * with `NOT_IMPLEMENTED`; `mp/s2-c1-paper` replaces the body. Kept free of Electron imports like
 * `datasetParserMain.ts`; `process.parentPort` is injected by Electron.
 */
import type { IpcResult } from './utils/ipcResult';
import type { PaperCheckReport } from './types/paperCheckApi';

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  parentPort.on('message', () => {
    const response: IpcResult<PaperCheckReport> = {
      ok: false,
      error: { code: 'NOT_IMPLEMENTED', message: 'paper check runner is not implemented yet' },
    };
    parentPort.postMessage(response);
  });
}

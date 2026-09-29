/**
 * Entry point for the paper-check `utilityProcess` (requirement 18, task 23.8), built by
 * `forge.config.ts` as `.vite/build/paperCheckRunnerMain.js`. The main process sends one
 * `PaperCheckRunMessage` (root already resolved and checked) and gets one
 * `IpcResult<PaperCheckReport>` back. Everything is read through the read-only project reader;
 * Crossref lookups run here, bounded by `REFERENCE_TIMEOUT_MS` each.
 *
 * Kept free of Electron imports like `datasetParserMain.ts`; `process.parentPort` is injected
 * by Electron.
 */
import type { PaperCheckReport } from './types/paperCheckApi';
import { describeError, type IpcResult } from './utils/ipcResult';
import { runPaperCheck, type PaperCheckRunMessage } from './utils/paperCheck/paperCheckRunner';
import { extractPdfText } from './utils/paperCheck/pdfText';
import { createProjectReader } from './utils/paperCheck/projectReader';
import { REFERENCE_TIMEOUT_MS, type FetchLike } from './utils/paperCheck/references';

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

const crossrefFetch: FetchLike = (url, init) => fetch(url, init);

async function check(message: PaperCheckRunMessage): Promise<IpcResult<PaperCheckReport>> {
  try {
    const reader = await createProjectReader(message.root);
    const report = await runPaperCheck(
      { paperPath: message.paperPath, online: message.online, anonymity: message.anonymity },
      {
        reader,
        extractPdfText,
        crossref: message.online
          ? { fetch: crossrefFetch, timeoutMs: REFERENCE_TIMEOUT_MS }
          : undefined,
      }
    );
    return { ok: true, data: report };
  } catch (error) {
    return { ok: false, error: { code: 'CHECK_FAILED', message: describeError(error) } };
  }
}

if (parentPort) {
  parentPort.on('message', (event) => {
    void check(event.data as PaperCheckRunMessage).then((response) =>
      parentPort.postMessage(response)
    );
  });
}

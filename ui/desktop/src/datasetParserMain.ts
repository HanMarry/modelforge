/**
 * Entry point for the dataset-parsing `utilityProcess`. Receives a parse request from the
 * main process and posts a single result message back. Kept free of Electron imports so it
 * also type-checks under plain Node typings; `process.parentPort` is injected by Electron.
 */
import { parseDataFile } from './utils/datasets/datasetParser';
import type { DatasetParseError, DataPreview } from './types/datasets';

interface DatasetParseRequest {
  filePath: string;
  sheet?: string | number;
}

interface ParentPortLike {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

type DatasetParseResponse =
  | { ok: true; data: DataPreview }
  | { ok: false; error: DatasetParseError };

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

if (parentPort) {
  parentPort.on('message', (event) => {
    const request = event.data as DatasetParseRequest;
    parseDataFile(request.filePath, { sheet: request.sheet })
      .then((preview) => {
        const response: DatasetParseResponse = { ok: true, data: preview };
        parentPort.postMessage(response);
      })
      .catch((error: unknown) => {
        const response: DatasetParseResponse = {
          ok: false,
          error: {
            code: 'PARSE_FAILED',
            message: error instanceof Error ? error.message : String(error),
          },
        };
        parentPort.postMessage(response);
      });
  });
}

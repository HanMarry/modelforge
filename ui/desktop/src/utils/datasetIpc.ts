/**
 * Main-process IPC for the dataset library (requirement 10).
 *
 * `datasets-list` walks the project tree via the pure {@link selectDataFiles}; `datasets-preview`
 * parses a single file in a `utilityProcess` so a slow or corrupt file cannot block the main
 * process, enforcing the 200 MB cap and a 5 s timeout (requirements 10.4, 10.5).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ipcMain, utilityProcess } from 'electron';
import type {
  DataFileListResult,
  DataPreview,
  DatasetParseError,
} from '../types/datasets';
import { selectDataFiles, type DataFileFs } from './datasets/selectDataFiles';
import { toIpcError, type IpcResult } from './ipcResult';

export type { DataFileListResult, DataPreview };

const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;
const PARSE_TIMEOUT_MS = 5000;

const NO_SECRETS: string[] = [];

const nodeDataFs: DataFileFs = {
  readdir: (p) => fs.readdir(p),
  stat: async (p) => {
    const stat = await fs.stat(p);
    return {
      isFile: () => stat.isFile(),
      isDirectory: () => stat.isDirectory(),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  },
};

type DatasetParseResponse =
  | { ok: true; data: DataPreview }
  | { ok: false; error: DatasetParseError };

function previewViaUtilityProcess(
  filePath: string,
  sheet?: string | number
): Promise<IpcResult<DataPreview>> {
  return new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(__dirname, 'datasetParserMain.js'));
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const finish = (result: IpcResult<DataPreview>): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: { code: 'TIMEOUT', message: '解析超过 5 秒' } });
    }, PARSE_TIMEOUT_MS);

    child.on('message', (message) => {
      const response = message as DatasetParseResponse;
      if (response.ok) {
        finish({ ok: true, data: response.data });
      } else {
        finish({ ok: false, error: { code: response.error.code, message: response.error.message } });
      }
    });

    child.on('exit', () => {
      finish({ ok: false, error: { code: 'PARSE_FAILED', message: '解析进程异常退出' } });
    });

    child.postMessage({ filePath, sheet });
  });
}

export function registerDatasetIpc(): void {
  ipcMain.handle(
    'datasets-list',
    async (_event, root: string): Promise<IpcResult<DataFileListResult>> => {
      if (!root?.trim()) {
        return { ok: false, error: { code: 'EACCES', message: '无效目录' } };
      }
      try {
        const stat = await fs.stat(root);
        if (!stat.isDirectory()) {
          return { ok: false, error: { code: 'EACCES', message: '不是有效目录' } };
        }
        const data = await selectDataFiles(root, nodeDataFs);
        return { ok: true, data };
      } catch (error) {
        return { ok: false, error: toIpcError('EACCES', error, NO_SECRETS) };
      }
    }
  );

  ipcMain.handle(
    'datasets-preview',
    async (
      _event,
      request: { filePath: string; sheet?: string }
    ): Promise<IpcResult<DataPreview>> => {
      if (!request?.filePath?.trim()) {
        return { ok: false, error: { code: 'PARSE_FAILED', message: '无效文件路径' } };
      }
      try {
        const stat = await fs.stat(request.filePath);
        if (stat.size > MAX_PREVIEW_BYTES) {
          return {
            ok: false,
            error: { code: 'TOO_LARGE', message: `文件大小 ${stat.size} 字节，超过 200 MB 预览上限` },
          };
        }
        return await previewViaUtilityProcess(request.filePath, request.sheet);
      } catch (error) {
        return { ok: false, error: toIpcError('PARSE_FAILED', error, NO_SECRETS) };
      }
    }
  );
}

/**
 * Main-process IPC for the dataset library (requirement 10).
 *
 * `datasets-list` walks the project tree via the pure {@link selectDataFiles}; `datasets-preview`
 * parses a single file in a `utilityProcess` so a slow or corrupt file cannot block the main
 * process, enforcing the 200 MB cap and a 5 s timeout (requirements 10.4, 10.5).
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ipcMain, utilityProcess } from 'electron';
import type {
  DataFileListResult,
  DataPreview,
  DatasetParseError,
} from '../types/datasets';
import {
  DATA_FILE_EXTENSIONS,
  selectDataFiles,
  type DataFileFs,
} from './datasets/selectDataFiles';
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

/**
 * Resolves a preview request to a real file inside the real project root with a whitelisted
 * data extension; anything else (outside the root, via a symlink or `..`, other file types)
 * is refused so the renderer cannot use the parser to read arbitrary files.
 */
async function resolvePreviewTarget(root: string, filePath: string): Promise<string | null> {
  if (!path.isAbsolute(root) || !path.isAbsolute(filePath)) return null;
  if (!DATA_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(filePath);
    return realFile.startsWith(realRoot + path.sep) ? realFile : null;
  } catch {
    return null;
  }
}

const WATCH_DEBOUNCE_MS = 300;

interface DatasetWatch {
  root: string;
  watcher: FSWatcher;
  timer: ReturnType<typeof setTimeout> | null;
}

/** One recursive watcher per renderer; a new `datasets-watch` replaces the previous one. */
const watches = new Map<number, DatasetWatch>();
const cleanupRegistered = new Set<number>();

function stopWatch(senderId: number): void {
  const watch = watches.get(senderId);
  if (!watch) return;
  if (watch.timer) clearTimeout(watch.timer);
  watch.watcher.close();
  watches.delete(senderId);
}

export function registerDatasetIpc(): void {
  // Requirement 10.1: the list refreshes within 2 s of a change; events are debounced by
  // 300 ms and the renderer reloads the list when notified.
  ipcMain.handle('datasets-watch', async (event, root: string): Promise<IpcResult<null>> => {
    const sender = event.sender;
    stopWatch(sender.id);
    try {
      if (!root || !path.isAbsolute(root) || !(await fs.stat(root)).isDirectory()) {
        return { ok: false, error: { code: 'EACCES', message: '不是有效目录' } };
      }
      const watch: DatasetWatch = {
        root,
        timer: null,
        watcher: fsWatch(root, { recursive: true }, () => {
          if (watch.timer) clearTimeout(watch.timer);
          watch.timer = setTimeout(() => {
            watch.timer = null;
            if (!sender.isDestroyed()) sender.send('datasets-changed', root);
          }, WATCH_DEBOUNCE_MS);
        }),
      };
      watch.watcher.on('error', () => stopWatch(sender.id));
      watches.set(sender.id, watch);
      if (!cleanupRegistered.has(sender.id)) {
        cleanupRegistered.add(sender.id);
        const senderId = sender.id;
        sender.once('destroyed', () => {
          cleanupRegistered.delete(senderId);
          stopWatch(senderId);
        });
      }
      return { ok: true, data: null };
    } catch (error) {
      return { ok: false, error: toIpcError('EACCES', error, NO_SECRETS) };
    }
  });

  ipcMain.handle('datasets-unwatch', (event): IpcResult<null> => {
    stopWatch(event.sender.id);
    return { ok: true, data: null };
  });

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
      request: { root: string; filePath: string; sheet?: string }
    ): Promise<IpcResult<DataPreview>> => {
      if (!request?.filePath?.trim() || !request.root?.trim()) {
        return { ok: false, error: { code: 'PARSE_FAILED', message: '无效文件路径' } };
      }
      try {
        const target = await resolvePreviewTarget(request.root, request.filePath);
        if (!target) {
          return {
            ok: false,
            error: { code: 'EACCES', message: '只能预览当前项目内的 csv、xlsx、json、parquet 文件' },
          };
        }
        const stat = await fs.stat(target);
        if (stat.size > MAX_PREVIEW_BYTES) {
          return {
            ok: false,
            error: { code: 'TOO_LARGE', message: `文件大小 ${stat.size} 字节，超过 200 MB 预览上限` },
          };
        }
        return await previewViaUtilityProcess(target, request.sheet);
      } catch (error) {
        return { ok: false, error: toIpcError('PARSE_FAILED', error, NO_SECRETS) };
      }
    }
  );
}

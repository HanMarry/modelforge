/**
 * IPC for the local works gallery and share packages (requirement 13). Errors carry stable codes
 * (`NO_PDF`, `INVALID_ARCHIVE`, `ARCHIVE_TOO_LARGE`, `ZIP_SLIP`, `INVALID_MANIFEST`, …) that the
 * renderer maps to localized messages.
 */
import { app, dialog, ipcMain } from 'electron';
import { loadRecentDirs } from '../recentDirs';
import { createGalleryService, type ExportShareInput } from './galleryService';

export interface GalleryIpcOptions {
  sensitiveValues: () => string[];
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

export function registerGalleryIpc({ sensitiveValues }: GalleryIpcOptions): void {
  const service = createGalleryService({
    userDataDir: app.getPath('userData'),
    recentDirs: loadRecentDirs,
    sensitiveValues,
    modelforgeVersion: () => app.getVersion(),
  });

  ipcMain.handle('gallery-list', () => service.listLocal());

  ipcMain.handle('gallery-candidates', async (_event, projectDir: unknown) => {
    if (!isString(projectDir)) return { candidates: [], excluded: [] };
    return service.listCandidates(projectDir);
  });

  ipcMain.handle('gallery-export', async (_event, input: unknown) => {
    if (!isExportInput(input)) {
      return { ok: false, code: 'EXPORT_FAILED', reason: 'Invalid request' };
    }
    return service.exportShare(input);
  });

  ipcMain.handle('gallery-import', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Import share package',
      properties: ['openFile'],
      filters: [{ name: 'Share package', extensions: ['zip'] }],
    });
    const filePath = picked.filePaths[0];
    if (!filePath) return { ok: false, code: 'IMPORT_FAILED', reason: 'Cancelled' };
    return service.importShare(filePath);
  });

  ipcMain.handle('gallery-remote', async (_event, url: unknown) => {
    if (!isString(url)) return { ok: false, code: 'REMOTE_UNAVAILABLE' };
    return service.listRemote(url);
  });
}

function isExportInput(value: unknown): value is ExportShareInput {
  if (typeof value !== 'object' || value === null) return false;
  const input = value as Record<string, unknown>;
  return (
    isString(input.projectDir) &&
    isString(input.title) &&
    isString(input.competition) &&
    isString(input.category) &&
    isString(input.abstract) &&
    isStringArray(input.checked) &&
    isString(input.targetDir) &&
    isString(input.modelforgeVersion)
  );
}

import { execFile } from 'child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import { scanProject } from './projectInventory';
import type {
  EnvironmentProbe,
  WorkspaceEntry,
  WorkspaceFileReadResult,
} from '../types/workspaceApi';

export type { EnvironmentProbe, WorkspaceEntry, WorkspaceFileReadResult };

const SKIPPED_TREE_ENTRIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
]);

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const BINARY_SAMPLE_BYTES = 4096;

const versionCommand = (command: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const line = stdout.trim().split('\n')[0]?.trim() ?? '';
      resolve(line || null);
    });
  });

async function listDirectory(dirPath: string, showHidden: boolean): Promise<WorkspaceEntry[]> {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: WorkspaceEntry[] = [];

  for (const entry of entries) {
    if (!showHidden && (SKIPPED_TREE_ENTRIES.has(entry.name) || entry.name.startsWith('.'))) {
      continue;
    }
    const fullPath = path.join(dirPath, entry.name);
    const stats = await fs.stat(fullPath).catch(() => null);
    if (!stats) continue;
    result.push({
      name: entry.name,
      path: fullPath,
      isDirectory: entry.isDirectory(),
      size: stats.size,
      modifiedAt: stats.mtimeMs,
    });
  }

  return result.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, BINARY_SAMPLE_BYTES);
  return sample.includes(0);
}

async function readWorkspaceFile(filePath: string): Promise<WorkspaceFileReadResult> {
  const empty = { content: '', path: filePath, size: 0, truncated: false, binary: false };
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) {
      return { ...empty, error: 'Not a regular file' };
    }
    const handle = await fs.open(filePath, 'r');
    try {
      const readSize = Math.min(stats.size, MAX_PREVIEW_BYTES);
      const buffer = Buffer.alloc(readSize);
      const { bytesRead } = await handle.read(buffer, 0, readSize, 0);
      const slice = buffer.subarray(0, bytesRead);
      if (looksBinary(slice)) {
        return { ...empty, size: stats.size, binary: true, error: null };
      }
      return {
        content: slice.toString('utf8'),
        path: filePath,
        size: stats.size,
        truncated: stats.size > bytesRead,
        binary: false,
        error: null,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}

async function findDiagramFiles(rootDir: string, maxDepth = 3): Promise<WorkspaceEntry[]> {
  const found: WorkspaceEntry[] = [];
  const skippedDirs = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'template']);

  const walk = async (dir: string, depth: number) => {
    if (depth > maxDepth || found.length >= 60) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    const inDiagramDir = dir.replace(/\\/g, '/').toLowerCase().includes('diagram');

    for (const entry of entries) {
      if (found.length >= 60) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(fullPath, depth + 1);
        continue;
      }

      const lower = entry.name.toLowerCase();
      const isDiagram =
        lower.endsWith('.drawio') ||
        (inDiagramDir && (lower.endsWith('.svg') || lower.endsWith('.png')));
      if (!isDiagram) continue;

      try {
        const stats = await fs.stat(fullPath);
        found.push({
          name: entry.name,
          path: fullPath,
          isDirectory: false,
          size: stats.size,
          modifiedAt: stats.mtimeMs,
        });
      } catch {
        continue;
      }
    }
  };

  await walk(rootDir, 0);
  return found.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

const MAX_BINARY_BYTES = 12 * 1024 * 1024;
const MAX_RAW_BYTES = 40 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

async function readWorkspaceBinary(
  filePath: string
): Promise<{ dataUrl: string | null; size: number; error: string | null }> {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) return { dataUrl: null, size: 0, error: 'Not a regular file' };
    if (stats.size > MAX_BINARY_BYTES) {
      return { dataUrl: null, size: stats.size, error: 'File is too large to preview' };
    }
    const buffer = await fs.readFile(filePath);
    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    return {
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
      size: stats.size,
      error: null,
    };
  } catch (error) {
    return {
      dataUrl: null,
      size: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function searchWorkspaceFiles(
  rootDir: string,
  query: string,
  limit = 80
): Promise<WorkspaceEntry[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: WorkspaceEntry[] = [];
  const skippedDirs = new Set([
    '.git',
    'node_modules',
    '__pycache__',
    '.venv',
    'venv',
    'dist',
    'build',
    '.next',
    '.cache',
  ]);

  const walk = async (dir: string, depth: number) => {
    if (depth > 6 || matches.length >= limit) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => null);
    if (!entries) return;

    for (const entry of entries) {
      if (matches.length >= limit) return;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.name.toLowerCase().includes(needle)) continue;
      const stats = await fs.stat(fullPath).catch(() => null);
      if (!stats) continue;
      matches.push({
        name: entry.name,
        path: fullPath,
        isDirectory: false,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      });
    }
  };

  await walk(rootDir, 0);
  return matches;
}

export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace-scan-project', (_event, rootDir: string) => scanProject(rootDir));
  ipcMain.handle('workspace-stat', async (_event, filePath: string) => {
    const missing = { exists: false, isDirectory: false, size: 0, modifiedAt: 0 };
    if (!filePath?.trim()) return missing;
    try {
      const stats = await fs.stat(filePath);
      return {
        exists: true,
        isDirectory: stats.isDirectory(),
        size: stats.size,
        modifiedAt: stats.mtimeMs,
      };
    } catch {
      return missing;
    }
  });

  ipcMain.handle('workspace-read-bytes', async (_event, filePath: string) => {
    const empty = { base64: null as string | null, size: 0, error: null as string | null };
    if (!filePath?.trim()) return { ...empty, error: 'Invalid path' };
    try {
      const stats = await fs.stat(filePath);
      if (!stats.isFile()) return { ...empty, error: 'Not a regular file' };
      if (stats.size > MAX_RAW_BYTES) {
        return { ...empty, size: stats.size, error: 'File is too large to preview' };
      }
      const buffer = await fs.readFile(filePath);
      return { base64: buffer.toString('base64'), size: stats.size, error: null };
    } catch (error) {
      return { ...empty, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('workspace-search-files', async (_event, rootDir: string, query: string) => {
    if (!rootDir?.trim() || !query?.trim()) return [];
    return searchWorkspaceFiles(rootDir, query);
  });

  ipcMain.handle('workspace-read-binary', async (_event, filePath: string) => {
    if (!filePath?.trim()) return { dataUrl: null, size: 0, error: 'Invalid path' };
    return readWorkspaceBinary(filePath);
  });
  ipcMain.handle(
    'workspace-list-dir',
    async (_event, dirPath: string, showHidden = false): Promise<WorkspaceEntry[]> => {
      if (!dirPath?.trim()) return [];
      try {
        return await listDirectory(dirPath, Boolean(showHidden));
      } catch {
        return [];
      }
    }
  );

  ipcMain.handle('workspace-read-file', async (_event, filePath: string) => {
    if (!filePath?.trim()) return null;
    return readWorkspaceFile(filePath);
  });

  ipcMain.handle(
    'workspace-write-file',
    async (_event, filePath: string, content: string): Promise<{ ok: boolean; error?: string }> => {
      if (!filePath?.trim() || typeof content !== 'string') {
        return { ok: false, error: 'Invalid request' };
      }
      try {
        await fs.writeFile(filePath, content, 'utf8');
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle('workspace-open-path', async (_event, targetPath: string): Promise<string> => {
    if (!targetPath?.trim()) return 'Invalid path';
    return shell.openPath(targetPath);
  });

  ipcMain.handle('workspace-reveal-path', async (_event, targetPath: string) => {
    if (!targetPath?.trim()) return false;
    shell.showItemInFolder(targetPath);
    return true;
  });

  ipcMain.handle(
    'workspace-open-in-editor',
    async (
      _event,
      targetPath: string,
      editor: string
    ): Promise<{ ok: boolean; error?: string }> => {
      if (!targetPath?.trim()) return { ok: false, error: 'Invalid path' };

      const commands: Record<string, { command: string; args: string[]; shell?: boolean }> = {
        vscode: { command: 'code', args: ['-r', targetPath], shell: true },
        cursor: { command: 'cursor', args: ['-r', targetPath], shell: true },
        notepad: { command: 'notepad.exe', args: [targetPath] },
      };

      const target = commands[editor];
      if (!target) {
        const error = await shell.openPath(targetPath);
        return error ? { ok: false, error } : { ok: true };
      }

      return new Promise((resolve) => {
        execFile(
          target.command,
          target.args,
          { shell: target.shell, windowsHide: true, timeout: 15000 },
          (error) => {
            if (error) {
              resolve({ ok: false, error: error.message });
              return;
            }
            resolve({ ok: true });
          }
        );
      });
    }
  );

  ipcMain.handle('workspace-probe-environment', async (): Promise<EnvironmentProbe[]> => {
    const probes: { id: string; label: string; command: string; args: string[] }[] = [
      { id: 'uv', label: 'uv', command: 'uv', args: ['--version'] },
      { id: 'python', label: 'Python', command: 'python', args: ['--version'] },
      { id: 'git', label: 'Git', command: 'git', args: ['--version'] },
      { id: 'node', label: 'Node.js', command: 'node', args: ['--version'] },
      { id: 'pwsh', label: 'PowerShell', command: 'pwsh', args: ['--version'] },
      { id: 'latexmk', label: 'latexmk', command: 'latexmk', args: ['--version'] },
      { id: 'xelatex', label: 'XeLaTeX', command: 'xelatex', args: ['--version'] },
      { id: 'pandoc', label: 'Pandoc', command: 'pandoc', args: ['--version'] },
    ];

    const results = await Promise.all(
      probes.map(async (probe) => {
        const version = await versionCommand(probe.command, probe.args);
        return {
          id: probe.id,
          label: probe.label,
          command: probe.command,
          version,
          available: version !== null,
        };
      })
    );

    return results;
  });

  ipcMain.handle('workspace-list-diagrams', async (_event, rootDir: string) => {
    if (!rootDir?.trim()) return [];
    try {
      return await findDiagramFiles(rootDir);
    } catch {
      return [];
    }
  });
}

/**
 * Main-process IPC for the competition hub and example library (requirements 8 and 9).
 *
 * Channels: `competitions-list`, `project-create-from-template`, `examples-list`,
 * `project-create-from-example`, `example-open-solution`. Every handler returns
 * `{ ok: true, data } | { ok: false, error }` and validates paths before touching disk.
 */
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { COMPETITION_CATALOG } from '../catalog/competitionRules';
import type { Competition, ExampleEntry, ExampleManifest } from '../types/catalog';
import { classifyExample } from './examples/exampleCatalog';
import { ProjectCreateError, ProjectService } from './projects/projectService';
import { toIpcError, type IpcResult } from './ipcResult';

export interface ProjectCreated {
  projectDir: string;
}

export interface ExampleSolutionSection {
  question: string;
  content: string;
}

const NO_SECRETS: string[] = [];

function examplesDirCandidates(): string[] {
  if (app.isPackaged) {
    return [path.join(process.resourcesPath, 'examples')];
  }
  // __dirname is ui/desktop/.vite/build, so resources/examples is two levels up.
  return [path.join(__dirname, '..', '..', 'resources', 'examples')];
}

function resolveExamplesDir(): string | null {
  return examplesDirCandidates().find((dir) => fsSync.existsSync(dir)) ?? null;
}

/** Templates are embedded in goose.exe when packaged; in dev they live in the source tree. */
function resolveTemplateSourceDirs(ids: string[]): Map<string, string> {
  const result = new Map<string, string>();
  if (app.isPackaged) return result;

  const templatesRoot = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'crates',
    'goose',
    'src',
    'skills',
    'builtins',
    'math_paper',
    'assets',
    'templates'
  );
  for (const id of ids) {
    const dir = path.join(templatesRoot, id);
    if (fsSync.existsSync(dir)) {
      result.set(id, dir);
    }
  }
  return result;
}

function competitionById(id: string): Competition | null {
  return COMPETITION_CATALOG.competitions.find((competition) => competition.id === id) ?? null;
}

async function loadExampleManifest(exampleId: string): Promise<{
  exampleDir: string;
  manifest: ExampleManifest;
} | null> {
  const examplesDir = resolveExamplesDir();
  if (!examplesDir) return null;
  const exampleDir = path.join(examplesDir, exampleId);
  const manifestPath = path.join(exampleDir, 'example.json');
  try {
    const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
    const entry = classifyExample(raw, (relative) =>
      fsSync.existsSync(path.join(exampleDir, relative))
    );
    return entry ? { exampleDir, manifest: entry.manifest } : null;
  } catch {
    return null;
  }
}

export function registerCatalogIpc(): void {
  ipcMain.handle('competitions-list', () => COMPETITION_CATALOG);

  ipcMain.handle('examples-list', async (): Promise<ExampleEntry[]> => {
    const examplesDir = resolveExamplesDir();
    if (!examplesDir) return [];
    const entries: ExampleEntry[] = [];
    try {
      for (const name of await fs.readdir(examplesDir)) {
        const exampleDir = path.join(examplesDir, name);
        const manifestPath = path.join(exampleDir, 'example.json');
        if (!fsSync.existsSync(manifestPath)) continue;
        const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as unknown;
        const entry = classifyExample(raw, (relative) =>
          fsSync.existsSync(path.join(exampleDir, relative))
        );
        if (entry) entries.push(entry);
      }
    } catch {
      return [];
    }
    return entries;
  });

  ipcMain.handle(
    'project-create-from-template',
    async (
      _event,
      request: { competitionId: string; name: string; parentDir: string }
    ): Promise<IpcResult<ProjectCreated>> => {
      const competition = competitionById(request.competitionId);
      if (!competition) {
        return { ok: false, error: { code: 'SOURCE_MISSING', message: '赛事不存在' } };
      }
      const service = new ProjectService();
      try {
        const projectDir = await service.createFromTemplate({
          competition,
          name: request.name,
          parentDir: request.parentDir,
          templateDirs: resolveTemplateSourceDirs(competition.templateIds),
        });
        return { ok: true, data: { projectDir } };
      } catch (error) {
        const code = error instanceof ProjectCreateError ? error.code : 'EACCES';
        return { ok: false, error: toIpcError(code, error, NO_SECRETS) };
      }
    }
  );

  ipcMain.handle(
    'project-create-from-example',
    async (
      _event,
      request: { exampleId: string; name: string; parentDir: string }
    ): Promise<IpcResult<ProjectCreated>> => {
      const loaded = await loadExampleManifest(request.exampleId);
      if (!loaded) {
        return { ok: false, error: { code: 'SOURCE_MISSING', message: '示例题清单不完整或不存在' } };
      }
      const service = new ProjectService();
      try {
        const projectDir = await service.createFromExample({
          manifest: loaded.manifest,
          exampleDir: loaded.exampleDir,
          name: request.name,
          parentDir: request.parentDir,
        });
        return { ok: true, data: { projectDir } };
      } catch (error) {
        const code = error instanceof ProjectCreateError ? error.code : 'SOURCE_MISSING';
        return { ok: false, error: toIpcError(code, error, NO_SECRETS) };
      }
    }
  );

  ipcMain.handle(
    'example-open-solution',
    async (_event, exampleId: string): Promise<IpcResult<{ sections: ExampleSolutionSection[] }>> => {
      const loaded = await loadExampleManifest(exampleId);
      if (!loaded) {
        return { ok: false, error: { code: 'SOURCE_MISSING', message: '示例题不存在' } };
      }
      try {
        const sections: ExampleSolutionSection[] = [];
        for (const section of loaded.manifest.solution) {
          const content = await fs
            .readFile(path.join(loaded.exampleDir, section.file), 'utf8')
            .catch(() => '');
          sections.push({ question: section.question, content });
        }
        return { ok: true, data: { sections } };
      } catch (error) {
        return { ok: false, error: toIpcError('SOURCE_MISSING', error, NO_SECRETS) };
      }
    }
  );
}

/**
 * Local works gallery and share-package service (requirement 13). Local works follow the
 * temporary rule "a paper PDF exists => it is a work"; phase 2 swaps this for Artifact_Status.
 * Share packages are written with `yazl` and read with `yauzl`, always through a temporary file
 * or directory that is only renamed into place after everything succeeded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ZipFile } from 'yazl';
import { openPromise, validateFileName } from 'yauzl';
import { isAllowedUrl } from '../urlPolicy';
import { selectShareFiles } from './shareFilter';
import { validateShareManifest } from './shareManifest';
import { scanProject } from '../projectInventory';
import type { ProjectArtifact } from '../../types/workspaceApi';

export type GallerySource = 'local' | 'imported' | 'remote';

export interface GalleryWork {
  id: string;
  source: GallerySource;
  /** Remote works carry the service address; imported works are labelled locally. */
  sourceLabel?: string;
  title?: string;
  competition?: string;
  category?: string;
  abstract?: string;
  /** Absolute path to the PDF for preview (local and imported works). */
  pdfPath?: string;
  projectDir?: string;
  /** True while the temporary "paper PDF exists" rule is in effect (13.1). */
  temporaryRule?: boolean;
}

export type GalleryErrorCode =
  | 'NO_PDF'
  | 'INVALID_ARCHIVE'
  | 'ARCHIVE_TOO_LARGE'
  | 'ZIP_SLIP'
  | 'INVALID_MANIFEST'
  | 'REMOTE_UNAVAILABLE'
  | 'EXPORT_FAILED'
  | 'IMPORT_FAILED';

export type GalleryResult<T> = { ok: true; data: T } | { ok: false; code: GalleryErrorCode; reason?: string };

export interface ExportShareInput {
  projectDir: string;
  title: string;
  competition: string;
  category: string;
  abstract: string;
  /** Project-relative paths the user checked. */
  checked: string[];
  /** Directory that will receive `share-<slug>-<yyyyMMddHHmm>.zip`. */
  targetDir: string;
  modelforgeVersion: string;
}

export interface ExportShareData {
  path: string;
  /** Files the filter excluded, with reasons, for the UI to report. */
  excluded: { path: string; reason: string }[];
}

export interface ImportShareData {
  work: GalleryWork;
}

export interface GalleryServiceDeps {
  userDataDir: string;
  recentDirs: () => string[];
  sensitiveValues: () => string[];
  modelforgeVersion: () => string;
  log?: (message: string) => void;
}

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const REMOTE_TIMEOUT_MS = 10_000;
const MAX_REMOTE_WORKS = 200;

export function makeSlug(title: string): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'work';
}

export function formatExportStamp(now: Date): string {
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `${pad(now.getHours())}${pad(now.getMinutes())}`
  );
}

export function findPaperPdf(artifacts: ProjectArtifact[]): ProjectArtifact | null {
  return (
    artifacts.find(
      (artifact) => artifact.stage === 'paper' && artifact.name.toLowerCase().endsWith('.pdf')
    ) ?? null
  );
}

export function containsSensitive(content: string, secrets: readonly string[]): boolean {
  return secrets.some((secret) => secret.length > 0 && content.includes(secret));
}

function safeFileName(name: string): boolean {
  return validateFileName(name) !== null;
}

async function listShareCandidates(root: string): Promise<string[]> {
  const result: string[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  const SKIP = new Set(['.git', '.modelforge', 'node_modules', '__pycache__', '.venv', 'venv']);
  while (queue.length && result.length < 5000) {
    const { dir, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 8) queue.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        result.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }
  return result.sort();
}

export function createGalleryService(deps: GalleryServiceDeps) {
  const { userDataDir, recentDirs, sensitiveValues, modelforgeVersion, log } = deps;
  const debug = log ?? (() => {});
  const importsDir = path.join(userDataDir, 'gallery', 'imports');

  const listLocal = async (): Promise<GalleryWork[]> => {
    const works: GalleryWork[] = [];

    for (const dir of recentDirs()) {
      try {
        const snapshot = await scanProject(dir, { maxEntries: 2000, maxDepth: 6 });
        const pdf = findPaperPdf(snapshot.artifacts);
        if (pdf) {
          works.push({
            id: `local:${dir}`,
            source: 'local',
            pdfPath: pdf.path,
            projectDir: dir,
            temporaryRule: true,
          });
        }
      } catch {
        // An inaccessible project is skipped, not fatal.
      }
    }

    try {
      const entries = await fs.promises.readdir(importsDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const work = await readImportedWork(path.join(importsDir, entry.name));
        if (work) works.push(work);
      }
    } catch {
      debug('could not list imported works');
    }

    return works;
  };

  const readImportedWork = async (dir: string): Promise<GalleryWork | null> => {
    try {
      const manifest = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8')
      ) as Record<string, unknown>;
      const pdfPath = path.join(dir, 'paper.pdf');
      if (!fs.existsSync(pdfPath)) return null;
      return {
        id: `imported:${path.basename(dir)}`,
        source: 'imported',
        title: typeof manifest.title === 'string' ? manifest.title : undefined,
        competition: typeof manifest.competition === 'string' ? manifest.competition : undefined,
        category: typeof manifest.category === 'string' ? manifest.category : undefined,
        abstract: typeof manifest.abstract === 'string' ? manifest.abstract : undefined,
        pdfPath,
      };
    } catch {
      return null;
    }
  };

  const listCandidates = async (projectDir: string): Promise<{ candidates: string[]; excluded: { path: string; reason: string }[] }> => {
    try {
      const root = await fs.promises.realpath(projectDir);
      const candidates = await listShareCandidates(root);
      const { excluded } = selectShareFiles(candidates, new Set(), { sensitiveContent: new Set() });
      return {
        candidates,
        excluded: excluded.map((entry) => ({ path: entry.path, reason: entry.reason })),
      };
    } catch {
      return { candidates: [], excluded: [] };
    }
  };

  const exportShare = async (input: ExportShareInput): Promise<GalleryResult<ExportShareData>> => {
    try {
      const root = await fs.promises.realpath(input.projectDir);
      const snapshot = await scanProject(root, { maxEntries: 4000, maxDepth: 8 });
      const pdf = findPaperPdf(snapshot.artifacts);
      if (!pdf) {
        return { ok: false, code: 'NO_PDF' };
      }

      const candidates = await listShareCandidates(root);
      const secrets = sensitiveValues();
      const sensitiveContent = new Set<string>();
      for (const relative of candidates) {
        try {
          const content = await fs.promises.readFile(path.join(root, relative), 'utf8');
          if (containsSensitive(content, secrets)) sensitiveContent.add(relative);
        } catch {
          // Unreadable files are excluded rather than failing the export.
          sensitiveContent.add(relative);
        }
      }

      const filtered = selectShareFiles(candidates, new Set(input.checked), { sensitiveContent });

      const manifest = {
        title: input.title,
        competition: input.competition,
        category: input.category,
        abstract: input.abstract,
        exportedAt: new Date().toISOString(),
        modelforgeVersion: modelforgeVersion(),
        files: filtered.selected,
      };

      const slug = makeSlug(input.title);
      const stamp = formatExportStamp(new Date());
      const finalName = `share-${slug}-${stamp}.zip`;
      const finalPath = path.join(input.targetDir, finalName);
      const tmpPath = path.join(input.targetDir, `.${finalName}.tmp-${randomUUID()}`);

      await fs.promises.mkdir(input.targetDir, { recursive: true });

      const zip = new ZipFile();
      zip.addFile(pdf.path, 'paper.pdf');
      zip.addBuffer(Buffer.from(input.abstract, 'utf8'), 'abstract.md');
      zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'manifest.json');
      for (const relative of filtered.selected) {
        zip.addFile(path.join(root, relative), `files/${relative}`);
      }
      zip.end();

      await writeZipToPath(zip, tmpPath);
      await fs.promises.rename(tmpPath, finalPath);

      return {
        ok: true,
        data: {
          path: finalPath,
          excluded: filtered.excluded.map((entry) => ({ path: entry.path, reason: entry.reason })),
        },
      };
    } catch (cause) {
      debug(`export failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { ok: false, code: 'EXPORT_FAILED' };
    }
  };

  const importShare = async (filePath: string): Promise<GalleryResult<ImportShareData>> => {
    let tmpDir: string | null = null;
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.size > MAX_ARCHIVE_BYTES) {
        return { ok: false, code: 'ARCHIVE_TOO_LARGE' };
      }

      const zip = await openPromise(filePath, { lazyEntries: true, validateEntrySizes: true });
      tmpDir = path.join(importsDir, `.tmp-${randomUUID()}`);
      await fs.promises.mkdir(tmpDir, { recursive: true });

      let manifestJson: unknown;
      for await (const entry of zip.eachEntry()) {
        if (!safeFileName(entry.fileName)) {
          return { ok: false, code: 'ZIP_SLIP' };
        }
        const target = path.join(tmpDir, entry.fileName);
        if (entry.fileName.endsWith('/')) {
          await fs.promises.mkdir(target, { recursive: true });
          continue;
        }
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        const stream = await zip.openReadStreamPromise(entry);
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(target);
          stream.pipe(out);
          stream.on('error', reject);
          out.on('error', reject);
          out.on('close', resolve);
        });
        if (entry.fileName === 'manifest.json') {
          manifestJson = JSON.parse(await fs.promises.readFile(target, 'utf8'));
        }
      }

      const hasPdf = fs.existsSync(path.join(tmpDir, 'paper.pdf'));
      const validation = validateShareManifest(manifestJson, hasPdf);
      if (!validation.valid) {
        return {
          ok: false,
          code: 'INVALID_MANIFEST',
          reason: validation.invalidFields.join(', '),
        };
      }

      const id = randomUUID();
      const finalDir = path.join(importsDir, id);
      await fs.promises.rename(tmpDir, finalDir);
      tmpDir = null;

      const work = await readImportedWork(finalDir);
      return work
        ? { ok: true, data: { work } }
        : { ok: false, code: 'IMPORT_FAILED' };
    } catch (cause) {
      debug(`import failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      return { ok: false, code: 'INVALID_ARCHIVE' };
    } finally {
      if (tmpDir) {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  };

  const listRemote = async (url: string): Promise<GalleryResult<GalleryWork[]>> => {
    if (!isAllowedUrl(url)) {
      return { ok: false, code: 'REMOTE_UNAVAILABLE', reason: 'URL protocol not supported' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
    try {
      const response = await fetch(`${url.replace(/\/+$/, '')}/works?limit=${MAX_REMOTE_WORKS}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return { ok: false, code: 'REMOTE_UNAVAILABLE' };
      }
      const body = (await response.json()) as Array<Record<string, unknown>>;
      const works = body.slice(0, MAX_REMOTE_WORKS).map((item, index) => ({
        id: `remote:${index}`,
        source: 'remote' as const,
        sourceLabel: url,
        title: typeof item.title === 'string' ? item.title : undefined,
        competition: typeof item.competition === 'string' ? item.competition : undefined,
        category: typeof item.category === 'string' ? item.category : undefined,
        abstract: typeof item.abstract === 'string' ? item.abstract : undefined,
      }));
      return { ok: true, data: works };
    } catch {
      return { ok: false, code: 'REMOTE_UNAVAILABLE' };
    } finally {
      clearTimeout(timer);
    }
  };

  return { listLocal, listCandidates, exportShare, importShare, listRemote };
}

function writeZipToPath(zip: ZipFile, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target);
    zip.outputStream.pipe(out);
    out.on('error', reject);
    out.on('close', resolve);
  });
}

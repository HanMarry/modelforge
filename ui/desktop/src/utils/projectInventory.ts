import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectArtifact, ProjectSnapshot, ProjectStage } from '../types/workspaceApi';

const SKIP = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'vendor',
  '__pycache__',
  'venv',
  'env',
  'site-packages',
  'coverage',
  'test-results',
]);

export function classifyProjectFile(relativePath: string): ProjectStage | null {
  const normalized = relativePath.replace(/\\/g, '/').toLowerCase();
  const name = normalized.split('/').pop() ?? '';
  const ext = path.posix.extname(name);
  if (
    /^(model[_-]?plan|plan|方案|建模方案)(\.|_)/.test(name) &&
    /\.(md|txt|pdf|docx|tex)$/.test(name)
  )
    return 'plan';
  if (
    /\.(csv|tsv|xlsx?|parquet|pdf|docx|md|txt|json|png|jpe?g|svg|webp)$/.test(name) &&
    /(^|\/)(data|inputs?|problem|question|题目|题面|附件)([_.\-/]|$)/.test(normalized)
  )
    return 'inputs';
  if (/^(requirements.*\.txt|pyproject\.toml|uv\.lock|environment\.ya?ml)$/.test(name))
    return 'code';
  if (/\.(py|ipynb|r|jl|m)$/.test(name)) return 'code';
  if (/\.(png|svg|jpg|jpeg|webp|eps)$/.test(name)) return 'figures';
  if (ext === '.pdf' && /(^|\/)(figures?|plots?|images?|图表)(\/|$)/.test(normalized))
    return 'figures';
  if (/\.(tex|typ|docx|bib)$/.test(name)) return 'paper';
  if (
    /\.(pdf|md)$/.test(name) &&
    /(^|\/)(paper|document|main|thesis|report|final|submission|论文|报告|终稿)([_.\-/]|$)/.test(
      normalized
    )
  )
    return 'paper';
  if (
    /\.(csv|tsv|xlsx?|json|parquet|txt|md|pdf)$/.test(name) &&
    /(^|\/)(results?|outputs?|结果)(\/|$)/.test(normalized)
  )
    return 'results';
  if (/\.(csv|tsv|xlsx?|parquet|pdf)$/.test(name)) return 'inputs';
  if (
    /\.(md|txt|json)$/.test(name) &&
    /(^|\/)(data|inputs?|题目|题面|附件)([_.\-/]|$)/.test(normalized)
  )
    return 'inputs';
  return null;
}

export async function scanProject(
  rootDir: string,
  limits: { maxEntries?: number; maxDepth?: number } = {}
): Promise<ProjectSnapshot> {
  if (!rootDir?.trim() || !path.isAbsolute(rootDir))
    throw new Error('Choose an absolute project directory.');
  const root = await fs.realpath(rootDir);
  if (!(await fs.stat(root)).isDirectory())
    throw new Error('The selected path is not a directory.');
  const maxEntries = limits.maxEntries ?? 2000;
  const maxDepth = limits.maxDepth ?? 4;
  const artifacts: ProjectArtifact[] = [];
  let visited = 0;
  let limited = false;
  let unreadableDirectories = 0;
  const queue = [{ directory: root, depth: 0 }];

  // Breadth first keeps root-level plans and papers visible in a large project.
  while (queue.length && visited < maxEntries) {
    const { directory, depth } = queue.shift()!;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (directory === root) throw error;
      unreadableDirectories += 1;
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= maxEntries) {
        limited = true;
        break;
      }
      visited += 1;
      if (
        entry.name.startsWith('.') ||
        SKIP.has(entry.name.toLowerCase()) ||
        entry.isSymbolicLink()
      )
        continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) queue.push({ directory: fullPath, depth: depth + 1 });
        else limited = true;
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      const stage = classifyProjectFile(relativePath);
      if (!stage) continue;
      try {
        const stat = await fs.lstat(fullPath);
        if (!stat.isFile()) continue;
        artifacts.push({
          name: entry.name,
          path: fullPath,
          relativePath,
          stage,
          isDirectory: false,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        // Files can disappear while an agent is replacing its output.
      }
    }
  }
  return {
    root,
    scannedAt: Date.now(),
    artifacts: artifacts.sort(
      (a, b) => b.modifiedAt - a.modifiedAt || a.relativePath.localeCompare(b.relativePath)
    ),
    limited: limited || queue.length > 0,
    unreadableDirectories,
  };
}

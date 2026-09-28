/**
 * Codex runtime shipped inside the Windows build.
 *
 * `scripts/prepare-codex-runtime.js` stages it under `src/bin`, which the packager copies to
 * `resources/bin`:
 *   codex-acp.cmd                       the command the kernel resolves as `codex-acp`
 *   codex-runtime/node/node.exe         pinned Node.js that runs the adapter
 *   codex-runtime/app/node_modules/...  lockfile-pinned adapter + Codex CLI
 *   codex-runtime/runtime.json          versions, written after the install was verified
 *
 * The kernel looks up `codex-acp` through its search paths before PATH, and the npm global
 * directory comes first among the defaults, so the bundled directory is put at the front of
 * `GOOSE_SEARCH_PATHS`. Otherwise a stale global install would silently win.
 */
import fs from 'node:fs';
import path from 'node:path';

export const CODEX_ACP_ENTRY = 'codex-acp.cmd';
export const CODEX_RUNTIME_DIR = 'codex-runtime';
export const GOOSE_SEARCH_PATHS_ENV = 'GOOSE_SEARCH_PATHS';

export interface BundledCodexVersions {
  codexAcp: string;
  codex: string;
  node: string;
}

export type BundledCodexUnavailableReason =
  | 'unsupported-platform'
  | 'not-packaged'
  | 'missing-files'
  | 'invalid-manifest';

export interface BundledCodexRuntimeStatus {
  /** True for packaged Windows builds, which are expected to carry the runtime. */
  expected: boolean;
  available: boolean;
  binDir: string | null;
  versions: BundledCodexVersions | null;
  reason: BundledCodexUnavailableReason | null;
  /** Required files that are missing, relative to `binDir`. */
  missing: string[];
}

export interface BundledCodexFs {
  existsSync: (target: string) => boolean;
  readFileSync: (target: string, encoding: 'utf8') => string;
}

export interface BundledCodexRuntimeFiles {
  entry: string;
  node: string;
  adapter: string;
  codex: string;
  manifest: string;
}

export function bundledCodexRuntimeFiles(binDir: string): BundledCodexRuntimeFiles {
  const root = path.join(binDir, CODEX_RUNTIME_DIR);
  const modules = path.join(root, 'app', 'node_modules');
  return {
    entry: path.join(binDir, CODEX_ACP_ENTRY),
    node: path.join(root, 'node', 'node.exe'),
    adapter: path.join(modules, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js'),
    codex: path.join(
      modules,
      '@openai',
      'codex-win32-x64',
      'vendor',
      'x86_64-pc-windows-msvc',
      'bin',
      'codex.exe'
    ),
    manifest: path.join(root, 'runtime.json'),
  };
}

function unavailable(
  reason: BundledCodexUnavailableReason,
  expected: boolean,
  binDir: string | null = null,
  missing: string[] = []
): BundledCodexRuntimeStatus {
  return { expected, available: false, binDir, versions: null, reason, missing };
}

function parseVersions(raw: string): BundledCodexVersions | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const { codexAcpVersion, codexVersion, nodeVersion } = record;
  if (
    typeof codexAcpVersion !== 'string' ||
    typeof codexVersion !== 'string' ||
    typeof nodeVersion !== 'string' ||
    !codexAcpVersion ||
    !codexVersion ||
    !nodeVersion
  ) {
    return null;
  }
  return { codexAcp: codexAcpVersion, codex: codexVersion, node: nodeVersion };
}

export function resolveBundledCodexRuntime(options: {
  platform: string;
  isPackaged: boolean;
  resourcesPath?: string;
  fs?: BundledCodexFs;
}): BundledCodexRuntimeStatus {
  const { platform, isPackaged, resourcesPath, fs: fileSystem = fs } = options;
  if (platform !== 'win32') {
    return unavailable('unsupported-platform', false);
  }
  if (!isPackaged || !resourcesPath) {
    return unavailable('not-packaged', false);
  }

  const binDir = path.join(resourcesPath, 'bin');
  const files = bundledCodexRuntimeFiles(binDir);
  const missing = [files.entry, files.node, files.adapter, files.codex, files.manifest]
    .filter((target) => !fileSystem.existsSync(target))
    .map((target) => path.relative(binDir, target));
  if (missing.length > 0) {
    return unavailable('missing-files', true, binDir, missing);
  }

  let versions: BundledCodexVersions | null;
  try {
    versions = parseVersions(fileSystem.readFileSync(files.manifest, 'utf8'));
  } catch {
    versions = null;
  }
  if (!versions) {
    return unavailable('invalid-manifest', true, binDir);
  }

  return { expected: true, available: true, binDir, versions, reason: null, missing: [] };
}

/**
 * Mirrors how the kernel reads `GOOSE_SEARCH_PATHS` from the environment: JSON, and anything
 * that is not an array of strings is ignored rather than guessed at.
 */
export function parseSearchPathsEnv(raw: string | undefined | null): string[] {
  if (!raw || !raw.trim()) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

/**
 * `GOOSE_SEARCH_PATHS` from goose's parsed config.yaml. Once the app sets the variable in the
 * environment the kernel stops reading the file, so these entries are carried over instead of
 * being dropped.
 */
export function searchPathsFromConfig(config: unknown): string[] {
  if (!config || typeof config !== 'object') {
    return [];
  }
  const value = (config as Record<string, unknown>)[GOOSE_SEARCH_PATHS_ENV];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * Environment for the kernel process. Empty unless the bundled runtime is complete, so
 * development builds keep resolving the user's own global install.
 */
export function bundledCodexSearchPathEnv(
  status: BundledCodexRuntimeStatus,
  env: Record<string, string | undefined>,
  configuredPaths: string[] = []
): Record<string, string> {
  if (!status.available || !status.binDir) {
    return {};
  }
  const fromEnv = env[GOOSE_SEARCH_PATHS_ENV];
  const existing = fromEnv !== undefined ? parseSearchPathsEnv(fromEnv) : configuredPaths;
  const binDir = status.binDir;
  const merged = [binDir, ...existing.filter((entry) => !samePath(entry, binDir))];
  return { [GOOSE_SEARCH_PATHS_ENV]: JSON.stringify(merged) };
}

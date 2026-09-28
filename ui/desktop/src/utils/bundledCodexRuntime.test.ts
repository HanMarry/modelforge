import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundledCodexRuntimeFiles,
  bundledCodexSearchPathEnv,
  parseSearchPathsEnv,
  resolveBundledCodexRuntime,
  searchPathsFromConfig,
  type BundledCodexFs,
  type BundledCodexRuntimeStatus,
} from './bundledCodexRuntime';

const resourcesPath = path.join('C:', 'Program Files', 'ModelForge', 'resources');
const binDir = path.join(resourcesPath, 'bin');
const files = bundledCodexRuntimeFiles(binDir);
const manifest = JSON.stringify({
  codexAcpVersion: '1.13.1',
  codexVersion: '0.156.1',
  nodeVersion: '24.21.0',
});

function fakeFs(present: string[], manifestText = manifest): BundledCodexFs {
  const existing = new Set(present);
  return {
    existsSync: (target) => existing.has(target),
    readFileSync: (target) => {
      if (target !== files.manifest || !existing.has(target)) {
        throw new Error(`ENOENT: ${target}`);
      }
      return manifestText;
    },
  };
}

const allFiles = [files.entry, files.node, files.adapter, files.codex, files.manifest];

function availableStatus(): BundledCodexRuntimeStatus {
  return resolveBundledCodexRuntime({
    platform: 'win32',
    isPackaged: true,
    resourcesPath,
    fs: fakeFs(allFiles),
  });
}

describe('resolveBundledCodexRuntime', () => {
  it('reports the pinned versions when every file is present', () => {
    expect(availableStatus()).toEqual({
      expected: true,
      available: true,
      binDir,
      versions: { codexAcp: '1.13.1', codex: '0.156.1', node: '24.21.0' },
      reason: null,
      missing: [],
    });
  });

  it('is not expected outside packaged Windows builds', () => {
    const fileSystem = fakeFs(allFiles);
    const onMac = resolveBundledCodexRuntime({
      platform: 'darwin',
      isPackaged: true,
      resourcesPath,
      fs: fileSystem,
    });
    const inDev = resolveBundledCodexRuntime({
      platform: 'win32',
      isPackaged: false,
      resourcesPath,
      fs: fileSystem,
    });
    expect(onMac).toMatchObject({ expected: false, available: false, reason: 'unsupported-platform' });
    expect(inDev).toMatchObject({ expected: false, available: false, reason: 'not-packaged' });
  });

  it('lists each missing file relative to the bin directory', () => {
    const status = resolveBundledCodexRuntime({
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      fs: fakeFs(allFiles.filter((target) => target !== files.node && target !== files.codex)),
    });
    expect(status).toMatchObject({ expected: true, available: false, reason: 'missing-files' });
    expect(status.missing).toEqual([
      path.relative(binDir, files.node),
      path.relative(binDir, files.codex),
    ]);
  });

  it('rejects a manifest that is not valid JSON or lacks a version', () => {
    for (const broken of ['{not json', JSON.stringify({ codexAcpVersion: '1.13.1' }), '[]']) {
      const status = resolveBundledCodexRuntime({
        platform: 'win32',
        isPackaged: true,
        resourcesPath,
        fs: fakeFs(allFiles, broken),
      });
      expect(status).toMatchObject({ available: false, reason: 'invalid-manifest', versions: null });
    }
  });
});

describe('parseSearchPathsEnv', () => {
  it('accepts only JSON arrays of strings, like the kernel', () => {
    expect(parseSearchPathsEnv('["C:\\\\tools","D:\\\\bin"]')).toEqual(['C:\\tools', 'D:\\bin']);
    expect(parseSearchPathsEnv('C:\\tools')).toEqual([]);
    expect(parseSearchPathsEnv('"C:\\\\tools"')).toEqual([]);
    expect(parseSearchPathsEnv('[1, "x", null]')).toEqual(['x']);
    expect(parseSearchPathsEnv(undefined)).toEqual([]);
  });
});

describe('searchPathsFromConfig', () => {
  it('keeps only the string entries of GOOSE_SEARCH_PATHS', () => {
    expect(
      searchPathsFromConfig({ GOOSE_PROVIDER: 'deepseek', GOOSE_SEARCH_PATHS: ['/opt/bin', 3, ''] })
    ).toEqual(['/opt/bin']);
    expect(searchPathsFromConfig({ GOOSE_SEARCH_PATHS: '/opt/bin' })).toEqual([]);
    expect(searchPathsFromConfig(null)).toEqual([]);
    expect(searchPathsFromConfig('GOOSE_SEARCH_PATHS: []')).toEqual([]);
  });
});

describe('bundledCodexSearchPathEnv', () => {
  it('puts the bundled directory first and keeps configured entries', () => {
    expect(bundledCodexSearchPathEnv(availableStatus(), {}, ['/opt/tools/bin'])).toEqual({
      GOOSE_SEARCH_PATHS: JSON.stringify([binDir, '/opt/tools/bin']),
    });
  });

  it('prefers an existing environment value over config.yaml, as the kernel does', () => {
    const env = { GOOSE_SEARCH_PATHS: JSON.stringify(['E:\\custom', binDir.toUpperCase()]) };
    expect(bundledCodexSearchPathEnv(availableStatus(), env, ['/ignored'])).toEqual({
      GOOSE_SEARCH_PATHS: JSON.stringify([binDir, 'E:\\custom']),
    });
  });

  it('adds nothing when the runtime is unavailable', () => {
    const status = resolveBundledCodexRuntime({
      platform: 'win32',
      isPackaged: true,
      resourcesPath,
      fs: fakeFs([]),
    });
    expect(bundledCodexSearchPathEnv(status, {}, ['/opt/tools/bin'])).toEqual({});
  });
});

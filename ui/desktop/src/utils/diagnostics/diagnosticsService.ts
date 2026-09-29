/**
 * Diagnostics centre service (spec mathmodel-parity-and-beyond, requirement 6). Runs four
 * categories — provider connectivity, kernel version, Python, and LaTeX/Typst — in parallel,
 * each capped at 60 seconds, and folds the outcome into a "正常"/"异常" verdict with a reason
 * and fix steps. Also exposes kernel build provenance (requirement 3.6, 3.9) and report
 * export (requirement 6.7, 6.8).
 */
import { execFile } from 'child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../atomicWrite';
import { redactText } from '../secretMask';
import {
  MANIFEST_FILE_NAME,
  parseKernelBuildInfo,
  parseManifest,
  provenanceDifferences,
  type BuildManifest,
  type KernelBuildInfo,
} from '../buildManifest';
import { classifyProviderError, testProviderConnection, PROVIDER_ERROR_LABELS } from '../providerConnectivity';
import type { EnvironmentProbe } from '../workspaceIpc';

export type DiagnosticCategory = 'provider' | 'runtime' | 'python' | 'typesetting';
export type DiagnosticState = '正常' | '异常' | '检测中' | '未检测';

export const UNKNOWN_VERSION = '未知';

export const DIAGNOSTIC_CATEGORIES: readonly DiagnosticCategory[] = [
  'provider',
  'runtime',
  'python',
  'typesetting',
];

export const DIAGNOSTIC_TIMEOUT_MS = 60_000;

/** A fix the diagnostics centre shows: an instruction to follow, or a clickable action. */
export interface FixStep {
  kind: 'instruction' | 'action';
  label: string;
}

export interface CategoryResult {
  state: DiagnosticState;
  /** Detected version, or `未知` when none could be found (requirement 6.1). */
  version: string;
  /** ISO 8601 time of the most recent completed check, or null before the first run. */
  checkedAt: string | null;
  reason: string | null;
  fixes: FixStep[];
  logIds: string[];
}

/** One category probe; it resolves to a verdict or throws/times out (runAll catches both). */
export type DiagnosticDetector = (signal?: globalThis.AbortSignal) => Promise<CategoryResult>;

export interface RunAllOptions {
  timeoutMs?: number;
  signal?: globalThis.AbortSignal;
  onProgress?: (category: DiagnosticCategory, result: CategoryResult) => void;
}

const FIXES: Record<DiagnosticCategory, FixStep[]> = {
  provider: [
    { kind: 'instruction', label: '前往设置页添加并配置一个模型供应商，然后回到这里重试。' },
  ],
  runtime: [
    { kind: 'instruction', label: '重新启动 ModelForge；若仍然失败，请重新安装内核。' },
  ],
  python: [
    { kind: 'instruction', label: '安装 Python（见下方可选运行时列表），或把 python 加入 PATH 后重试。' },
  ],
  typesetting: [
    { kind: 'instruction', label: '安装 LaTeX（TeX Live）或 Typst（见下方可选运行时列表），或将其加入 PATH 后重试。' },
  ],
};

const isoNow = (): string => new Date().toISOString();

class DiagnosticTimeoutError extends Error {
  constructor(category: DiagnosticCategory) {
    super(`diagnostics timed out for ${category}`);
    this.name = 'DiagnosticTimeoutError';
  }
}

function abnormalResult(category: DiagnosticCategory, error: unknown): CategoryResult {
  const reason =
    error instanceof DiagnosticTimeoutError
      ? '检测超时'
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    state: '异常',
    version: UNKNOWN_VERSION,
    checkedAt: isoNow(),
    reason,
    fixes: FIXES[category],
    logIds: [],
  };
}

/**
 * Runs all four detectors in parallel. A detector that throws or exceeds `timeoutMs` becomes
 * an abnormal result for its own category only; every other category keeps its own verdict
 * (requirement 6.5). `onProgress` fires once per category as it settles.
 */
export async function runAll(
  detectors: Record<DiagnosticCategory, DiagnosticDetector>,
  options: RunAllOptions = {}
): Promise<Record<DiagnosticCategory, CategoryResult>> {
  const timeoutMs = options.timeoutMs ?? DIAGNOSTIC_TIMEOUT_MS;

  const runOne = async (
    category: DiagnosticCategory
  ): Promise<[DiagnosticCategory, CategoryResult]> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DiagnosticTimeoutError(category)), timeoutMs);
    });
    let result: CategoryResult;
    try {
      result = await Promise.race([detectors[category](options.signal), timeout]);
    } catch (error) {
      result = abnormalResult(category, error);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    options.onProgress?.(category, result);
    return [category, result];
  };

  const entries = await Promise.all(DIAGNOSTIC_CATEGORIES.map(runOne));
  return Object.fromEntries(entries) as Record<DiagnosticCategory, CategoryResult>;
}

/** A configured provider the diagnostics centre can reach with a raw key. */
export interface ConfiguredProvider {
  name: string;
  baseUrl: string;
  key: string;
}

export interface DetectorDependencies {
  /** Providers with an endpoint and key the desktop app can test directly. */
  listConfiguredProviders: () => Promise<ConfiguredProvider[]>;
  /** `goose version --json` version, or null when the kernel cannot report one. */
  getKernelVersion: () => Promise<string | null>;
  /** Reuses the workspace environment probe table (requirement 9.3). */
  probeEnvironment: () => Promise<EnvironmentProbe[]>;
}

function probeById(probes: EnvironmentProbe[], id: string): EnvironmentProbe | undefined {
  return probes.find((probe) => probe.id === id);
}

const TYPESETTING_IDS = ['latexmk', 'xelatex', 'typst'];

/** The four real detectors, wired with injected main-process dependencies. */
export function createDetectors(deps: DetectorDependencies): Record<DiagnosticCategory, DiagnosticDetector> {
  return {
    provider: async () => {
      const providers = await deps.listConfiguredProviders();
      if (providers.length === 0) {
        return {
          state: '异常',
          version: UNKNOWN_VERSION,
          checkedAt: isoNow(),
          reason: '未配置任何模型供应商',
          fixes: FIXES.provider,
          logIds: [],
        };
      }
      let lastFailure: string | null = null;
      for (const provider of providers) {
        const result = await testProviderConnection({ baseUrl: provider.baseUrl }, provider.key);
        if (result.ok) {
          return {
            state: '正常',
            version: provider.name,
            checkedAt: isoNow(),
            reason: null,
            fixes: [],
            logIds: [],
          };
        }
        lastFailure =
          PROVIDER_ERROR_LABELS[
            classifyProviderError(result.failure.status, result.failure.body, result.failure.cause)
          ];
      }
      return {
        state: '异常',
        version: providers[0]?.name ?? UNKNOWN_VERSION,
        checkedAt: isoNow(),
        reason: lastFailure ?? '连接测试失败',
        fixes: FIXES.provider,
        logIds: [],
      };
    },
    runtime: async () => {
      const version = await deps.getKernelVersion();
      if (version) {
        return {
          state: '正常',
          version,
          checkedAt: isoNow(),
          reason: null,
          fixes: [],
          logIds: [],
        };
      }
      return {
        state: '异常',
        version: UNKNOWN_VERSION,
        checkedAt: isoNow(),
        reason: '内核无法启动或无法返回版本号',
        fixes: FIXES.runtime,
        logIds: [],
      };
    },
    python: async () => {
      const probes = await deps.probeEnvironment();
      const python = probeById(probes, 'python');
      if (python?.available) {
        return {
          state: '正常',
          version: python.version ?? UNKNOWN_VERSION,
          checkedAt: isoNow(),
          reason: null,
          fixes: [],
          logIds: [],
        };
      }
      return {
        state: '异常',
        version: UNKNOWN_VERSION,
        checkedAt: isoNow(),
        reason: '未检测到 Python 解释器',
        fixes: FIXES.python,
        logIds: [],
      };
    },
    typesetting: async () => {
      const probes = await deps.probeEnvironment();
      const available = probes.find((probe) => TYPESETTING_IDS.includes(probe.id) && probe.available);
      if (available) {
        return {
          state: '正常',
          version: available.version ?? UNKNOWN_VERSION,
          checkedAt: isoNow(),
          reason: null,
          fixes: [],
          logIds: [],
        };
      }
      return {
        state: '异常',
        version: UNKNOWN_VERSION,
        checkedAt: isoNow(),
        reason: '未检测到 LaTeX 或 Typst 编译器',
        fixes: FIXES.typesetting,
        logIds: [],
      };
    },
  };
}

export type KernelProvenanceState = '正常' | '不可追溯';

export interface KernelProvenance {
  state: KernelProvenanceState;
  version: string | null;
  commit: string | null;
  features: string[];
  dirty: boolean | null;
  /** Where the kernel's own report disagrees with its manifest (requirement 3.6). */
  differences: string[];
  reason: string | null;
}

type BuildInfoResult = { ok: true; info: KernelBuildInfo } | { ok: false; reason: string };

function runVersionJson(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ['version', '--json'],
      { timeout: 2000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

export async function readKernelBuildInfo(binaryPath: string): Promise<BuildInfoResult> {
  try {
    const stdout = await runVersionJson(binaryPath);
    return parseKernelBuildInfo(stdout);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

type ManifestResult = { ok: true; manifest: BuildManifest } | { ok: false; reason: string };

async function readManifest(dir: string): Promise<ManifestResult> {
  try {
    const text = await fs.readFile(path.join(dir, MANIFEST_FILE_NAME), 'utf8');
    return parseManifest(text);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Build provenance (requirement 3.6, 3.9): `goose version --json` next to the manifest the
 * build shipped. Missing or unreadable manifest, or a kernel that cannot report its own build,
 * yields "不可追溯" while the other diagnostics keep working.
 */
export async function getKernelProvenance(binaryPath: string): Promise<KernelProvenance> {
  const info = await readKernelBuildInfo(binaryPath);
  const manifestResult = await readManifest(path.dirname(binaryPath));

  const version = info.ok ? info.info.version : null;
  const kernelCommit = info.ok ? info.info.commit : null;
  const kernelDirty = info.ok ? info.info.dirty : null;
  const kernelFeatures = info.ok ? info.info.features : [];

  if (!info.ok) {
    return {
      state: '不可追溯',
      version,
      commit: kernelCommit,
      features: kernelFeatures,
      dirty: kernelDirty,
      differences: [],
      reason: `内核版本信息不可读取：${info.reason}`,
    };
  }

  if (!manifestResult.ok) {
    return {
      state: '不可追溯',
      version,
      commit: kernelCommit,
      features: kernelFeatures,
      dirty: kernelDirty,
      differences: [],
      reason: `构建清单不可读取：${manifestResult.reason}`,
    };
  }

  const manifest = manifestResult.manifest;

  return {
    state: '正常',
    version: manifest.version,
    commit: manifest.commit,
    features: manifest.features,
    dirty: manifest.dirty,
    differences: provenanceDifferences(manifest, info.info),
    reason: null,
  };
}

export interface DiagnosticReport {
  results: Record<DiagnosticCategory, CategoryResult>;
  provenance: KernelProvenance;
}

const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  provider: '模型供应商',
  runtime: '智能体运行时',
  python: 'Python 环境',
  typesetting: 'LaTeX/Typst 编译环境',
};

/** Renders the report as text; the exporter redacts secrets before writing it. */
export function serializeReport(report: DiagnosticReport): string {
  const lines: string[] = [
    'ModelForge 诊断报告',
    `导出时间: ${isoNow()}`,
    `构建来源: ${report.provenance.state === '正常' ? `commit=${report.provenance.commit ?? ''} version=${report.provenance.version ?? ''} dirty=${report.provenance.dirty ?? ''} features=${report.provenance.features.join(', ')}` : `不可追溯（${report.provenance.reason ?? ''}）`}`,
    '',
  ];
  for (const category of DIAGNOSTIC_CATEGORIES) {
    const result = report.results[category];
    lines.push(
      `${CATEGORY_LABELS[category]}: ${result.state} | 版本: ${result.version} | 检测时间: ${result.checkedAt ?? ''} | 原因: ${result.reason ?? ''} | 日志: ${result.logIds.join(', ')}`
    );
  }
  return lines.join('\n');
}

export type ExportResult = { ok: true } | { ok: false; error: string };

/**
 * Writes the report atomically, after masking every known secret (requirement 6.7, 6.8). A
 * failed write leaves no partial file at the target.
 */
export async function exportReport(
  target: string,
  report: DiagnosticReport,
  secrets: Iterable<string>
): Promise<ExportResult> {
  const text = redactText(serializeReport(report), secrets);
  try {
    await writeFileAtomic(target, text);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * IPC for the diagnostics centre and first-boot connectivity test (requirement 3.6, 5.2, 6).
 * `diagnostics-run` streams per-category progress events while the four categories run in
 * parallel; `kernel-provenance`, `diagnostics-export`, `provider-test-connection` and
 * `detect-local-runtimes` are one-shot requests.
 */
import type { IpcMain } from 'electron';
import { runEnvironmentProbes } from '../workspaceIpc';
import { detectLocalRuntimes } from '../runtimeDetection';
import {
  testProviderConnection,
  type ProviderConnectionResult,
  type ProviderConnectionTarget,
} from '../providerConnectivity';
import {
  DIAGNOSTIC_CATEGORIES,
  UNKNOWN_VERSION,
  createDetectors,
  exportReport,
  getKernelProvenance,
  readKernelBuildInfo,
  runAll,
  type CategoryResult,
  type ConfiguredProvider,
  type DiagnosticCategory,
  type DiagnosticReport,
} from './diagnosticsService';

export interface DiagnosticsIpcDeps {
  /** Resolves the kernel binary lazily, so it is not required before `app` is ready. */
  getBinaryPath: () => string;
  /** Providers with an endpoint and a key the desktop app can test directly. */
  listConfiguredProviders: () => Promise<ConfiguredProvider[]>;
  /** Every known secret value, for masking the exported report (requirement 6.7). */
  secrets: () => string[];
}

const CHECKING_RESULT: CategoryResult = {
  state: '检测中',
  version: UNKNOWN_VERSION,
  checkedAt: null,
  reason: null,
  fixes: [],
  logIds: [],
};

export function registerDiagnosticsIpc(ipc: Pick<IpcMain, 'handle'>, deps: DiagnosticsIpcDeps): void {
  ipc.handle(
    'provider-test-connection',
    (_event, target: ProviderConnectionTarget, key: unknown): Promise<ProviderConnectionResult> => {
      if (
        !target ||
        typeof target.baseUrl !== 'string' ||
        !target.baseUrl.trim() ||
        typeof key !== 'string' ||
        !key.trim()
      ) {
        return { ok: false, failure: { status: null, body: '', cause: 'invalid request' } };
      }
      return testProviderConnection(target, key);
    }
  );

  ipc.handle('diagnostics-run', async (event): Promise<Record<DiagnosticCategory, CategoryResult>> => {
    const detectors = createDetectors({
      listConfiguredProviders: deps.listConfiguredProviders,
      getKernelVersion: async () => {
        const result = await readKernelBuildInfo(deps.getBinaryPath());
        return result.ok ? result.info.version : null;
      },
      probeEnvironment: runEnvironmentProbes,
    });

    for (const category of DIAGNOSTIC_CATEGORIES) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('diagnostics-progress', category, CHECKING_RESULT);
      }
    }

    return runAll(detectors, {
      onProgress: (category, result) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('diagnostics-progress', category, result);
        }
      },
    });
  });

  ipc.handle('diagnostics-export', (_event, target: unknown, report: DiagnosticReport) => {
    if (typeof target !== 'string' || !target.trim() || !report) {
      return { ok: false, error: 'invalid request' };
    }
    return exportReport(target, report, deps.secrets());
  });

  ipc.handle('kernel-provenance', () => getKernelProvenance(deps.getBinaryPath()));

  ipc.handle('detect-local-runtimes', () => detectLocalRuntimes());
}

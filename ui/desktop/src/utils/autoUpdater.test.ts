// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => {
  const updaterListeners = new Map<string, Listener>();
  const ipcHandlers = new Map<string, Listener>();
  return {
    updaterListeners,
    ipcHandlers,
    autoUpdater: {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      forceDevUpdateConfig: false,
      channel: null,
      allowPrerelease: false,
      allowDowngrade: false,
      logger: null as unknown,
      currentVersion: { version: '1.0.0' },
      setFeedURL: vi.fn(),
      getFeedURL: vi.fn(() => 'Deprecated. Do not use it.'),
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      quitAndInstall: vi.fn(),
      on: vi.fn((event: string, listener: Listener) => {
        updaterListeners.set(event, listener);
      }),
    },
    githubUpdater: {
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      installUpdate: vi.fn(),
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

vi.mock('electron-updater', () => ({ autoUpdater: mocks.autoUpdater }));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.0.0',
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false,
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn((channel: string, listener: Listener) => {
      mocks.ipcHandlers.set(channel, listener);
    }),
    emit: vi.fn(),
  },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { buildFromTemplate: vi.fn() },
  nativeImage: { createFromPath: vi.fn() },
  Notification: vi.fn(),
  Tray: vi.fn(),
}));

vi.mock('./logger', () => ({ default: mocks.log }));

vi.mock('./recentDirs', () => ({ loadRecentDirs: () => [] }));

vi.mock('./analytics', () => ({
  trackUpdateCheckStarted: vi.fn(),
  trackUpdateCheckCompleted: vi.fn(),
  trackUpdateDownloadStarted: vi.fn(),
  trackUpdateDownloadProgress: vi.fn(),
  trackUpdateDownloadCompleted: vi.fn(),
  trackUpdateInstallInitiated: vi.fn(),
}));

// Keep the real isUpdateChannelConfigured / getUpdateRepository so the tests exercise the
// same owner/repo resolution the app uses; only the network-facing singleton is replaced.
vi.mock('./githubUpdater', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./githubUpdater')>()),
  githubUpdater: mocks.githubUpdater,
}));

// Same shape as the electron-updater error installer run 36686960299 logged (there against the
// upstream feed), which is what triggers the GitHub API fallback.
const MISSING_LATEST_YML = new Error(
  'Cannot find latest.yml in the latest release artifacts (https://github.com/HanMarry/modelforge/releases/download/v2.0.0/latest.yml): HttpError: 404'
);

async function loadAutoUpdater() {
  // autoUpdater.ts keeps module-level state (for example "IPC handlers registered"), so
  // every test gets a fresh copy.
  vi.resetModules();
  const updater = await import('./autoUpdater');
  // The startup check runs on a timer; fake timers start after the import so module loading
  // is unaffected.
  vi.useFakeTimers();
  return updater;
}

async function invokeIpc(channel: string): Promise<unknown> {
  const handler = mocks.ipcHandlers.get(channel);
  if (!handler) {
    throw new Error(`No IPC handler registered for ${channel}`);
  }
  return handler({});
}

function loggedInfo(): string[] {
  return mocks.log.info.mock.calls.map(([message]) => String(message));
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps per-test resolved/rejected values; drop them so tests stay independent.
  mocks.autoUpdater.checkForUpdates.mockReset();
  mocks.githubUpdater.checkForUpdates.mockReset();
  mocks.githubUpdater.downloadUpdate.mockReset();
  mocks.updaterListeners.clear();
  mocks.ipcHandlers.clear();
  mocks.autoUpdater.autoDownload = true;
  vi.stubEnv('GOOSE_DISABLE_AUTO_DOWNLOAD', '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('auto-updater without a configured update channel', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_OWNER', '');
    vi.stubEnv('GITHUB_REPO', '');
  });

  it('points the feed at the ModelForge repository and never checks on startup', async () => {
    const { setupAutoUpdater } = await loadAutoUpdater();

    setupAutoUpdater();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'HanMarry',
      repo: 'modelforge',
      releaseType: 'release',
    });
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.githubUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.autoDownload).toBe(false);
    expect(loggedInfo()).toContain('Update channel not configured; skipping startup update check');
  });

  it('keeps electron-updater auto-download off even when the user enables it', async () => {
    const { setAutoDownloadDisabled, setupAutoUpdater } = await loadAutoUpdater();

    setupAutoUpdater();
    setAutoDownloadDisabled(false);

    expect(mocks.autoUpdater.autoDownload).toBe(false);
  });

  it('does not fall back to the GitHub API after an electron-updater error', async () => {
    const { setupAutoUpdater } = await loadAutoUpdater();
    setupAutoUpdater();

    const onError = mocks.updaterListeners.get('error');
    expect(onError).toBeDefined();
    await onError?.(MISSING_LATEST_YML);

    expect(mocks.githubUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.githubUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(loggedInfo()).toContain(
      'Update channel not configured; skipping GitHub fallback after auto-updater error'
    );
  });

  it('answers manual checks and downloads without touching the network', async () => {
    const { registerUpdateIpcHandlers } = await loadAutoUpdater();
    registerUpdateIpcHandlers();

    await expect(invokeIpc('check-for-updates')).resolves.toEqual({
      updateInfo: null,
      error: null,
      status: 'not-configured',
    });
    await expect(invokeIpc('download-update')).resolves.toEqual({
      success: false,
      error: 'Update channel not configured',
    });

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(mocks.githubUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.githubUpdater.downloadUpdate).not.toHaveBeenCalled();
  });
});

describe('auto-updater with a configured update channel', () => {
  beforeEach(() => {
    vi.stubEnv('GITHUB_OWNER', 'acme');
    vi.stubEnv('GITHUB_REPO', 'forge-fork');
  });

  it('uses the configured owner/repo for the feed and checks on startup', async () => {
    mocks.autoUpdater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '1.0.0' } });
    const { setupAutoUpdater } = await loadAutoUpdater();

    setupAutoUpdater();
    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'github',
      owner: 'acme',
      repo: 'forge-fork',
      releaseType: 'release',
    });
    expect(mocks.autoUpdater.autoDownload).toBe(true);
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps the GitHub fallback download when the feed has no latest.yml', async () => {
    mocks.autoUpdater.checkForUpdates.mockRejectedValue(MISSING_LATEST_YML);
    mocks.githubUpdater.checkForUpdates.mockResolvedValue({
      updateAvailable: true,
      latestVersion: '2.0.0',
      downloadUrl: 'https://github.com/acme/forge-fork/releases/download/v2.0.0/ModelForge.zip',
      releaseUrl: 'https://github.com/acme/forge-fork/releases/tag/v2.0.0',
    });
    mocks.githubUpdater.downloadUpdate.mockResolvedValue({
      success: true,
      downloadPath: '/tmp/ModelForge-2.0.0.zip',
      extractedPath: '/tmp',
    });
    const { registerUpdateIpcHandlers } = await loadAutoUpdater();
    registerUpdateIpcHandlers();

    await invokeIpc('check-for-updates');

    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.githubUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(mocks.githubUpdater.downloadUpdate).toHaveBeenCalledWith(
      'https://github.com/acme/forge-fork/releases/download/v2.0.0/ModelForge.zip',
      '2.0.0',
      expect.any(Function)
    );
  });
});

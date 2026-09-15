import Electron, { contextBridge, ipcRenderer, webUtils } from 'electron';
import { Recipe } from './recipe';
import type { GooseApp } from './types/apps';
import type { Settings, SettingKey } from './utils/settings';
import type { AgentKernelStatus } from './utils/agentKernel';
import { defaultSettings } from './utils/settings';
import type { DisabledSkillRecord } from './utils/skillEnablement';
import type { OpenExternalUrlResult } from './utils/urlSecurity';
import type {
  EnvironmentProbe,
  GitCheckpoint,
  GitCheckpointFile,
  GitVersionResult,
  GitVersionStatus,
  TerminalSessionInfo,
  WorkspaceEntry,
  ProjectSnapshot,
  WorkspaceFileReadResult,
} from './types/workspaceApi';

// Mapping from settings keys to their old localStorage keys for lazy migration
const localStorageKeyMap: Partial<Record<SettingKey, string>> = {
  theme: 'theme',
  useSystemTheme: 'use_system_theme',
  responseStyle: 'response_style',
  showPricing: 'show_pricing',
  seenAnnouncementIds: 'seenAnnouncementIds',
};

// Parse localStorage value based on the setting key
function parseLocalStorageValue<K extends SettingKey>(
  key: K,
  rawValue: string
): Settings[K] | null {
  try {
    switch (key) {
      case 'theme':
        return (rawValue === 'dark' || rawValue === 'light' ? rawValue : null) as Settings[K];
      case 'useSystemTheme':
        return (rawValue === 'true') as unknown as Settings[K];
      case 'responseStyle':
        return rawValue as Settings[K];
      case 'showPricing':
        return (rawValue === 'true') as unknown as Settings[K];
      case 'seenAnnouncementIds':
        return JSON.parse(rawValue) as Settings[K];
      default:
        return null;
    }
  } catch {
    return null;
  }
}

interface NotificationData {
  title: string;
  body: string;
}

interface MessageBoxOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning';
  buttons?: string[];
  defaultId?: number;
  title?: string;
  message: string;
  detail?: string;
}

interface MessageBoxResponse {
  response: number;
  checkboxChecked?: boolean;
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  message?: string;
  nameFieldLabel?: string;
  showsTagField?: boolean;
}

interface SaveDialogResponse {
  canceled: boolean;
  filePath?: string;
}

interface FileResponse {
  file: string;
  filePath: string;
  error: string | null;
  found: boolean;
}

const config = JSON.parse(process.argv.find((arg) => arg.startsWith('{')) || '{}');

interface UpdaterEvent {
  event: string;
  data?: unknown;
}

export interface CreateChatWindowOptions {
  query?: string;
  dir?: string;
  version?: string;
  resumeSessionId?: string;
  viewType?: string;
  recipeId?: string;
}

// Define the API types in a single place
type ElectronAPI = {
  platform: string;
  arch: string;
  reactReady: () => void;
  getConfig: () => Record<string, unknown>;
  hideWindow: () => void;
  directoryChooser: () => Promise<Electron.OpenDialogReturnValue>;
  createChatWindow: (options?: CreateChatWindowOptions) => void;
  logInfo: (txt: string) => void;
  showNotification: (data: NotificationData) => void;
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxResponse>;
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogResponse>;
  openInChrome: (url: string) => void;
  reloadApp: () => void;
  checkForOllama: () => Promise<boolean>;
  selectFileOrDirectory: (defaultPath?: string) => Promise<string | null>;
  selectImportSessionFile: () => Promise<{
    filePath: string;
    contents: string;
    error?: string;
  } | null>;
  getBinaryPath: (binaryName: string) => Promise<string>;
  selectRecipeFile: () => Promise<FileResponse | null>;
  readGoosehints: () => Promise<FileResponse>;
  writeGoosehints: (content: string) => Promise<boolean>;
  writeFile: (directory: string, content: string) => Promise<boolean>;
  ensureDirectory: (dirPath: string) => Promise<boolean>;
  listFiles: (dirPath: string, extension?: string) => Promise<string[]>;
  workspaceListDirectory: (dirPath: string, showHidden?: boolean) => Promise<WorkspaceEntry[]>;
  workspaceReadFile: (filePath: string) => Promise<WorkspaceFileReadResult | null>;
  workspaceReadBinary: (
    filePath: string
  ) => Promise<{ dataUrl: string | null; size: number; error: string | null }>;
  workspaceWriteFile: (
    filePath: string,
    content: string
  ) => Promise<{ ok: boolean; error?: string }>;
  workspaceOpenPath: (targetPath: string) => Promise<string>;
  workspaceRevealPath: (targetPath: string) => Promise<boolean>;
  workspaceOpenInEditor: (
    targetPath: string,
    editor: 'vscode' | 'cursor' | 'notepad' | 'default'
  ) => Promise<{ ok: boolean; error?: string }>;
  workspaceProbeEnvironment: () => Promise<EnvironmentProbe[]>;
  workspaceScanProject: (rootDir: string) => Promise<ProjectSnapshot>;
  workspaceListDiagrams: (rootDir: string) => Promise<WorkspaceEntry[]>;
  workspaceSearchFiles: (rootDir: string, query: string) => Promise<WorkspaceEntry[]>;
  workspaceReadBytes: (
    filePath: string
  ) => Promise<{ base64: string | null; size: number; error: string | null }>;
  workspaceStat: (filePath: string) => Promise<{
    exists: boolean;
    isDirectory: boolean;
    size: number;
    modifiedAt: number;
  }>;
  gitVersionStatus: (dir: string) => Promise<GitVersionStatus>;
  gitVersionList: (dir: string, limit?: number) => Promise<GitCheckpoint[]>;
  gitVersionFiles: (dir: string, hash: string) => Promise<GitCheckpointFile[]>;
  gitVersionFileDiff: (dir: string, hash: string, filePath: string) => Promise<string>;
  gitVersionSave: (dir: string, message: string) => Promise<GitVersionResult>;
  gitVersionRestore: (dir: string, hash: string) => Promise<GitVersionResult>;
  gitVersionInit: (dir: string) => Promise<GitVersionResult>;
  terminalCreate: (request: {
    cwd?: string;
    cols?: number;
    rows?: number;
  }) => Promise<TerminalSessionInfo | null>;
  terminalWrite: (id: string, data: string) => Promise<boolean>;
  terminalResizeConsole: (id: string, cols: number, rows: number) => Promise<boolean>;
  terminalKill: (id: string) => Promise<boolean>;
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (payload: { id: string; code: number }) => void) => () => void;
  getAllowedExtensions: () => Promise<string[]>;
  /** Moves a skill folder in or out of the disabled store; built-ins cannot be disabled. */
  setSkillEnabled: (request: {
    name: string;
    path: string;
    enabled: boolean;
  }) => Promise<
    { ok: true; records: DisabledSkillRecord[]; location: string } | { ok: false; error: string }
  >;
  /** Skills the user disabled, with where they came from so they can be restored. */
  listDisabledSkills: () => Promise<DisabledSkillRecord[]>;
  /** Copies a picked folder containing SKILL.md into the global skills directory. */
  importSkillFolder: () => Promise<
    { canceled: true } | { canceled: false; name?: string; path?: string; error?: string }
  >;
  /** Reads a skill export payload for the kernel's importer. */
  selectSkillImportFile: () => Promise<{ filename: string; json?: string; error?: string } | null>;
  getPathForFile: (file: File) => string;
  setMenuBarIcon: (show: boolean) => Promise<boolean>;
  getMenuBarIconState: () => Promise<boolean>;
  setDockIcon: (show: boolean) => Promise<boolean>;
  getDockIconState: () => Promise<boolean>;
  getSetting: <K extends SettingKey>(key: K) => Promise<Settings[K]>;
  setSetting: <K extends SettingKey>(key: K, value: Settings[K]) => Promise<void>;
  getSecretKey: () => Promise<string | null>;
  getAcpUrl: () => Promise<string | null>;
  /** Which agent kernel is active and whether it has everything it needs to run. */
  getAgentKernelStatus: () => Promise<AgentKernelStatus>;
  /** Stores the key the external kernels use for the active provider. */
  setAgentKernelKey: (providerId: string, apiKey: string) => Promise<boolean>;
  clearAgentKernelKey: (providerId: string) => Promise<boolean>;
  /** Keeps a copy of a provider key saved in the app so kernels can reuse it. */
  rememberProviderApiKey: (providerId: string, apiKey: string) => Promise<boolean>;
  forgetProviderApiKey: (providerId: string) => Promise<boolean>;
  /** Re-provisions the kernel now; a running backend only picks it up after a restart. */
  applyAgentKernel: () => Promise<AgentKernelStatus>;
  /** Applies settings edits to the running kernel without re-provisioning it. */
  refreshAgentKernel: () => Promise<AgentKernelStatus>;
  /** Switches the model the kernel proxies to; takes effect on the next request. */
  setAgentKernelModel: (model: string) => Promise<AgentKernelStatus>;
  setWakelock: (enable: boolean) => Promise<boolean>;
  getWakelockState: () => Promise<boolean>;
  setSpellcheck: (enable: boolean) => Promise<boolean>;
  getSpellcheckState: () => Promise<boolean>;
  openNotificationsSettings: () => Promise<boolean>;
  isAnyWindowFocused: () => Promise<boolean>;
  getIsFullScreen: () => Promise<boolean>;
  onMouseBackButtonClicked: (callback: () => void) => void;
  offMouseBackButtonClicked: (callback: () => void) => void;
  on: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => void;
  off: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => void;
  emit: (channel: string, ...args: unknown[]) => void;
  broadcastThemeChange: (themeData: {
    mode: string;
    useSystemTheme: boolean;
    theme: string;
    tokensUpdated?: boolean;
  }) => void;
  openExternal: (url: string) => Promise<OpenExternalUrlResult>;
  // Update-related functions
  getVersion: () => string;
  checkForUpdates: () => Promise<{ updateInfo: unknown; error: string | null }>;
  downloadUpdate: () => Promise<{ success: boolean; error: string | null }>;
  installUpdate: () => void;
  restartApp: () => void;
  onUpdaterEvent: (callback: (event: UpdaterEvent) => void) => void;
  getUpdateState: () => Promise<{ updateAvailable: boolean; latestVersion?: string } | null>;
  isUsingGitHubFallback: () => Promise<boolean>;
  getAutoDownloadDisabled: () => Promise<boolean>;
  // Recipe warning functions
  closeWindow: () => void;
  hasAcceptedRecipeBefore: (recipe: Recipe) => Promise<boolean>;
  recordRecipeHash: (recipe: Recipe) => Promise<boolean>;
  openDirectoryInExplorer: (directoryPath: string) => Promise<boolean>;
  launchApp: (app: GooseApp) => Promise<void>;
  refreshApp: (app: GooseApp) => Promise<void>;
  closeApp: (appName: string) => Promise<void>;
  addRecentDir: (dir: string) => Promise<boolean>;
  listRecentDirs: () => Promise<string[]>;
  listGitWorktreeDirs: (dir: string) => Promise<string[]>;
  getGitBranchInfo: (dir: string) => Promise<{ branch: string } | null>;
  listGitBranches: (dir: string) => Promise<string[]>;
  switchGitBranch: (dir: string, branch: string) => Promise<{ success: boolean; error?: string }>;
};

type AppConfigAPI = {
  get: (key: string) => unknown;
  getAll: () => Record<string, unknown>;
};

const electronAPI: ElectronAPI = {
  platform: process.platform,
  arch: process.arch,
  reactReady: () => ipcRenderer.send('react-ready'),
  getConfig: () => {
    if (!config || Object.keys(config).length === 0) {
      console.warn(
        'No config provided by main process. This may indicate an initialization issue.'
      );
    }
    return config;
  },
  hideWindow: () => ipcRenderer.send('hide-window'),
  directoryChooser: () => ipcRenderer.invoke('directory-chooser'),
  createChatWindow: (options?: CreateChatWindowOptions) =>
    ipcRenderer.send('create-chat-window', options || {}),
  logInfo: (txt: string) => ipcRenderer.send('logInfo', txt),
  showNotification: (data: NotificationData) => ipcRenderer.send('notify', data),
  showMessageBox: (options: MessageBoxOptions) => ipcRenderer.invoke('show-message-box', options),
  showSaveDialog: (options: SaveDialogOptions) => ipcRenderer.invoke('show-save-dialog', options),
  openInChrome: (url: string) => ipcRenderer.send('open-in-chrome', url),
  reloadApp: () => ipcRenderer.send('reload-app'),
  checkForOllama: () => ipcRenderer.invoke('check-ollama'),

  selectFileOrDirectory: (defaultPath?: string) =>
    ipcRenderer.invoke('select-file-or-directory', defaultPath),
  selectImportSessionFile: () => ipcRenderer.invoke('select-import-session-file'),
  getBinaryPath: (binaryName: string) => ipcRenderer.invoke('get-binary-path', binaryName),
  selectRecipeFile: () => ipcRenderer.invoke('select-recipe-file'),
  readGoosehints: () => ipcRenderer.invoke('read-goosehints'),
  writeGoosehints: (content: string) => ipcRenderer.invoke('write-goosehints', content),
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('write-file', filePath, content),
  ensureDirectory: (dirPath: string) => ipcRenderer.invoke('ensure-directory', dirPath),
  listFiles: (dirPath: string, extension?: string) =>
    ipcRenderer.invoke('list-files', dirPath, extension),
  workspaceListDirectory: (dirPath: string, showHidden?: boolean) =>
    ipcRenderer.invoke('workspace-list-dir', dirPath, showHidden),
  workspaceReadFile: (filePath: string) => ipcRenderer.invoke('workspace-read-file', filePath),
  workspaceReadBinary: (filePath: string) => ipcRenderer.invoke('workspace-read-binary', filePath),
  workspaceWriteFile: (filePath: string, content: string) =>
    ipcRenderer.invoke('workspace-write-file', filePath, content),
  workspaceOpenPath: (targetPath: string) => ipcRenderer.invoke('workspace-open-path', targetPath),
  workspaceRevealPath: (targetPath: string) =>
    ipcRenderer.invoke('workspace-reveal-path', targetPath),
  workspaceOpenInEditor: (
    targetPath: string,
    editor: 'vscode' | 'cursor' | 'notepad' | 'default'
  ) => ipcRenderer.invoke('workspace-open-in-editor', targetPath, editor),
  workspaceProbeEnvironment: () => ipcRenderer.invoke('workspace-probe-environment'),
  workspaceScanProject: (rootDir: string) => ipcRenderer.invoke('workspace-scan-project', rootDir),
  workspaceListDiagrams: (rootDir: string) =>
    ipcRenderer.invoke('workspace-list-diagrams', rootDir),
  workspaceSearchFiles: (rootDir: string, query: string) =>
    ipcRenderer.invoke('workspace-search-files', rootDir, query),
  workspaceReadBytes: (filePath: string) => ipcRenderer.invoke('workspace-read-bytes', filePath),
  workspaceStat: (filePath: string) => ipcRenderer.invoke('workspace-stat', filePath),
  gitVersionStatus: (dir: string) => ipcRenderer.invoke('git-version-status', dir),
  gitVersionList: (dir: string, limit?: number) =>
    ipcRenderer.invoke('git-version-list', dir, limit),
  gitVersionFiles: (dir: string, hash: string) =>
    ipcRenderer.invoke('git-version-files', dir, hash),
  gitVersionFileDiff: (dir: string, hash: string, filePath: string) =>
    ipcRenderer.invoke('git-version-file-diff', dir, hash, filePath),
  gitVersionSave: (dir: string, message: string) =>
    ipcRenderer.invoke('git-version-save', dir, message),
  gitVersionRestore: (dir: string, hash: string) =>
    ipcRenderer.invoke('git-version-restore', dir, hash),
  gitVersionInit: (dir: string) => ipcRenderer.invoke('git-version-init', dir),
  terminalCreate: (request: { cwd?: string; cols?: number; rows?: number }) =>
    ipcRenderer.invoke('terminal-create', request),
  terminalWrite: (id: string, data: string) => ipcRenderer.invoke('terminal-write', id, data),
  terminalResizeConsole: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke('terminal-resize-console', id, cols, rows),
  terminalKill: (id: string) => ipcRenderer.invoke('terminal-kill', id),
  onTerminalData: (callback: (payload: { id: string; data: string }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; data: string }) =>
      callback(payload);
    ipcRenderer.on('terminal-data', listener);
    return () => ipcRenderer.removeListener('terminal-data', listener);
  },
  onTerminalExit: (callback: (payload: { id: string; code: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { id: string; code: number }) =>
      callback(payload);
    ipcRenderer.on('terminal-exit', listener);
    return () => ipcRenderer.removeListener('terminal-exit', listener);
  },
  setSkillEnabled: (request: { name: string; path: string; enabled: boolean }) =>
    ipcRenderer.invoke('skills-set-enabled', request),
  listDisabledSkills: () => ipcRenderer.invoke('skills-disabled-list'),
  importSkillFolder: () => ipcRenderer.invoke('import-skill-folder'),
  selectSkillImportFile: () => ipcRenderer.invoke('select-skill-import-file'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getAllowedExtensions: () => ipcRenderer.invoke('get-allowed-extensions'),
  setMenuBarIcon: (show: boolean) => ipcRenderer.invoke('set-menu-bar-icon', show),
  getMenuBarIconState: () => ipcRenderer.invoke('get-menu-bar-icon-state'),
  setDockIcon: (show: boolean) => ipcRenderer.invoke('set-dock-icon', show),
  getDockIconState: () => ipcRenderer.invoke('get-dock-icon-state'),
  getSetting: async <K extends SettingKey>(key: K): Promise<Settings[K]> => {
    try {
      // Check for localStorage value first (lazy migration)
      const localStorageKey = localStorageKeyMap[key];
      if (localStorageKey) {
        const rawValue = localStorage.getItem(localStorageKey);
        if (rawValue !== null) {
          const parsed = parseLocalStorageValue(key, rawValue);
          if (parsed !== null) {
            return parsed;
          }
        }
      }
      return await ipcRenderer.invoke('get-setting', key);
    } catch (error) {
      console.error(`Failed to get setting '${key}', using default`, error);
      return defaultSettings[key];
    }
  },
  setSetting: async <K extends SettingKey>(key: K, value: Settings[K]): Promise<void> => {
    // Clear any localStorage version when writing
    const localStorageKey = localStorageKeyMap[key];
    if (localStorageKey) {
      localStorage.removeItem(localStorageKey);
    }
    return ipcRenderer.invoke('set-setting', key, value);
  },
  getSecretKey: () => ipcRenderer.invoke('get-secret-key'),
  getAcpUrl: () => ipcRenderer.invoke('get-acp-url'),
  getAgentKernelStatus: () => ipcRenderer.invoke('agent-kernel-status'),
  setAgentKernelKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke('agent-kernel-set-key', providerId, apiKey),
  clearAgentKernelKey: (providerId: string) =>
    ipcRenderer.invoke('agent-kernel-clear-key', providerId),
  rememberProviderApiKey: (providerId: string, apiKey: string) =>
    ipcRenderer.invoke('agent-kernel-remember-provider-key', providerId, apiKey),
  forgetProviderApiKey: (providerId: string) =>
    ipcRenderer.invoke('agent-kernel-forget-provider-key', providerId),
  applyAgentKernel: () => ipcRenderer.invoke('agent-kernel-apply'),
  refreshAgentKernel: () => ipcRenderer.invoke('agent-kernel-refresh'),
  setAgentKernelModel: (model: string) => ipcRenderer.invoke('agent-kernel-set-model', model),
  setWakelock: (enable: boolean) => ipcRenderer.invoke('set-wakelock', enable),
  getWakelockState: () => ipcRenderer.invoke('get-wakelock-state'),
  setSpellcheck: (enable: boolean) => ipcRenderer.invoke('set-spellcheck', enable),
  getSpellcheckState: () => ipcRenderer.invoke('get-spellcheck-state'),
  openNotificationsSettings: () => ipcRenderer.invoke('open-notifications-settings'),
  isAnyWindowFocused: () => ipcRenderer.invoke('is-any-window-focused'),
  getIsFullScreen: () => ipcRenderer.invoke('get-is-fullscreen'),
  onMouseBackButtonClicked: (callback: () => void) => {
    // Wrapper that ignores the event parameter.
    const wrappedCallback = (_event: Electron.IpcRendererEvent) => callback();
    ipcRenderer.on('mouse-back-button-clicked', wrappedCallback);
    return wrappedCallback;
  },
  offMouseBackButtonClicked: (callback: () => void) => {
    ipcRenderer.removeListener('mouse-back-button-clicked', callback);
  },
  on: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => {
    ipcRenderer.on(channel, callback);
  },
  off: (
    channel: string,
    callback: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
  ) => {
    ipcRenderer.off(channel, callback);
  },
  emit: (channel: string, ...args: unknown[]) => {
    ipcRenderer.emit(channel, ...args);
  },
  broadcastThemeChange: (themeData: {
    mode: string;
    useSystemTheme: boolean;
    theme: string;
    tokensUpdated?: boolean;
  }) => {
    ipcRenderer.send('broadcast-theme-change', themeData);
  },
  openExternal: (url: string): Promise<OpenExternalUrlResult> => {
    return ipcRenderer.invoke('open-external', url);
  },
  getVersion: (): string => {
    return config.GOOSE_VERSION || ipcRenderer.sendSync('get-app-version') || '';
  },
  checkForUpdates: (): Promise<{ updateInfo: unknown; error: string | null }> => {
    return ipcRenderer.invoke('check-for-updates');
  },
  downloadUpdate: (): Promise<{ success: boolean; error: string | null }> => {
    return ipcRenderer.invoke('download-update');
  },
  installUpdate: (): void => {
    ipcRenderer.invoke('install-update');
  },
  restartApp: (): void => {
    ipcRenderer.send('restart-app');
  },
  onUpdaterEvent: (callback: (event: UpdaterEvent) => void): void => {
    ipcRenderer.on('updater-event', (_event, data) => callback(data));
  },
  getUpdateState: (): Promise<{ updateAvailable: boolean; latestVersion?: string } | null> => {
    return ipcRenderer.invoke('get-update-state');
  },
  isUsingGitHubFallback: (): Promise<boolean> => {
    return ipcRenderer.invoke('is-using-github-fallback');
  },
  getAutoDownloadDisabled: (): Promise<boolean> => {
    return ipcRenderer.invoke('get-auto-download-disabled');
  },
  closeWindow: () => ipcRenderer.send('close-window'),
  hasAcceptedRecipeBefore: (recipe: Recipe) =>
    ipcRenderer.invoke('has-accepted-recipe-before', recipe),
  recordRecipeHash: (recipe: Recipe) => ipcRenderer.invoke('record-recipe-hash', recipe),
  openDirectoryInExplorer: (directoryPath: string) =>
    ipcRenderer.invoke('open-directory-in-explorer', directoryPath),
  launchApp: (app: GooseApp) => ipcRenderer.invoke('launch-app', app),
  refreshApp: (app: GooseApp) => ipcRenderer.invoke('refresh-app', app),
  closeApp: (appName: string) => ipcRenderer.invoke('close-app', appName),
  addRecentDir: (dir: string) => ipcRenderer.invoke('add-recent-dir', dir),
  listRecentDirs: () => ipcRenderer.invoke('list-recent-dirs'),
  listGitWorktreeDirs: (dir: string) => ipcRenderer.invoke('list-git-worktree-dirs', dir),
  getGitBranchInfo: (dir: string) => ipcRenderer.invoke('get-git-branch-info', dir),
  listGitBranches: (dir: string) => ipcRenderer.invoke('list-git-branches', dir),
  switchGitBranch: (dir: string, branch: string) =>
    ipcRenderer.invoke('switch-git-branch', dir, branch),
};

function getAppLocale(): unknown {
  try {
    return ipcRenderer.sendSync('get-app-locale') ?? config.GOOSE_LOCALE;
  } catch {
    return config.GOOSE_LOCALE;
  }
}

const appConfigAPI: AppConfigAPI = {
  get: (key: string) => (key === 'GOOSE_LOCALE' ? getAppLocale() : config[key]),
  getAll: () => ({ ...config, GOOSE_LOCALE: getAppLocale() }),
};

// Expose the APIs
contextBridge.exposeInMainWorld('electron', electronAPI);
contextBridge.exposeInMainWorld('appConfig', appConfigAPI);

// Type declaration for TypeScript
declare global {
  interface Window {
    electron: ElectronAPI;
    appConfig: AppConfigAPI;
  }
}

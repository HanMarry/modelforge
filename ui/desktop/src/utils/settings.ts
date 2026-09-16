export type RecentModel = {
  provider: string;
  model: string;
};

export interface ExternalBackendConfig {
  enabled: boolean;
  url: string;
  secret: string;
  certFingerprint?: string;
  workingDir?: string;
}

/**
 * Agent kernel selection. `builtin` is goose's own agent loop (the app's default),
 * the other two run an external CLI agent (Claude Code / Codex) that reaches the
 * provider the user configured here through an in-app shape shim.
 */
export type AgentKernelId = 'builtin' | 'claude-code' | 'codex';

export interface AgentKernelSettings {
  runtime: AgentKernelId;
  /** Provider whose endpoint/model the kernel reuses; empty means the active provider. */
  providerId: string;
  /** Endpoint override; empty means "take it from the provider". */
  baseUrl: string;
  /** Model override; empty means "take it from the provider". */
  model: string;
  /** Provider/model to restore when the user switches back to the built-in kernel. */
  builtinProviderId: string;
  builtinModel: string;
  /** Optional per-1M-token prices, used to estimate what the kernel spends on your model. */
  inputTokenCost: number | null;
  outputTokenCost: number | null;
  currency: string;
  /**
   * Context window per model name, for providers that do not declare one (or declare a wrong
   * one). Takes precedence over the provider configuration.
   */
  contextLimits: Record<string, number>;
}

export interface KeyboardShortcuts {
  focusWindow: string | null;
  quickLauncher: string | null;
  newChat: string | null;
  newChatWindow: string | null;
  openDirectory: string | null;
  settings: string | null;
  find: string | null;
  findNext: string | null;
  findPrevious: string | null;
  alwaysOnTop: string | null;
  toggleNavigation: string | null;
}

export type DefaultKeyboardShortcuts = {
  [K in keyof KeyboardShortcuts]: string;
};

// prettier-ignore
export type LanguageSetting =
  | 'system' | 'en' | 'es' | 'fr' | 'de' | 'it' | 'pt' | 'id' | 'ms' | 'vi'
  | 'hi' | 'ja' | 'ko' | 'ru' | 'tr' | 'zh-CN' | 'zh-TW';

export interface Settings {
  // Desktop app settings
  showMenuBarIcon: boolean;
  disableAutoDownload: boolean;
  showDockIcon: boolean;
  enableWakelock: boolean;
  enableNotifications: boolean;
  spellcheckEnabled: boolean;
  // Key is kept as `externalGoosed` for backward compat with persisted user settings.
  externalGoosed: ExternalBackendConfig;
  agentKernel: AgentKernelSettings;
  globalShortcut?: string | null;
  keyboardShortcuts: KeyboardShortcuts;

  // UI preferences (migrated from localStorage)
  theme: 'dark' | 'light' | 'aura';
  useSystemTheme: boolean;
  language: LanguageSetting;
  responseStyle: string;
  showPricing: boolean;
  seenAnnouncementIds: string[];
  recentModels: RecentModel[];
}

export type SettingKey = keyof Settings;

export const defaultKeyboardShortcuts: DefaultKeyboardShortcuts = {
  focusWindow: 'CommandOrControl+Alt+G',
  quickLauncher: 'CommandOrControl+Alt+Shift+G',
  newChat: 'CommandOrControl+T',
  newChatWindow: 'CommandOrControl+N',
  openDirectory: 'CommandOrControl+O',
  settings: 'CommandOrControl+,',
  find: 'CommandOrControl+F',
  findNext: 'CommandOrControl+G',
  findPrevious: 'CommandOrControl+Shift+G',
  alwaysOnTop: 'CommandOrControl+Shift+T',
  toggleNavigation: 'CommandOrControl+/',
};

export const defaultAgentKernel: AgentKernelSettings = {
  runtime: 'builtin',
  providerId: '',
  baseUrl: '',
  model: '',
  builtinProviderId: '',
  builtinModel: '',
  inputTokenCost: null,
  outputTokenCost: null,
  currency: '¥',
  contextLimits: {},
};

export const defaultSettings: Settings = {
  // Desktop app settings
  showMenuBarIcon: true,
  disableAutoDownload: false,
  showDockIcon: true,
  enableWakelock: false,
  enableNotifications: true,
  spellcheckEnabled: true,
  keyboardShortcuts: defaultKeyboardShortcuts,
  externalGoosed: {
    enabled: false,
    url: '',
    secret: '',
  },
  agentKernel: { ...defaultAgentKernel },

  // UI preferences
  theme: 'light',
  useSystemTheme: true,
  language: 'system',
  responseStyle: 'concise',
  showPricing: true,
  seenAnnouncementIds: [],
  recentModels: [],
};

export function getKeyboardShortcuts(settings: Settings): KeyboardShortcuts {
  if (!settings.keyboardShortcuts && settings.globalShortcut !== undefined) {
    const focusShortcut = settings.globalShortcut;
    let launcherShortcut: string | null = null;

    if (focusShortcut) {
      if (focusShortcut.includes('Shift')) {
        launcherShortcut = focusShortcut;
      } else {
        launcherShortcut = focusShortcut.replace(/\+([Gg])$/, '+Shift+$1');
      }
    }

    return {
      ...defaultKeyboardShortcuts,
      focusWindow: focusShortcut,
      quickLauncher: launcherShortcut,
    };
  }
  return { ...defaultKeyboardShortcuts, ...settings.keyboardShortcuts };
}

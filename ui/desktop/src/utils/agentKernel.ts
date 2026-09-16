/**
 * Agent kernel orchestration for the desktop app.
 *
 * The user configures a provider (endpoint + key) once in the app. When they pick an
 * external kernel (Claude Code / Codex), this module resolves that provider, starts the
 * matching in-app shape shim and hands the kernel the environment it needs. The built-in
 * kernel stays the default and is left completely untouched.
 *
 * Secrets never come back out of goose (the ACP surface masks them), so the app keeps its
 * own encrypted copy of the provider key. It is captured when the user saves a provider
 * key in the app UI, or entered directly in the kernel settings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { provisionAgentRuntime, type ProvisionedAgentRuntime } from './agentRuntime';
import { setAgentRuntimeEnv } from '../gooseServe';
import {
  listCustomProviders,
  readGooseProviderState,
  readSecretFromFile,
  resolveGooseConfigDir,
  type GooseProviderState,
} from './gooseProviderState';
import type { AgentKernelId, AgentKernelSettings } from './settings';

export {
  listCustomProviders,
  readGooseProviderState,
  resolveGooseConfigDir,
  type GooseProviderState,
};

export interface AgentKernelSecretCodec {
  encode: (plaintext: string) => string;
  decode: (stored: string) => string | null;
}

export interface AgentKernelSecretStore {
  get: (id: string) => string | null;
  set: (id: string, value: string) => void;
  delete: (id: string) => void;
  has: (id: string) => boolean;
}

export type AgentKernelKeySource = 'kernel' | 'provider' | 'env' | 'none';

export interface AgentKernelStatus {
  runtime: AgentKernelId;
  providerId: string;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  apiKeySource: AgentKernelKeySource;
  shimUrl: string | null;
  configDir: string | null;
  error: string | null;
  /**
   * Context window of the model the kernel proxies to. The kernel reports its own window
   * (Claude Code's, for instance), which says nothing about the model actually serving the
   * request — the app clamps its context indicator to this value.
   */
  contextLimit: number | null;
  /** Where `contextLimit` came from, so the UI can explain an unknown window. */
  contextLimitSource: AgentKernelContextLimitSource;
  /** True when a change (kernel switch) still needs the app to restart to take effect. */
  restartRequired: boolean;
}

export type AgentKernelContextLimitSource = 'override' | 'provider' | 'unknown';

export interface AgentKernelManager {
  /** Resolves settings and (re)starts the shim + env injection for the selected kernel. */
  apply: (settings: AgentKernelSettings) => Promise<AgentKernelStatus>;
  /**
   * Applies settings changes to a kernel that is already provisioned, without restarting the
   * shim underneath the running backend. A kernel switch cannot be applied this way and is
   * reported through `restartRequired`. When an external kernel is selected but nothing is
   * running (the first attempt failed on a missing key), the full apply runs again so a key
   * saved afterwards takes effect without restarting the app.
   */
  refresh: (settings: AgentKernelSettings) => Promise<AgentKernelStatus>;
  getStatus: () => AgentKernelStatus;
  /** Switches the model the kernel proxies to, without restarting it. */
  setModel: (model: string) => AgentKernelStatus;
  /** Remembers a provider key captured from the app's provider settings. */
  rememberProviderKey: (providerId: string, apiKey: string) => void;
  setKernelKey: (providerId: string, apiKey: string) => void;
  clearKernelKey: (providerId: string) => void;
  forgetProviderKey: (providerId: string) => void;
  dispose: () => Promise<void>;
}

export interface AgentKernelManagerOptions {
  /** Directory for generated per-runtime config directories. */
  runtimeRoot: string;
  secretsFile: string;
  codec: AgentKernelSecretCodec;
  gooseConfigDir: string;
  log?: (message: string) => void;
  provision?: (
    selection: Parameters<typeof provisionAgentRuntime>[0],
    rootDir: string,
    onLog?: (message: string) => void
  ) => Promise<ProvisionedAgentRuntime>;
  env?: Record<string, string | undefined>;
}

export const BUILTIN_KERNEL_PROVIDER = 'builtin';

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function createAgentKernelSecretStore(
  file: string,
  codec: AgentKernelSecretCodec
): AgentKernelSecretStore {
  const read = (): Record<string, string> => readJsonFile<Record<string, string>>(file) ?? {};

  const write = (values: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(values, null, 2), { encoding: 'utf8', mode: 0o600 });
  };

  return {
    get: (id) => {
      const stored = read()[id];
      if (!stored) {
        return null;
      }
      return codec.decode(stored);
    },
    set: (id, value) => {
      const values = read();
      values[id] = codec.encode(value);
      write(values);
    },
    delete: (id) => {
      const values = read();
      if (!(id in values)) {
        return;
      }
      delete values[id];
      write(values);
    },
    has: (id) => Boolean(read()[id]),
  };
}

const providerKeyId = (providerId: string): string => `provider:${providerId}`;
const kernelKeyId = (providerId: string): string => `kernel:${providerId}`;

export function createAgentKernelManager({
  runtimeRoot,
  secretsFile,
  codec,
  gooseConfigDir,
  log = () => {},
  provision = provisionAgentRuntime,
  env = process.env,
}: AgentKernelManagerOptions): AgentKernelManager {
  const secrets = createAgentKernelSecretStore(secretsFile, codec);
  let active: ProvisionedAgentRuntime | null = null;
  let status: AgentKernelStatus = {
    runtime: 'builtin',
    providerId: '',
    baseUrl: '',
    model: '',
    apiKeyEnv: '',
    apiKeySource: 'none',
    shimUrl: null,
    configDir: null,
    error: null,
    contextLimit: null,
    contextLimitSource: 'unknown',
    restartRequired: false,
  };

  let currentSettings: AgentKernelSettings | null = null;
  /** The key the running shim was provisioned with, so a replacement can be pushed live. */
  let provisionedKey = '';

  /**
   * The window belongs to the model, so it is resolved per model name: an explicit override
   * wins, then whatever the provider declares for that model, else unknown (the UI then falls
   * back to goose's own model catalogue).
   */
  const resolveContextLimit = (
    providerId: string,
    model: string,
    settings: AgentKernelSettings | null
  ): { limit: number | null; source: AgentKernelContextLimitSource } => {
    const override = settings?.contextLimits?.[model];
    if (typeof override === 'number' && override > 0) {
      return { limit: override, source: 'override' };
    }
    const declared = readGooseProviderState(gooseConfigDir, providerId).modelLimits[model];
    if (typeof declared === 'number' && declared > 0) {
      return { limit: declared, source: 'provider' };
    }
    return { limit: null, source: 'unknown' };
  };

  const resolveKey = (
    providerId: string,
    apiKeyEnv: string
  ): { apiKey: string; source: AgentKernelKeySource } => {
    const kernelKey = providerId ? secrets.get(kernelKeyId(providerId)) : null;
    if (kernelKey) {
      return { apiKey: kernelKey, source: 'kernel' };
    }
    const providerKey = providerId ? secrets.get(providerKeyId(providerId)) : null;
    if (providerKey) {
      return { apiKey: providerKey, source: 'provider' };
    }
    if (apiKeyEnv && env[apiKeyEnv]) {
      return { apiKey: env[apiKeyEnv] as string, source: 'env' };
    }
    if (apiKeyEnv) {
      // Last resort only: goose keeps provider secrets in the OS credential store by default,
      // so secrets.yaml exists just when the keyring is disabled (GOOSE_DISABLE_KEYRING=1).
      // When neither an in-app copy nor an environment value is present the kernel stays
      // unprovisioned until the user enters the key for it in the app.
      const fileKey = readSecretFromFile(path.join(gooseConfigDir, 'secrets.yaml'), apiKeyEnv);
      if (fileKey) {
        return { apiKey: fileKey, source: 'env' };
      }
    }
    return { apiKey: '', source: 'none' };
  };

  const disposeActive = async (): Promise<void> => {
    if (!active) {
      return;
    }
    const previous = active;
    active = null;
    setAgentRuntimeEnv({});
    try {
      await previous.dispose();
    } catch (error) {
      log(`failed to dispose agent runtime: ${String(error)}`);
    }
  };

  /**
   * The kernel's own ACP provider becomes goose's active provider, so the API the external
   * kernel proxies to is resolved from the user's own provider instead: an explicit choice,
   * then the provider remembered for the built-in kernel, then whatever carries an endpoint.
   */
  const resolveProvider = (settings: AgentKernelSettings): GooseProviderState => {
    const candidates = [
      settings.providerId.trim(),
      settings.builtinProviderId.trim(),
      readGooseProviderState(gooseConfigDir).activeProvider,
      ...listCustomProviders(gooseConfigDir).map((provider) => provider.activeProvider),
    ].filter(Boolean);

    for (const candidate of candidates) {
      const state = readGooseProviderState(gooseConfigDir, candidate);
      if (state.baseUrl) {
        return state;
      }
    }

    return readGooseProviderState(gooseConfigDir, candidates[0] ?? '');
  };

  const apply = async (settings: AgentKernelSettings): Promise<AgentKernelStatus> => {
    await disposeActive();
    currentSettings = settings;

    const goose = resolveProvider(settings);
    const providerId = goose.activeProvider;
    const baseUrl = settings.baseUrl.trim() || goose.baseUrl;
    const model = settings.model.trim() || goose.model;
    const { apiKey, source } = resolveKey(providerId, goose.apiKeyEnv);
    const window = resolveContextLimit(providerId, model, settings);

    status = {
      runtime: settings.runtime,
      providerId,
      baseUrl,
      model,
      apiKeyEnv: goose.apiKeyEnv,
      apiKeySource: source,
      shimUrl: null,
      configDir: null,
      error: null,
      contextLimit: window.limit,
      contextLimitSource: window.source,
      restartRequired: false,
    };

    if (settings.runtime === 'builtin') {
      log('agent kernel: built-in');
      setAgentRuntimeEnv({});
      return status;
    }

    if (!baseUrl || !model || !apiKey) {
      const missing = [
        !baseUrl ? 'API 地址' : '',
        !model ? '模型' : '',
        !apiKey ? 'API Key' : '',
      ].filter(Boolean);
      status.error = `内核未启动：缺少 ${missing.join('、')}`;
      log(`agent kernel: ${status.error}`);
      setAgentRuntimeEnv({});
      return status;
    }

    try {
      active = await provision(
        {
          runtime: settings.runtime,
          baseUrl,
          apiKey,
          model,
          contextLimit: status.contextLimit,
        },
        runtimeRoot,
        (message) => log(`[shim] ${message}`)
      );
      provisionedKey = apiKey;
      setAgentRuntimeEnv(active.env);
      status.shimUrl = active.shimUrl ?? null;
      status.configDir = active.configDir ?? null;
      log(`agent kernel: ${settings.runtime} → ${status.shimUrl} (model=${model})`);
    } catch (error) {
      status.error = `内核启动失败：${error instanceof Error ? error.message : String(error)}`;
      log(`agent kernel: ${status.error}`);
      setAgentRuntimeEnv({});
    }

    return status;
  };

  /**
   * Settings edits while the app runs. The shim keeps its port (goose serve captured the URL at
   * spawn time), so a new key or model is pushed into the running shim and only a kernel switch
   * asks for a restart.
   */
  const refresh = async (settings: AgentKernelSettings): Promise<AgentKernelStatus> => {
    currentSettings = settings;

    if (settings.runtime !== status.runtime) {
      status.restartRequired = true;
      log(`agent kernel: kernel switched to ${settings.runtime} — restart the app to provision it`);
      return { ...status };
    }

    // Nothing is running although an external kernel is selected — typically the first
    // provisioning failed on a missing key. Re-run the full apply so a key saved afterwards
    // (or any other fix) takes effect without restarting the app.
    if (settings.runtime !== 'builtin' && !active) {
      return apply(settings);
    }

    const goose = resolveProvider(settings);
    const providerId = goose.activeProvider;
    const model = settings.model.trim() || goose.model;
    const { apiKey, source } = resolveKey(providerId, goose.apiKeyEnv);
    const window = resolveContextLimit(providerId, model, settings);

    if (active?.setModel && model && model !== status.model) {
      active.setModel(model);
      log(`agent kernel: upstream model switched to ${model}`);
    }
    if (active?.setApiKey && apiKey && apiKey !== provisionedKey) {
      active.setApiKey(apiKey);
      provisionedKey = apiKey;
    }

    status = {
      ...status,
      providerId,
      baseUrl: settings.baseUrl.trim() || goose.baseUrl,
      model,
      apiKeyEnv: goose.apiKeyEnv,
      apiKeySource: source,
      contextLimit: window.limit,
      contextLimitSource: window.source,
      restartRequired: false,
      error: null,
    };
    return { ...status };
  };

  return {
    apply,
    refresh,
    getStatus: () => ({ ...status }),
    setModel: (model) => {
      const trimmed = model.trim();
      if (!trimmed || trimmed === status.model) {
        return { ...status };
      }
      if (!active?.setModel) {
        status.error = '内核未运行，无法切换模型';
        log(`agent kernel: ${status.error}`);
        return { ...status };
      }
      active.setModel(trimmed);
      status.model = trimmed;
      status.error = null;
      const window = resolveContextLimit(status.providerId, trimmed, currentSettings);
      status.contextLimit = window.limit;
      status.contextLimitSource = window.source;
      log(`agent kernel: upstream model switched to ${trimmed}`);
      return { ...status };
    },
    rememberProviderKey: (providerId, apiKey) => {
      if (!providerId) {
        return;
      }
      if (apiKey) {
        secrets.set(providerKeyId(providerId), apiKey);
      } else {
        secrets.delete(providerKeyId(providerId));
      }
    },
    setKernelKey: (providerId, apiKey) => {
      if (!providerId || !apiKey) {
        return;
      }
      secrets.set(kernelKeyId(providerId), apiKey);
    },
    clearKernelKey: (providerId) => {
      if (providerId) {
        secrets.delete(kernelKeyId(providerId));
      }
    },
    forgetProviderKey: (providerId) => secrets.delete(providerKeyId(providerId)),
    dispose: disposeActive,
  };
}

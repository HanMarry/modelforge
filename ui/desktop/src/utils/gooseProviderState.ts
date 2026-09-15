/**
 * Reads what the user configured in goose itself (active provider, model, endpoint, key
 * variable) straight from goose's config directory. The desktop app needs this to point an
 * external agent kernel at the same API the built-in kernel uses.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface GooseProviderState {
  activeProvider: string;
  /** Model configured for the active provider in goose's config.yaml. */
  model: string;
  /** Endpoint declared by the provider (custom providers store it next to config.yaml). */
  baseUrl: string;
  /** Environment variable name goose reads the provider key from. */
  apiKeyEnv: string;
  /** Context window per model, when the provider declares one. */
  modelLimits: Record<string, number>;
}

interface CustomProviderFile {
  base_url?: string;
  api_url?: string;
  api_key_env?: string;
  models?: { name?: string; context_limit?: number | null }[];
}

/** goose's config directory: `<GOOSE_PATH_ROOT>/config`, else the platform default. */
export function resolveGooseConfigDir(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = os.homedir()
): string {
  const pathRoot = env.GOOSE_PATH_ROOT?.trim();
  if (pathRoot) {
    return path.join(pathRoot, 'config');
  }
  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Block', 'goose', 'config');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Block', 'goose', 'config');
  }
  const xdg = env.XDG_CONFIG_HOME?.trim() || path.join(home, '.config');
  return path.join(xdg, 'goose', 'config');
}

function topLevelValue(config: string, key: string): string | null {
  const match = config.match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'));
  if (!match) {
    return null;
  }
  return match[1].trim().replace(/^["']|["']$/g, '') || null;
}

/** Model configured for one provider inside the `providers:` block of config.yaml. */
export function providerModelFromConfig(config: string, providerId: string): string | null {
  const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const block = config.match(
    new RegExp(`^\\s{2}${escaped}\\s*:\\s*[^\\n]*\\n([\\s\\S]*?)(?=^\\s{2}\\S|^\\S|$)`, 'm')
  );
  if (!block) {
    return null;
  }
  const model = block[1].match(/^\s+model\s*:\s*(.+)$/m);
  return model ? model[1].trim().replace(/^["']|["']$/g, '') || null : null;
}

function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function customProviderState(configDir: string, providerId: string): GooseProviderState | null {
  const custom = readJsonFile<CustomProviderFile>(
    path.join(configDir, 'custom_providers', `${providerId}.json`)
  );
  if (!custom) {
    return null;
  }
  return {
    activeProvider: providerId,
    model: custom.models?.[0]?.name ?? '',
    baseUrl: custom.base_url ?? custom.api_url ?? '',
    apiKeyEnv: custom.api_key_env ?? '',
    modelLimits: modelLimitsOf(custom),
  };
}

function modelLimitsOf(custom: CustomProviderFile): Record<string, number> {
  const limits: Record<string, number> = {};
  for (const model of custom.models ?? []) {
    if (model?.name && typeof model.context_limit === 'number' && model.context_limit > 0) {
      limits[model.name] = model.context_limit;
    }
  }
  return limits;
}

/**
 * Reads the endpoint/model/key-env configured for one provider, defaulting to goose's active
 * provider. Pass an id when the active provider is not the one carrying the user's API (an
 * external agent kernel makes its own ACP provider active).
 */
export function readGooseProviderState(configDir: string, providerId?: string): GooseProviderState {
  const empty: GooseProviderState = {
    activeProvider: providerId ?? '',
    model: '',
    baseUrl: '',
    apiKeyEnv: '',
    modelLimits: {},
  };

  let config: string;
  try {
    config = fs.readFileSync(path.join(configDir, 'config.yaml'), 'utf8');
  } catch {
    return empty;
  }

  const resolvedId = providerId?.trim() || topLevelValue(config, 'active_provider') || '';
  if (!resolvedId) {
    return empty;
  }

  const custom = customProviderState(configDir, resolvedId);

  return {
    activeProvider: resolvedId,
    model: providerModelFromConfig(config, resolvedId) ?? custom?.model ?? '',
    baseUrl: custom?.baseUrl ?? '',
    apiKeyEnv: custom?.apiKeyEnv ?? '',
    modelLimits: custom?.modelLimits ?? {},
  };
}

/** Every provider the user added themselves, i.e. the ones carrying their own endpoint. */
export function listCustomProviders(configDir: string): GooseProviderState[] {
  let files: string[];
  try {
    files = fs.readdirSync(path.join(configDir, 'custom_providers'));
  } catch {
    return [];
  }

  return files
    .filter((file) => file.endsWith('.json'))
    .map((file) => customProviderState(configDir, path.basename(file, '.json')))
    .filter((state): state is GooseProviderState => Boolean(state?.baseUrl));
}

/** Minimal `KEY: value` reader for goose's file-based secret store. */
export function readSecretFromFile(file: string, key: string): string | null {
  let contents: string;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const match = contents.match(new RegExp(`^\\s*["']?${key}["']?\\s*:\\s*(.+)$`, 'm'));
  if (!match) {
    return null;
  }
  const value = match[1].trim().replace(/^["']|["']$/g, '');
  return value || null;
}

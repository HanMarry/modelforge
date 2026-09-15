import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAgentKernelManager,
  createAgentKernelSecretStore,
  type AgentKernelSecretCodec,
} from './agentKernel';
import {
  readGooseProviderState,
  resolveGooseConfigDir,
  listCustomProviders,
} from './gooseProviderState';
import type { AgentKernelSettings } from './settings';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-kernel-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
});

const codec: AgentKernelSecretCodec = {
  encode: (plaintext) => `enc:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
  decode: (stored) =>
    stored.startsWith('enc:') ? Buffer.from(stored.slice(4), 'base64').toString('utf8') : null,
};

const kernelSettings = (overrides: Partial<AgentKernelSettings> = {}): AgentKernelSettings => ({
  runtime: 'claude-code',
  providerId: '',
  baseUrl: '',
  model: '',
  builtinProviderId: '',
  builtinModel: '',
  inputTokenCost: null,
  outputTokenCost: null,
  currency: '¥',
  contextLimits: {},
  ...overrides,
});

function writeGooseConfig(dir: string, activeProvider = 'custom_deepseek'): void {
  fs.mkdirSync(path.join(dir, 'custom_providers'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.yaml'),
    [
      'extensions:',
      '  developer:',
      '    enabled: true',
      `active_provider: ${activeProvider}`,
      'providers:',
      '  custom_deepseek:',
      '    enabled: true',
      '    model: deepseek-flash',
      '    configured: true',
      '  codex-acp:',
      '    enabled: true',
      '    model: current',
      '    configured: true',
      'GOOSE_THINKING_EFFORT: high',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(dir, 'custom_providers', 'custom_deepseek.json'),
    JSON.stringify({
      name: 'custom_deepseek',
      api_key_env: 'DEEPSEEK_API_KEY',
      base_url: 'https://api.deepseek.com',
      models: [{ name: 'deepseek-flash', context_limit: 128000 }],
    })
  );
}

/** Rewrites the provider's declared windows; `null` leaves the model without one. */
function writeProviderLimits(dir: string, limits: Record<string, number | null>): void {
  const file = path.join(dir, 'custom_providers', 'custom_deepseek.json');
  const provider = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    models: { name: string; context_limit?: number | null }[];
  };
  provider.models = provider.models.map((model) =>
    model.name in limits
      ? { ...model, context_limit: limits[model.name] }
      : { ...model, context_limit: null }
  );
  fs.writeFileSync(file, JSON.stringify(provider));
}

describe('resolveGooseConfigDir', () => {
  it('honours GOOSE_PATH_ROOT', () => {
    expect(
      resolveGooseConfigDir({ GOOSE_PATH_ROOT: 'C:\\goose-root' }, 'win32', 'C:\\Users\\me')
    ).toBe(path.join('C:\\goose-root', 'config'));
  });

  it('falls back to the platform default', () => {
    expect(
      resolveGooseConfigDir(
        { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
        'win32',
        'C:\\Users\\me'
      )
    ).toBe(path.join('C:\\Users\\me\\AppData\\Roaming', 'Block', 'goose', 'config'));
    expect(resolveGooseConfigDir({}, 'linux', '/home/me')).toBe(
      path.join('/home/me', '.config', 'goose', 'config')
    );
  });
});

describe('readGooseProviderState', () => {
  it('reads the active provider, model, endpoint and key variable', () => {
    const dir = tempDir();
    writeGooseConfig(dir);

    expect(readGooseProviderState(dir)).toEqual({
      activeProvider: 'custom_deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      modelLimits: { 'deepseek-flash': 128000 },
    });
  });

  it('returns an empty state when goose has no configuration', () => {
    expect(readGooseProviderState(tempDir())).toEqual({
      activeProvider: '',
      model: '',
      baseUrl: '',
      apiKeyEnv: '',
      modelLimits: {},
    });
  });

  it('reads a named provider even when an ACP provider is active', () => {
    const dir = tempDir();
    writeGooseConfig(dir, 'codex-acp');

    expect(readGooseProviderState(dir, 'custom_deepseek')).toEqual({
      activeProvider: 'custom_deepseek',
      model: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      modelLimits: { 'deepseek-flash': 128000 },
    });
  });

  it('lists the providers that carry the user own endpoint', () => {
    const dir = tempDir();
    writeGooseConfig(dir, 'codex-acp');

    expect(listCustomProviders(dir).map((provider) => provider.activeProvider)).toEqual([
      'custom_deepseek',
    ]);
  });
});

describe('agent kernel secrets', () => {
  it('stores values through the codec and never in plaintext', () => {
    const file = path.join(tempDir(), 'nested', 'secrets.json');
    const store = createAgentKernelSecretStore(file, codec);

    store.set('provider:custom_deepseek', 'sk-secret');

    expect(fs.readFileSync(file, 'utf8')).not.toContain('sk-secret');
    expect(store.get('provider:custom_deepseek')).toBe('sk-secret');
    expect(store.has('provider:custom_deepseek')).toBe(true);

    store.delete('provider:custom_deepseek');
    expect(store.get('provider:custom_deepseek')).toBeNull();
  });
});

describe('createAgentKernelManager', () => {
  const makeManager = (
    options: { apiKeyEnv?: Record<string, string | undefined>; activeProvider?: string } = {}
  ) => {
    const configDir = tempDir();
    writeGooseConfig(configDir, options.activeProvider);
    const setModel = vi.fn();
    const provision = vi.fn(async (selection: { runtime: string }) => ({
      runtime: selection.runtime as 'claude-code',
      env: { CLAUDE_CONFIG_DIR: 'C:\\runtime\\claude' },
      shimUrl: 'http://127.0.0.1:9',
      configDir: 'C:\\runtime\\claude',
      setModel,
      dispose: vi.fn(async () => {}),
    }));

    return {
      configDir,
      provision,
      setModel,
      manager: createAgentKernelManager({
        runtimeRoot: tempDir(),
        secretsFile: path.join(tempDir(), 'secrets.json'),
        codec,
        gooseConfigDir: configDir,
        provision: provision as never,
        env: options.apiKeyEnv ?? {},
      }),
    };
  };

  it('switches the upstream model without restarting the kernel', async () => {
    const { manager, provision, setModel } = makeManager({
      apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' },
    });
    await manager.apply(kernelSettings());

    const status = manager.setModel('deepseek-reasoner');

    expect(setModel).toHaveBeenCalledWith('deepseek-reasoner');
    expect(status.model).toBe('deepseek-reasoner');
    expect(status.error).toBeNull();
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it('takes the context window from the provider, per model', async () => {
    const { manager, configDir } = makeManager({ apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' } });
    writeProviderLimits(configDir, { 'deepseek-flash': 128000 });

    const status = await manager.apply(kernelSettings());

    expect(status.contextLimit).toBe(128000);
    expect(status.contextLimitSource).toBe('provider');
  });

  it('prefers a window the user entered for that model', async () => {
    const { manager, configDir } = makeManager({ apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' } });
    writeProviderLimits(configDir, { 'deepseek-flash': 128000 });

    const status = await manager.apply(
      kernelSettings({ contextLimits: { 'deepseek-flash': 64_000 } })
    );

    expect(status.contextLimit).toBe(64_000);
    expect(status.contextLimitSource).toBe('override');
  });

  it('reports an unknown window instead of guessing', async () => {
    const { manager, configDir } = makeManager({ apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' } });
    writeProviderLimits(configDir, { 'deepseek-flash': null });

    const status = await manager.apply(kernelSettings());

    expect(status.contextLimit).toBeNull();
    expect(status.contextLimitSource).toBe('unknown');
  });

  it('explains that a stopped kernel cannot switch models', async () => {
    const { manager } = makeManager();

    expect(manager.setModel('deepseek-reasoner').error).toContain('未运行');
  });

  it('leaves the built-in kernel alone', async () => {
    const { manager, provision } = makeManager();

    const status = await manager.apply(kernelSettings({ runtime: 'builtin' }));

    expect(provision).not.toHaveBeenCalled();
    expect(status.runtime).toBe('builtin');
    expect(status.error).toBeNull();
  });

  it('skips the kernel ACP provider and reuses the provider remembered for the built-in kernel', async () => {
    const { manager, provision } = makeManager({
      activeProvider: 'codex-acp',
      apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' },
    });

    const status = await manager.apply(
      kernelSettings({ runtime: 'codex', builtinProviderId: 'custom_deepseek' })
    );

    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'codex', baseUrl: 'https://api.deepseek.com' }),
      expect.any(String),
      expect.any(Function)
    );
    expect(status.providerId).toBe('custom_deepseek');
    expect(status.error).toBeNull();
  });

  it('falls back to the user own provider when nothing was remembered', async () => {
    const { manager } = makeManager({
      activeProvider: 'codex-acp',
      apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' },
    });

    const status = await manager.apply(kernelSettings({ runtime: 'codex' }));

    expect(status.providerId).toBe('custom_deepseek');
    expect(status.baseUrl).toBe('https://api.deepseek.com');
  });

  it('provisions the external kernel from the provider the user configured', async () => {
    const { manager, provision } = makeManager();
    manager.rememberProviderKey('custom_deepseek', 'sk-captured');

    const status = await manager.apply(kernelSettings());

    // objectContaining: the selection grows as the runtime gains needs (e.g. the model's
    // context window, used to phrase the identity prompt).
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: 'claude-code',
        baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-flash',
        apiKey: 'sk-captured',
      }),
      expect.any(String),
      expect.any(Function)
    );
    expect(status.apiKeySource).toBe('provider');
    expect(status.shimUrl).toBe('http://127.0.0.1:9');
    expect(status.error).toBeNull();
  });

  it('prefers a key entered for the kernel over the captured provider key', async () => {
    const { manager } = makeManager();
    manager.rememberProviderKey('custom_deepseek', 'sk-provider');
    manager.setKernelKey('custom_deepseek', 'sk-kernel');

    const status = await manager.apply(kernelSettings());

    expect(status.apiKeySource).toBe('kernel');
  });

  it('falls back to the provider key variable in the environment', async () => {
    const { manager } = makeManager({ apiKeyEnv: { DEEPSEEK_API_KEY: 'sk-env' } });

    const status = await manager.apply(kernelSettings());

    expect(status.apiKeySource).toBe('env');
  });

  it('explains what is missing instead of starting a half-configured kernel', async () => {
    const { manager, provision } = makeManager();

    const status = await manager.apply(kernelSettings());

    expect(provision).not.toHaveBeenCalled();
    expect(status.error).toContain('API Key');
  });

  it('reports provisioning failures without breaking the app', async () => {
    const configDir = tempDir();
    writeGooseConfig(configDir);
    const manager = createAgentKernelManager({
      runtimeRoot: tempDir(),
      secretsFile: path.join(tempDir(), 'secrets.json'),
      codec,
      gooseConfigDir: configDir,
      provision: (async () => {
        throw new Error('shim port busy');
      }) as never,
      env: { DEEPSEEK_API_KEY: 'sk-env' },
    });

    const status = await manager.apply(kernelSettings());

    expect(status.error).toContain('shim port busy');
    expect(status.shimUrl).toBeNull();
  });

  it('persists kernel key across manager recreation', async () => {
    const configDir = tempDir();
    const secretsFile = path.join(tempDir(), 'secrets.json');
    writeGooseConfig(configDir);

    const manager1 = createAgentKernelManager({
      runtimeRoot: tempDir(),
      secretsFile,
      codec,
      gooseConfigDir: configDir,
      provision: vi.fn().mockResolvedValue({ env: {}, shimUrl: 'http://127.0.0.1:9' }),
      env: {},
    });

    manager1.setKernelKey('custom_deepseek', 'sk-test-key');
    await manager1.dispose();

    const manager2 = createAgentKernelManager({
      runtimeRoot: tempDir(),
      secretsFile,
      codec,
      gooseConfigDir: configDir,
      provision: vi.fn().mockResolvedValue({ env: {}, shimUrl: 'http://127.0.0.1:9' }),
      env: {},
    });

    const status = await manager2.apply(kernelSettings());

    expect(status.apiKeySource).toBe('kernel');
    expect(status.error).toBeNull();
  });

  it('rejects setKernelKey when providerId is empty', async () => {
    const { manager } = makeManager();

    manager.setKernelKey('', 'sk-test-key');

    const status = await manager.apply(kernelSettings());

    expect(status.apiKeySource).toBe('none');
  });
});

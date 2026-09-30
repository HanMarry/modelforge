import { describe, expect, it, vi } from 'vitest';
import type { ConfigKey, ProviderDetails } from '../../types/providers';
import type { CredentialSaveResult } from '../../utils/credentialIpc';
import { errorMessage } from '../../utils/conversionUtils';
import {
  apiKeyField,
  canConfigureInWizard,
  endpointField,
  initialProviderInput,
  modelSuggestions,
  providerConfigFields,
  saveWizardProvider,
  type ProviderConfigField,
  type WizardSaveDeps,
} from './wizardProviderSetup';

function configKey(name: string, overrides: Partial<ConfigKey> = {}): ConfigKey {
  return {
    name,
    required: false,
    secret: false,
    default: null,
    oauth_flow: false,
    device_code_flow: false,
    primary: false,
    ...overrides,
  };
}

function provider(
  name: string,
  configKeys: ConfigKey[],
  overrides: Partial<ProviderDetails> = {}
): ProviderDetails {
  return {
    name,
    is_configured: false,
    is_available: true,
    visible_in_setup: true,
    deprecated: false,
    provider_type: 'Builtin',
    uses_acp: false,
    metadata: {
      name,
      display_name: name,
      description: '',
      default_model: `${name}-default`,
      model_doc_link: '',
      known_models: [],
      config_keys: configKeys,
    },
    ...overrides,
  };
}

const openaiBase = provider('openai', [
  configKey('OPENAI_API_KEY', { secret: true, primary: true }),
  configKey('OPENAI_BASE_URL'),
  configKey('OPENAI_HOST', { required: true, default: 'https://api.openai.com' }),
  configKey('OPENAI_BASE_PATH', { required: true, default: 'v1/chat/completions' }),
  configKey('OPENAI_ORGANIZATION'),
  configKey('OPENAI_CUSTOM_HEADERS', { secret: true }),
  configKey('OPENAI_TIMEOUT', { default: '600' }),
]);

/** The OpenAI provider as the kernel lists it (`goose-providers/src/openai.rs`). */
const openai: ProviderDetails = {
  ...openaiBase,
  metadata: {
    ...openaiBase.metadata,
    display_name: 'OpenAI',
    default_model: 'gpt-4o',
    known_models: [{ name: 'gpt-4o' }, { name: 'gpt-4.1' }, { name: 'gpt-4o' }],
  },
};

/** A declarative provider: a fixed endpoint and one key (`provider_registry.rs`). */
const deepseek = provider('custom_deepseek', [
  configKey('DEEPSEEK_API_KEY', { required: true, secret: true, primary: true }),
]);

const encrypted = async (): Promise<CredentialSaveResult> => ({
  ok: true,
  data: { outcome: 'encrypted' },
});

function acpError(data: string): Error {
  return Object.assign(new Error('Invalid params'), { data });
}

/**
 * The kernel side of a clean machine: nothing is configured, `providers/config/save` stores the
 * fields it gets, and `defaults/save` refuses a provider whose key it does not know
 * (`acp/server/config.rs`, `on_defaults_save`).
 */
function cleanKernel() {
  const config = new Map<string, string>();
  const defaults: { providerId: string | null; modelId: string | null } = {
    providerId: null,
    modelId: null,
  };
  const deps = {
    rememberKey: vi.fn(async (_providerId: string, _key: string) => encrypted()),
    saveProviderConfig: vi.fn(async (_providerId: string, fields: ProviderConfigField[]) => {
      for (const field of fields) {
        config.set(field.key, field.value);
      }
    }),
    saveDefaults: vi.fn(async (providerId: string, modelId: string) => {
      if (!config.has('OPENAI_API_KEY')) {
        throw acpError(`Provider is not configured: ${providerId}`);
      }
      defaults.providerId = providerId;
      defaults.modelId = modelId;
    }),
  } satisfies WizardSaveDeps;
  return { config, defaults, deps };
}

const stubInput = {
  address: ' http://127.0.0.1:47372/v1/ ',
  key: '  sk-wizard-key  ',
  model: 'stub-model',
};

describe('apiKeyField', () => {
  it('picks the primary secret and skips header maps', () => {
    expect(apiKeyField(openai)).toBe('OPENAI_API_KEY');
    expect(apiKeyField(deepseek)).toBe('DEEPSEEK_API_KEY');
  });

  it('finds no API key for sign-in and key-less providers', () => {
    const oauth = provider('chatgpt_codex', [
      configKey('CHATGPT_CODEX_TOKEN', { secret: true, oauth_flow: true, primary: true }),
    ]);
    const local = provider('ollama', [
      configKey('OLLAMA_HOST', { required: true, default: 'localhost' }),
    ]);
    expect(apiKeyField(oauth)).toBeNull();
    expect(apiKeyField(local)).toBeNull();
  });
});

describe('canConfigureInWizard', () => {
  it('accepts providers that need a key and nothing the wizard cannot fill in', () => {
    expect(canConfigureInWizard(openai)).toBe(true);
    expect(canConfigureInWizard(deepseek)).toBe(true);
  });

  it('leaves ACP agents, sign-in providers and providers with more required settings to the settings page', () => {
    const acp = provider('claude-acp', [], { uses_acp: true });
    const oauth = provider('github_copilot', [
      configKey('GITHUB_COPILOT_TOKEN', { required: true, secret: true, oauth_flow: true }),
    ]);
    const azure = provider('azure_openai', [
      configKey('AZURE_OPENAI_API_KEY', { secret: true, primary: true }),
      configKey('AZURE_OPENAI_ENDPOINT', { required: true }),
      configKey('AZURE_OPENAI_DEPLOYMENT_NAME', { required: true }),
    ]);
    expect(canConfigureInWizard(acp)).toBe(false);
    expect(canConfigureInWizard(oauth)).toBe(false);
    expect(canConfigureInWizard(azure)).toBe(false);
  });
});

describe('endpointField and initialProviderInput', () => {
  it('saves the address of the OpenAI provider as OPENAI_BASE_URL', () => {
    expect(endpointField(openai)).toEqual({
      key: 'OPENAI_BASE_URL',
      defaultAddress: 'https://api.openai.com/v1',
    });
    expect(initialProviderInput(openai)).toEqual({
      address: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });
  });

  it('saves no address for providers with a fixed endpoint, or when the key is not declared', () => {
    const olderOpenai = provider('openai', [configKey('OPENAI_API_KEY', { secret: true })]);
    expect(endpointField(deepseek)).toBeNull();
    expect(endpointField(olderOpenai)).toBeNull();
    expect(initialProviderInput(deepseek)).toEqual({ address: '', model: 'custom_deepseek-default' });
  });

  it('suggests the default model first, without duplicates', () => {
    expect(modelSuggestions(openai)).toEqual(['gpt-4o', 'gpt-4.1']);
  });
});

describe('providerConfigFields', () => {
  it('sends the trimmed key and the normalised address for OpenAI', () => {
    expect(providerConfigFields(openai, stubInput)).toEqual([
      { key: 'OPENAI_API_KEY', value: 'sk-wizard-key' },
      { key: 'OPENAI_BASE_URL', value: 'http://127.0.0.1:47372/v1' },
    ]);
  });

  it('sends only the key for a provider whose endpoint is fixed', () => {
    expect(providerConfigFields(deepseek, stubInput)).toEqual([
      { key: 'DEEPSEEK_API_KEY', value: 'sk-wizard-key' },
    ]);
  });
});

describe('saveWizardProvider on a clean machine', () => {
  it('reproduces the old failure: the kernel refuses a default provider it has no key for', async () => {
    const kernel = cleanKernel();

    const error = await kernel.deps.saveDefaults('openai', 'gpt-4o').catch((e: unknown) => e);

    expect(errorMessage(error)).toBe('Provider is not configured: openai');
  });

  it('stores the key, then configures the kernel, then makes the provider the default', async () => {
    const kernel = cleanKernel();

    const result = await saveWizardProvider(openai, stubInput, kernel.deps);

    expect(result).toEqual({ ok: true });
    expect(kernel.deps.rememberKey).toHaveBeenCalledWith('openai', 'sk-wizard-key');
    expect(Object.fromEntries(kernel.config)).toEqual({
      OPENAI_API_KEY: 'sk-wizard-key',
      OPENAI_BASE_URL: 'http://127.0.0.1:47372/v1',
    });
    expect(kernel.defaults).toEqual({ providerId: 'openai', modelId: 'stub-model' });
    const [remembered] = kernel.deps.rememberKey.mock.invocationCallOrder;
    const [configured] = kernel.deps.saveProviderConfig.mock.invocationCallOrder;
    const [defaulted] = kernel.deps.saveDefaults.mock.invocationCallOrder;
    expect(remembered).toBeLessThan(configured);
    expect(configured).toBeLessThan(defaulted);
  });

  it("falls back to the provider's default model when the model field is empty", async () => {
    const kernel = cleanKernel();

    await saveWizardProvider(openai, { ...stubInput, model: '  ' }, kernel.deps);

    expect(kernel.defaults.modelId).toBe('gpt-4o');
  });

  it('saves nothing in the kernel when secure storage is unavailable (requirement 5.6)', async () => {
    const kernel = cleanKernel();
    kernel.deps.rememberKey.mockResolvedValueOnce({ ok: true, data: { outcome: 'memory-only' } });

    const result = await saveWizardProvider(openai, stubInput, kernel.deps);

    expect(result).toEqual({ ok: false, failure: 'secure-storage-unavailable' });
    expect(kernel.deps.saveProviderConfig).not.toHaveBeenCalled();
    expect(kernel.deps.saveDefaults).not.toHaveBeenCalled();
  });

  it('reports a credential store failure with its reason', async () => {
    const kernel = cleanKernel();
    kernel.deps.rememberKey.mockResolvedValueOnce({
      ok: false,
      error: { code: 'ATOMIC_WRITE_FAILED', message: 'Writing the secrets file failed' },
    });

    expect(await saveWizardProvider(openai, stubInput, kernel.deps)).toEqual({
      ok: false,
      failure: 'credential-store',
      reason: 'Writing the secrets file failed',
    });

    kernel.deps.rememberKey.mockRejectedValueOnce(new Error('IPC channel closed'));
    expect(await saveWizardProvider(openai, stubInput, kernel.deps)).toEqual({
      ok: false,
      failure: 'credential-store',
      reason: 'IPC channel closed',
    });
    expect(kernel.deps.saveProviderConfig).not.toHaveBeenCalled();
  });

  it('reports the kernel error and does not set the default when the config save fails', async () => {
    const kernel = cleanKernel();
    kernel.deps.saveProviderConfig.mockRejectedValueOnce(
      acpError('Failed to save provider secret fields: keyring locked')
    );

    const result = await saveWizardProvider(openai, stubInput, kernel.deps);

    expect(result).toEqual({
      ok: false,
      failure: 'kernel',
      reason: 'Failed to save provider secret fields: keyring locked',
    });
    expect(kernel.deps.saveDefaults).not.toHaveBeenCalled();
    expect(kernel.defaults.providerId).toBeNull();
  });
});

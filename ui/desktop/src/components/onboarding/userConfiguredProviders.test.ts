import { describe, expect, it } from 'vitest';
import { hasConfiguredProviderEntry, isConfiguredByUser } from './userConfiguredProviders';
import type { ConfigKey, ProviderDetails } from '../../types/providers';

function key(overrides: Partial<ConfigKey>): ConfigKey {
  return {
    name: 'KEY',
    required: false,
    secret: false,
    default: null,
    oauth_flow: false,
    ...overrides,
  };
}

function configured(
  configKeys: ConfigKey[],
  overrides: Partial<ProviderDetails> = {}
): ProviderDetails {
  return {
    name: 'provider',
    is_configured: true,
    is_available: true,
    visible_in_setup: true,
    deprecated: false,
    provider_type: 'Builtin',
    uses_acp: false,
    metadata: {
      name: 'provider',
      display_name: 'Provider',
      description: '',
      default_model: '',
      model_doc_link: '',
      known_models: [],
      config_keys: configKeys,
    },
    ...overrides,
  };
}

describe('isConfiguredByUser', () => {
  it('ignores what the kernel reports as configured on a clean machine', () => {
    // A command key that defaults to the binary name (codex, claude-code, cursor-agent).
    expect(isConfiguredByUser(configured([key({ required: true, default: 'codex' })]))).toBe(false);
    // No required key at all (github_copilot, local, the bundled servers without auth).
    expect(isConfiguredByUser(configured([key({ secret: true })]))).toBe(false);
    expect(isConfiguredByUser(configured([]))).toBe(false);
  });

  it('counts a configured provider with a key only the user can fill in', () => {
    const anthropic = configured([key({ required: true, secret: true })]);
    expect(isConfiguredByUser(anthropic)).toBe(true);
    expect(isConfiguredByUser({ ...anthropic, is_configured: false })).toBe(false);
  });

  it('counts enabled ACP agents and custom providers', () => {
    expect(isConfiguredByUser(configured([], { uses_acp: true }))).toBe(true);
    expect(isConfiguredByUser(configured([], { uses_acp: true, is_configured: false }))).toBe(
      false
    );
    expect(isConfiguredByUser(configured([key({})], { provider_type: 'Custom' }))).toBe(true);
  });
});

describe('hasConfiguredProviderEntry', () => {
  it('finds an entry marked configured', () => {
    expect(
      hasConfiguredProviderEntry({
        ollama: { enabled: true, model: 'qwen3', configured: false },
        'claude-acp': { enabled: true, model: 'current', configured: true },
      })
    ).toBe(true);
  });

  it('is false without a providers block or a configured entry', () => {
    expect(hasConfiguredProviderEntry(null)).toBe(false);
    expect(hasConfiguredProviderEntry([])).toBe(false);
    expect(hasConfiguredProviderEntry('openai')).toBe(false);
    expect(hasConfiguredProviderEntry({ openai: null, ollama: { configured: 'yes' } })).toBe(false);
    expect(hasConfiguredProviderEntry({ openai: { enabled: true, configured: false } })).toBe(
      false
    );
  });
});

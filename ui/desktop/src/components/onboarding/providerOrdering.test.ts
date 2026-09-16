import { describe, expect, it } from 'vitest';
import { sortSetupProviders } from './providerOrdering';
import type { ProviderDetails } from '../../types/providers';

function provider(name: string, overrides: Partial<ProviderDetails> = {}): ProviderDetails {
  return {
    name,
    is_configured: false,
    is_available: false,
    visible_in_setup: true,
    deprecated: false,
    replacement: null,
    metadata: {
      name,
      display_name: name,
      description: '',
      default_model: '',
      model_doc_link: '',
      config_keys: [],
      known_models: [],
    },
    provider_type: 'Declarative',
    uses_acp: false,
    ...overrides,
  } as ProviderDetails;
}

describe('sortSetupProviders', () => {
  it('surfaces domestic providers first in curated order', () => {
    const providers = [
      provider('openai', { provider_type: 'Preferred' }),
      provider('anthropic', { provider_type: 'Preferred' }),
      provider('moonshot'),
      provider('custom_deepseek'),
      provider('zhipu'),
      provider('azure'),
    ];

    const sorted = sortSetupProviders(providers).map((p) => p.name);

    expect(sorted.slice(0, 3)).toEqual(['custom_deepseek', 'zhipu', 'moonshot']);
    expect(sorted.slice(3)).toEqual(['anthropic', 'openai', 'azure']);
  });

  it('keeps Preferred-then-alphabetical order when no domestic provider is present', () => {
    const providers = [
      provider('openai'),
      provider('anthropic', { provider_type: 'Preferred' }),
      provider('azure', { provider_type: 'Preferred' }),
    ];

    expect(sortSetupProviders(providers).map((p) => p.name)).toEqual([
      'anthropic',
      'azure',
      'openai',
    ]);
  });

  it('does not mutate the input array', () => {
    const providers = [
      provider('custom_deepseek'),
      provider('openai', { provider_type: 'Preferred' }),
    ];
    const snapshot = [...providers];

    sortSetupProviders(providers);

    expect(providers).toEqual(snapshot);
  });
});

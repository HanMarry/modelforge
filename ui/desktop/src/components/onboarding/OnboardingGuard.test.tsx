import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import OnboardingGuard from './OnboardingGuard';
import { IntlTestWrapper } from '../../i18n/test-utils';
import { acpReadConfig } from '../../acp/config';
import {
  acpListProviderDetails,
  acpListProviderSecrets,
  acpReadDefaults,
  type ProviderSecretDto,
} from '../../acp/providers';
import type { ConfigKey, ProviderDetails } from '../../types/providers';

const mocks = vi.hoisted(() => ({
  getFallbackModelAndProvider: vi.fn(),
}));

vi.mock('./OnboardingWizard', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" onClick={onComplete}>
      finish wizard
    </button>
  ),
}));

vi.mock('../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    getFallbackModelAndProvider: mocks.getFallbackModelAndProvider,
  }),
}));

vi.mock('../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpListProviderSecrets: vi.fn(),
  acpReadDefaults: vi.fn(),
}));

vi.mock('../../acp/config', () => ({
  acpReadConfig: vi.fn(),
}));

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
    provider_type: 'Preferred',
    uses_acp: false,
    metadata: {
      name,
      display_name: name,
      description: '',
      default_model: '',
      model_doc_link: '',
      known_models: [],
      config_keys: configKeys,
    },
    ...overrides,
  };
}

function secret(overrides: Partial<ProviderSecretDto>): ProviderSecretDto {
  return {
    id: 'secret_store:openai:OPENAI_API_KEY',
    provider: 'openai',
    providerDisplayName: 'OpenAI',
    name: 'OPENAI_API_KEY',
    storage: 'secret_store',
    status: 'unknown',
    configured: true,
    hasSecret: true,
    canDelete: true,
    canConfigure: false,
    ...overrides,
  };
}

const openai = provider('openai', [
  configKey('OPENAI_API_KEY', { secret: true, primary: true }),
  configKey('OPENAI_HOST', { required: true, default: 'https://api.openai.com' }),
]);
const anthropic = provider('anthropic', [
  configKey('ANTHROPIC_API_KEY', { required: true, secret: true, primary: true }),
]);
const codexAcp = provider('codex-acp', [], { uses_acp: true });

/**
 * The inventory of a clean machine, as the kernel reports it: every provider whose required keys
 * all have defaults, or that has no required key, already counts as configured, although the
 * user has not set anything up.
 */
const cleanMachineProviders: ProviderDetails[] = [
  provider('codex', [configKey('CODEX_COMMAND', { required: true, default: 'codex' })], {
    is_configured: true,
  }),
  provider('github_copilot', [configKey('GITHUB_COPILOT_HOST')], { is_configured: true }),
  provider('lmstudio', [configKey('LMSTUDIO_API_KEY', { secret: true })], {
    is_configured: true,
    provider_type: 'Declarative',
  }),
  provider('local', [], { is_configured: true }),
  openai,
  anthropic,
  codexAcp,
];

/** Always listed; `hasSecret` stays false until the user signs in to Hugging Face. */
const huggingFaceSignIn = secret({
  id: 'provider_cache:huggingface',
  provider: 'huggingface',
  providerDisplayName: 'Hugging Face',
  name: 'OAuth token',
  storage: 'provider_cache',
  configured: false,
  hasSecret: false,
  canDelete: false,
  canConfigure: true,
});

function renderGuard() {
  return render(
    <IntlTestWrapper>
      <MemoryRouter>
        <OnboardingGuard>
          <p>main window</p>
        </OnboardingGuard>
      </MemoryRouter>
    </IntlTestWrapper>
  );
}

async function expectMainWindow() {
  expect(await screen.findByText('main window')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'finish wizard' })).not.toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(acpReadDefaults).mockResolvedValue({ providerId: null, modelId: null });
  vi.mocked(acpReadConfig).mockResolvedValue(null);
  vi.mocked(acpListProviderDetails).mockResolvedValue(cleanMachineProviders);
  vi.mocked(acpListProviderSecrets).mockResolvedValue([huggingFaceSignIn]);
  mocks.getFallbackModelAndProvider.mockResolvedValue({ model: '', provider: '' });
});

describe('OnboardingGuard', () => {
  it('shows the wizard on a clean machine, and the app once the wizard completes', async () => {
    const user = userEvent.setup();
    renderGuard();

    const finish = await screen.findByRole('button', { name: 'finish wizard' });
    expect(screen.queryByText('main window')).not.toBeInTheDocument();
    await user.click(finish);

    expect(await screen.findByText('main window')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'finish wizard' })).not.toBeInTheDocument();
  });

  it('still shows the wizard when the credential list cannot be read', async () => {
    vi.mocked(acpListProviderSecrets).mockRejectedValue(new Error('secret store is locked'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderGuard();

    expect(await screen.findByRole('button', { name: 'finish wizard' })).toBeInTheDocument();
    expect(screen.queryByText('main window')).not.toBeInTheDocument();
    warn.mockRestore();
  });

  it('skips the wizard once it has been completed, without asking the kernel', async () => {
    vi.mocked(window.electron.getSetting).mockResolvedValueOnce({
      completed: true,
      steps: { provider: 'done', key: 'skipped', environment: 'done', example: 'skipped' },
    });

    renderGuard();

    await expectMainWindow();
    expect(acpReadDefaults).not.toHaveBeenCalled();
    expect(acpListProviderDetails).not.toHaveBeenCalled();
  });

  it.each<[string, () => void]>([
    [
      'an active provider (active_provider / GOOSE_PROVIDER)',
      () => {
        vi.mocked(acpReadDefaults).mockResolvedValue({ providerId: 'openai', modelId: 'gpt-4o' });
      },
    ],
    [
      'a provider marked configured in the providers block of config.yaml',
      () => {
        vi.mocked(acpReadConfig).mockResolvedValue({
          openai: { enabled: true, model: 'gpt-4o', configured: true },
        });
      },
    ],
    [
      'an enabled ACP agent',
      () => {
        vi.mocked(acpListProviderDetails).mockResolvedValue([
          ...cleanMachineProviders.filter((entry) => entry !== codexAcp),
          { ...codexAcp, is_configured: true },
        ]);
      },
    ],
    [
      'a provider whose required key the user filled in',
      () => {
        vi.mocked(acpListProviderDetails).mockResolvedValue([
          ...cleanMachineProviders.filter((entry) => entry !== anthropic),
          { ...anthropic, is_configured: true },
        ]);
      },
    ],
    [
      'a custom provider the user added',
      () => {
        vi.mocked(acpListProviderDetails).mockResolvedValue([
          ...cleanMachineProviders,
          provider('custom_deepseek', [configKey('CUSTOM_DEEPSEEK_API_KEY', { secret: true })], {
            is_configured: true,
            provider_type: 'Custom',
          }),
        ]);
      },
    ],
    [
      'a stored provider key',
      () => {
        vi.mocked(acpListProviderSecrets).mockResolvedValue([huggingFaceSignIn, secret({})]);
      },
    ],
    [
      'a default provider bundled with the app',
      () => {
        mocks.getFallbackModelAndProvider.mockResolvedValue({
          model: 'gpt-4o',
          provider: 'openai',
        });
      },
    ],
  ])('skips the wizard for %s', async (_case, arrange) => {
    arrange();

    renderGuard();

    await expectMainWindow();
  });
});

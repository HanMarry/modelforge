import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OnboardingWizard from './OnboardingWizard';
import { IntlTestWrapper } from '../../i18n/test-utils';
import {
  acpListProviderDetails,
  acpSaveDefaults,
  acpSaveProviderConfig,
} from '../../acp/providers';
import type { ConfigKey, ProviderDetails } from '../../types/providers';

const mocks = vi.hoisted(() => ({
  refreshCurrentModelAndProvider: vi.fn(),
}));

vi.mock('../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    refreshCurrentModelAndProvider: mocks.refreshCurrentModelAndProvider,
  }),
}));

vi.mock('../../acp/providers', () => ({
  acpListProviderDetails: vi.fn(),
  acpSaveDefaults: vi.fn(),
  acpSaveProviderConfig: vi.fn(),
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
  displayName: string,
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
      display_name: displayName,
      description: '',
      default_model: 'gpt-4o',
      model_doc_link: '',
      known_models: [{ name: 'gpt-4o' }],
      config_keys: configKeys,
    },
    ...overrides,
  };
}

/** A clean machine: the kernel lists its providers, and none of them is configured. */
const cleanMachineProviders: ProviderDetails[] = [
  provider('openai', 'OpenAI', [
    configKey('OPENAI_API_KEY', { secret: true, primary: true }),
    configKey('OPENAI_BASE_URL'),
    configKey('OPENAI_HOST', { required: true, default: 'https://api.openai.com' }),
    configKey('OPENAI_BASE_PATH', { required: true, default: 'v1/chat/completions' }),
    configKey('OPENAI_CUSTOM_HEADERS', { secret: true }),
  ]),
  provider('claude-acp', 'Claude Code (ACP)', [], { uses_acp: true }),
  provider('azure_openai', 'Azure OpenAI', [
    configKey('AZURE_OPENAI_API_KEY', { secret: true, primary: true }),
    configKey('AZURE_OPENAI_ENDPOINT', { required: true }),
  ]),
];

const STUB_URL = 'http://127.0.0.1:47372/v1';

const electron = {
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  detectLocalRuntimes: vi.fn(),
  workspaceProbeEnvironment: vi.fn(),
  testProviderConnection: vi.fn(),
  rememberProviderApiKey: vi.fn(),
};

const originalElectron = window.electron;

/** What the kernel has stored through `providers/config/save`. */
let kernelConfig: Map<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  kernelConfig = new Map();
  electron.getSetting.mockResolvedValue(null);
  electron.setSetting.mockResolvedValue(undefined);
  electron.detectLocalRuntimes.mockResolvedValue([]);
  electron.workspaceProbeEnvironment.mockResolvedValue([
    {
      id: 'python',
      label: 'Python',
      command: 'python',
      version: 'Python 3.12.0',
      available: true,
      status: 'available',
    },
    {
      id: 'typst',
      label: 'Typst',
      command: 'typst',
      version: 'typst 0.12.0',
      available: true,
      status: 'available',
    },
  ]);
  electron.testProviderConnection.mockResolvedValue({ ok: true });
  electron.rememberProviderApiKey.mockResolvedValue({ ok: true, data: { outcome: 'encrypted' } });
  mocks.refreshCurrentModelAndProvider.mockResolvedValue(undefined);
  vi.mocked(acpListProviderDetails).mockResolvedValue(cleanMachineProviders);
  vi.mocked(acpSaveProviderConfig).mockImplementation(async (_providerId, fields) => {
    for (const field of fields) {
      kernelConfig.set(field.key, field.value);
    }
  });
  // Like the kernel's `defaults/save`: a provider without a stored key is not configured.
  vi.mocked(acpSaveDefaults).mockImplementation(async (providerId) => {
    if (!kernelConfig.has('OPENAI_API_KEY')) {
      throw Object.assign(new Error('Invalid params'), {
        data: `Provider is not configured: ${providerId}`,
      });
    }
  });
  (window as unknown as { electron: unknown }).electron = electron;
});

afterEach(() => {
  cleanup();
  window.electron = originalElectron;
});

function renderWizard() {
  return render(
    <IntlTestWrapper>
      <OnboardingWizard onComplete={vi.fn()} />
    </IntlTestWrapper>
  );
}

async function openKeyStep(user: ReturnType<typeof userEvent.setup>) {
  renderWizard();
  await screen.findByText(/第 1 步\/共 4 步/);
  await user.click(await screen.findByText('OpenAI'));
  await user.click(screen.getByRole('button', { name: '下一步' }));
  await screen.findByText(/第 2 步\/共 4 步/);
}

async function fillAndTest(user: ReturnType<typeof userEvent.setup>) {
  const address = screen.getByLabelText('API 地址');
  await user.clear(address);
  await user.type(address, STUB_URL);
  await user.type(screen.getByLabelText('API Key'), 'sk-wizard-key');
  await user.click(screen.getByRole('button', { name: '测试连接' }));
}

describe('OnboardingWizard', () => {
  it('shows the step indicator and the four-step total', async () => {
    renderWizard();

    expect(await screen.findByText(/第 1 步\/共 4 步/)).toBeInTheDocument();
  });

  it('offers only the providers the key step can configure', async () => {
    renderWizard();

    expect(await screen.findByText('OpenAI')).toBeInTheDocument();
    expect(screen.queryByText('Claude Code (ACP)')).not.toBeInTheDocument();
    expect(screen.queryByText('Azure OpenAI')).not.toBeInTheDocument();
  });

  it('advances to the key step after a provider is selected', async () => {
    const user = userEvent.setup();
    await openKeyStep(user);

    expect(screen.getByLabelText('API 地址')).toHaveValue('https://api.openai.com/v1');
    expect(screen.getByLabelText('Model')).toHaveValue('gpt-4o');
  });

  it('keeps the connectivity test disabled while the key is empty', async () => {
    const user = userEvent.setup();
    await openKeyStep(user);

    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
  });

  it('on a clean machine saves the key, the address and the default model in the kernel', async () => {
    const user = userEvent.setup();
    await openKeyStep(user);

    await fillAndTest(user);

    expect(await screen.findByText('连接成功')).toBeInTheDocument();
    expect(electron.testProviderConnection).toHaveBeenCalledWith(
      { baseUrl: STUB_URL },
      'sk-wizard-key'
    );
    expect(electron.rememberProviderApiKey).toHaveBeenCalledWith('openai', 'sk-wizard-key');
    expect(acpSaveProviderConfig).toHaveBeenCalledWith('openai', [
      { key: 'OPENAI_API_KEY', value: 'sk-wizard-key' },
      { key: 'OPENAI_BASE_URL', value: STUB_URL },
    ]);
    expect(acpSaveDefaults).toHaveBeenCalledWith('openai', 'gpt-4o');
    expect(mocks.refreshCurrentModelAndProvider).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
  });

  it('shows why saving failed, keeps the input and lets the user retry', async () => {
    const user = userEvent.setup();
    vi.mocked(acpSaveProviderConfig).mockRejectedValueOnce(
      Object.assign(new Error('Internal error'), {
        data: 'Failed to save provider secret fields: keyring locked',
      })
    );
    await openKeyStep(user);

    await fillAndTest(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The connection works, but the built-in kernel could not save this provider: Failed to save provider secret fields: keyring locked'
    );
    expect(acpSaveDefaults).not.toHaveBeenCalled();
    expect(screen.queryByText('连接成功')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
    expect(screen.getByLabelText('API 地址')).toHaveValue(STUB_URL);
    expect(screen.getByLabelText('API Key')).toHaveValue('sk-wizard-key');

    await user.click(screen.getByRole('button', { name: '测试连接' }));

    expect(await screen.findByText('连接成功')).toBeInTheDocument();
    expect(acpSaveDefaults).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('does not save the key in the kernel when secure storage is unavailable', async () => {
    const user = userEvent.setup();
    electron.rememberProviderApiKey.mockResolvedValue({
      ok: true,
      data: { outcome: 'memory-only' },
    });
    await openKeyStep(user);

    await fillAndTest(user);

    expect(await screen.findByRole('alert')).toHaveTextContent('安全存储不可用');
    expect(acpSaveProviderConfig).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();
  });

  it('saves nothing when the connectivity test fails', async () => {
    const user = userEvent.setup();
    electron.testProviderConnection.mockResolvedValue({
      ok: false,
      failure: { status: 401, body: 'invalid api key', cause: null },
    });
    await openKeyStep(user);

    await fillAndTest(user);

    expect(await screen.findByText('密钥无效')).toBeInTheDocument();
    expect(electron.rememberProviderApiKey).not.toHaveBeenCalled();
    expect(acpSaveProviderConfig).not.toHaveBeenCalled();
    expect(acpSaveDefaults).not.toHaveBeenCalled();
  });

  it('offers skipping and records the step as skipped', async () => {
    const user = userEvent.setup();
    renderWizard();

    await screen.findByText(/第 1 步\/共 4 步/);
    await user.click(screen.getByRole('button', { name: '跳过' }));

    expect(await screen.findByText(/第 2 步\/共 4 步/)).toBeInTheDocument();
    expect(electron.setSetting).toHaveBeenCalled();
  });

  it('reports a tool that was found but answered too late as 检测超时, not 未找到', async () => {
    electron.workspaceProbeEnvironment.mockResolvedValue([
      {
        id: 'python',
        label: 'Python',
        command: 'C:\\hostedtoolcache\\windows\\Python\\3.12.10\\x64\\python.exe',
        version: null,
        available: false,
        status: 'timeout',
      },
      {
        id: 'latexmk',
        label: 'latexmk',
        command: 'latexmk',
        version: null,
        available: false,
        status: 'missing',
      },
      {
        id: 'typst',
        label: 'Typst',
        command: 'D:\\a\\_temp\\mf-tools\\typst\\typst-x86_64-pc-windows-msvc\\typst.exe',
        version: null,
        available: false,
        status: 'timeout',
      },
    ]);
    render(
      <IntlTestWrapper>
        <OnboardingWizard initialStep="environment" onComplete={vi.fn()} />
      </IntlTestWrapper>
    );

    expect(await screen.findByText('Python：检测超时')).toBeInTheDocument();
    expect(screen.getByText('论文编译环境：检测超时')).toBeInTheDocument();
  });
});

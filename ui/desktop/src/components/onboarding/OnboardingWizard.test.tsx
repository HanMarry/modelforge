import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OnboardingWizard from './OnboardingWizard';

vi.mock('../../acp/providers', () => ({
  acpListProviderDetails: vi.fn().mockResolvedValue([
    {
      name: 'openai',
      metadata: { display_name: 'OpenAI' },
      visible_in_setup: true,
      is_configured: false,
    },
  ]),
  acpSaveDefaults: vi.fn().mockResolvedValue(undefined),
}));

const electron = {
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(undefined),
  detectLocalRuntimes: vi.fn().mockResolvedValue([]),
  workspaceProbeEnvironment: vi.fn().mockResolvedValue([
    { id: 'python', label: 'Python', command: 'python', version: 'Python 3.12.0', available: true },
    { id: 'typst', label: 'Typst', command: 'typst', version: 'typst 0.12.0', available: true },
  ]),
  testProviderConnection: vi.fn().mockResolvedValue({ ok: true }),
  rememberProviderApiKey: vi.fn().mockResolvedValue({ ok: true, data: { outcome: 'encrypted' } }),
};

beforeEach(() => {
  vi.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = electron;
});

describe('OnboardingWizard', () => {
  it('shows the step indicator and the four-step total', async () => {
    render(<OnboardingWizard onComplete={vi.fn()} />);

    expect(await screen.findByText(/第 1 步\/共 4 步/)).toBeInTheDocument();
  });

  it('advances to the key step after a provider is selected', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard onComplete={vi.fn()} />);

    await screen.findByText(/第 1 步\/共 4 步/);
    await user.click(await screen.findByText('OpenAI'));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(await screen.findByText(/第 2 步\/共 4 步/)).toBeInTheDocument();
  });

  it('keeps the connectivity test disabled while the key is empty', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard onComplete={vi.fn()} />);

    await screen.findByText(/第 1 步\/共 4 步/);
    await user.click(await screen.findByText('OpenAI'));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    await screen.findByText(/第 2 步\/共 4 步/);
    expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
  });

  it('offers skipping and records the step as skipped', async () => {
    const user = userEvent.setup();
    render(<OnboardingWizard onComplete={vi.fn()} />);

    await screen.findByText(/第 1 步\/共 4 步/);
    await user.click(screen.getByRole('button', { name: '跳过' }));

    expect(await screen.findByText(/第 2 步\/共 4 步/)).toBeInTheDocument();
    expect(electron.setSetting).toHaveBeenCalled();
  });
});

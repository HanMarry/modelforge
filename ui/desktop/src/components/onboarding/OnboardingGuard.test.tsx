import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import OnboardingGuard from './OnboardingGuard';
import { IntlTestWrapper } from '../../i18n/test-utils';

vi.mock('./OnboardingWizard', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" onClick={onComplete}>
      finish wizard
    </button>
  ),
}));

vi.mock('../ModelAndProviderContext', () => ({
  useModelAndProvider: () => ({
    getFallbackModelAndProvider: () => Promise.resolve({ model: '', provider: '' }),
  }),
}));

// A clean machine: no provider is configured and there is no default provider.
vi.mock('../../acp/providers', () => ({
  acpListProviderDetails: () => Promise.resolve([]),
  acpReadDefaults: () => Promise.resolve({ providerId: null, modelId: null }),
}));

describe('OnboardingGuard', () => {
  it('shows the app once the wizard completes', async () => {
    const user = userEvent.setup();
    render(
      <IntlTestWrapper>
        <MemoryRouter>
          <OnboardingGuard>
            <p>main window</p>
          </OnboardingGuard>
        </MemoryRouter>
      </IntlTestWrapper>
    );

    await user.click(await screen.findByRole('button', { name: 'finish wizard' }));

    expect(await screen.findByText('main window')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'finish wizard' })).not.toBeInTheDocument();
  });
});

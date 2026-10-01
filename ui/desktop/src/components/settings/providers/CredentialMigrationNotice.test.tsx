import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CredentialMigrationFailure } from '../../../acp/credentialMigration';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import CredentialMigrationStatus from './CredentialMigrationNotice';

const migration = vi.hoisted(() => ({
  failures: vi.fn<() => Promise<CredentialMigrationFailure[]>>(),
  /** Listeners registered for "the Kernel connection was re-established". */
  refreshListeners: new Set<() => void>(),
}));

vi.mock('../../../acp/credentialMigration', () => ({
  getCredentialMigrationFailures: migration.failures,
  subscribeToCredentialMigrationRefresh: (listener: () => void) => {
    migration.refreshListeners.add(listener);
    return () => {
      migration.refreshListeners.delete(listener);
    };
  },
}));

const providerFailure: CredentialMigrationFailure = {
  owner: 'provider',
  name: 'Gateway',
  stage: 'verify',
  message: 'provider Gateway: plaintext header migration failed at verify',
};

function renderStatus() {
  return render(<CredentialMigrationStatus className="mb-6" />, { wrapper: IntlTestWrapper });
}

/** Lets the pending read of the migration result settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  migration.refreshListeners.clear();
});

describe('CredentialMigrationStatus in the model provider settings (requirement 1.9)', () => {
  it('names each config, the step that failed and the automatic retry', async () => {
    migration.failures.mockResolvedValue([
      providerFailure,
      { owner: 'extension', name: 'GitHub', stage: 'write', message: '' },
      { owner: 'provider', name: 'Relay', stage: 'replace', message: '' },
    ]);
    renderStatus();

    const notice = await screen.findByTestId('credential-migration-notice');
    expect(notice).toHaveTextContent('Provider Gateway: the verify step failed');
    expect(notice).toHaveTextContent('provider Gateway: plaintext header migration failed at verify');
    expect(notice).toHaveTextContent('Extension GitHub: the write step failed');
    expect(notice).toHaveTextContent('Provider Relay: the replace step failed');
    expect(notice).toHaveTextContent('The migration is retried automatically on the next start.');
  });

  it('shows nothing while no migration failed', async () => {
    migration.failures.mockResolvedValue([]);
    renderStatus();
    await settle();

    expect(migration.failures).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('credential-migration-notice')).not.toBeInTheDocument();
  });

  it('reads the result again once the Kernel connection is re-established', async () => {
    migration.failures.mockResolvedValueOnce([]).mockResolvedValueOnce([providerFailure]);
    renderStatus();
    await settle();
    expect(screen.queryByTestId('credential-migration-notice')).not.toBeInTheDocument();

    // A restarted Kernel has tried the migration again and reports what still fails.
    act(() => {
      for (const listener of migration.refreshListeners) listener();
    });

    expect(await screen.findByTestId('credential-migration-notice')).toHaveTextContent(
      'Provider Gateway: the verify step failed'
    );
    expect(migration.failures).toHaveBeenCalledTimes(2);
  });

  it('stops listening once it is removed', async () => {
    migration.failures.mockResolvedValue([]);
    const { unmount } = renderStatus();
    await settle();
    expect(migration.refreshListeners.size).toBe(1);

    unmount();
    expect(migration.refreshListeners.size).toBe(0);
  });
});

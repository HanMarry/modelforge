import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CredentialStorageStatus from './CredentialStorageStatus';
import { IntlTestWrapper } from '../../../i18n/test-utils';
import { rememberProviderApiKey } from '../../../utils/agentKernelCapture';
import type { CredentialSaveData, CredentialSaveResult } from '../../../utils/credentialIpc';
import { announceCredentialSave } from '../../../utils/credentialSaveEvents';
import type { CredentialStoreStatus, MigrationResult } from '../../../utils/credentialStore';
import type { IpcResult } from '../../../utils/ipcResult';

const HEALTHY: CredentialStoreStatus = {
  path: '/userData/agent-kernel-secrets.json',
  persistent: true,
  corrupted: false,
  legacyEntries: 0,
  memoryOnlyEntries: 0,
  lastMigration: null,
};

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });

const saved = (outcome: CredentialSaveData['outcome']): CredentialSaveResult => ({
  ok: true,
  data: { outcome },
});

const credentialStatus = vi.fn<() => Promise<IpcResult<CredentialStoreStatus>>>();
const credentialMigrate = vi.fn<() => Promise<IpcResult<MigrationResult>>>();
const rememberProviderKey = vi.fn<(id: string, key: string) => Promise<CredentialSaveResult>>();

const renderStatus = () => render(<CredentialStorageStatus />, { wrapper: IntlTestWrapper });

describe('CredentialStorageStatus', () => {
  beforeEach(() => {
    credentialStatus.mockReset().mockResolvedValue(ok(HEALTHY));
    credentialMigrate.mockReset().mockResolvedValue(ok({ migrated: 0, failed: 0 }));
    rememberProviderKey.mockReset();
    Object.assign(window.electron, {
      credentialStatus,
      credentialMigrate,
      rememberProviderApiKey: rememberProviderKey,
    });
  });

  it('shows nothing while keys are encrypted and the secrets file is fine', async () => {
    const { container } = renderStatus();

    await waitFor(() => expect(credentialStatus).toHaveBeenCalled());

    expect(container).toBeEmptyDOMElement();
  });

  it('warns that keys last for this session only when encryption is unavailable', async () => {
    credentialStatus.mockResolvedValue(ok({ ...HEALTHY, persistent: false }));

    renderStatus();

    expect(
      await screen.findByText('Encryption is unavailable. Keys are valid for this session only.')
    ).toBeInTheDocument();
  });

  it('shows "Not persisted" as soon as a memory-only save completes', async () => {
    credentialStatus.mockResolvedValue(ok({ ...HEALTHY, persistent: false }));
    renderStatus();
    await screen.findByText('Encryption is unavailable. Keys are valid for this session only.');

    act(() => announceCredentialSave(saved('memory-only')));

    // Rendered synchronously with the save result, well within the one second of 2.2.
    expect(screen.getByRole('status')).toHaveTextContent(
      'Not persisted: this key lasts until ModelForge quits'
    );
  });

  it('shows "Encrypted and saved" as soon as an encrypted save completes', () => {
    renderStatus();

    act(() => announceCredentialSave(saved('encrypted')));

    expect(screen.getByRole('status')).toHaveTextContent('Encrypted and saved');
  });

  it('does not show a failed save as saved', () => {
    renderStatus();

    act(() =>
      announceCredentialSave({
        ok: false,
        error: { code: 'ATOMIC_WRITE_FAILED', message: 'EIO: injected' },
      })
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'The key was not saved: the secrets file could not be written, the previous keys are unchanged'
    );
    expect(screen.queryByText('Encrypted and saved')).not.toBeInTheDocument();
  });

  it('shows the outcome of a provider key captured from the provider settings', async () => {
    rememberProviderKey.mockResolvedValue(saved('memory-only'));
    renderStatus();

    rememberProviderApiKey('custom_deepseek', 'sk-captured-0123456789');

    expect(
      await screen.findByText('Not persisted: this key lasts until ModelForge quits')
    ).toBeInTheDocument();
    expect(rememberProviderKey).toHaveBeenCalledWith('custom_deepseek', 'sk-captured-0123456789');
  });

  it('reports a damaged secrets file and checks it again on request', async () => {
    credentialStatus.mockResolvedValueOnce(ok({ ...HEALTHY, corrupted: true }));
    const user = userEvent.setup();
    const { container } = renderStatus();

    expect(
      await screen.findByText(
        'The secrets file is damaged: /userData/agent-kernel-secrets.json. ModelForge does not write to it until you repair or delete it.'
      )
    ).toBeInTheDocument();

    // The user repaired the file; the next status read finds it healthy.
    await user.click(screen.getByRole('button', { name: 'Check again' }));

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(credentialStatus).toHaveBeenCalledTimes(2);
  });

  it('shows how many legacy keys failed to migrate and retries on request', async () => {
    credentialStatus.mockResolvedValueOnce(
      ok({ ...HEALTHY, legacyEntries: 2, lastMigration: { migrated: 1, failed: 2 } })
    );
    credentialMigrate.mockResolvedValue(ok({ migrated: 2, failed: 0 }));
    credentialStatus.mockResolvedValue(
      ok({ ...HEALTHY, lastMigration: { migrated: 2, failed: 0 } })
    );
    const user = userEvent.setup();
    const { container } = renderStatus();

    expect(
      await screen.findByText(
        'Keys saved by an older version that could not be encrypted: 2. They stay as they are and are retried on the next start.'
      )
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry now' }));

    expect(credentialMigrate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('says so when the status cannot be read', async () => {
    credentialStatus.mockResolvedValue({
      ok: false,
      error: { code: 'UNEXPECTED', message: 'store unavailable' },
    });

    renderStatus();

    expect(
      await screen.findByText('Cannot read the key storage status: store unavailable')
    ).toBeInTheDocument();
  });
});

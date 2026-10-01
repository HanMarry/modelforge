import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAcpInitializeResponse, subscribeToAcpRecovery } from '../acpConnection';
import {
  getCredentialMigrationFailures,
  parseCredentialMigrationFailures,
  subscribeToCredentialMigrationRefresh,
} from '../credentialMigration';

vi.mock('../acpConnection', () => ({
  getAcpInitializeResponse: vi.fn(),
  subscribeToAcpRecovery: vi.fn(),
}));

/** An initialize response whose `agentCapabilities._meta` is `meta`, well formed or not. */
function initializeResponseWithMeta(meta?: unknown): Pick<InitializeResponse, 'agentCapabilities'> {
  return {
    agentCapabilities: {
      _meta: meta as Record<string, unknown> | undefined,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseCredentialMigrationFailures (requirement 1.9)', () => {
  it('reads the failures the Kernel reports in its initialize response', () => {
    const response = initializeResponseWithMeta({
      goose: {
        recipeParameterScopes: {},
        credentialMigration: {
          failures: [
            {
              owner: 'provider',
              name: 'Gateway 网关',
              stage: 'write',
              message:
                'provider Gateway 网关: plaintext header migration failed at write: header Authorization: locked',
            },
            {
              owner: 'extension',
              name: 'GitHub',
              stage: 'verify',
              message: 'extension GitHub: plaintext header migration failed at verify',
            },
            { owner: 'extension', name: 'Notes', stage: 'replace' },
          ],
        },
      },
    });

    expect(parseCredentialMigrationFailures(response)).toEqual([
      {
        owner: 'provider',
        name: 'Gateway 网关',
        stage: 'write',
        message:
          'provider Gateway 网关: plaintext header migration failed at write: header Authorization: locked',
      },
      {
        owner: 'extension',
        name: 'GitHub',
        stage: 'verify',
        message: 'extension GitHub: plaintext header migration failed at verify',
      },
      { owner: 'extension', name: 'Notes', stage: 'replace', message: '' },
    ]);
  });

  it('reports nothing when the migration succeeded or the Kernel is older', () => {
    expect(parseCredentialMigrationFailures({})).toEqual([]);
    expect(parseCredentialMigrationFailures(initializeResponseWithMeta())).toEqual([]);
    expect(parseCredentialMigrationFailures(initializeResponseWithMeta({}))).toEqual([]);
    expect(
      parseCredentialMigrationFailures(initializeResponseWithMeta({ goose: { localInference: {} } }))
    ).toEqual([]);
  });

  it('skips malformed metadata and entries', () => {
    expect(parseCredentialMigrationFailures(initializeResponseWithMeta({ goose: true }))).toEqual(
      []
    );
    expect(
      parseCredentialMigrationFailures(
        initializeResponseWithMeta({ goose: { credentialMigration: { failures: 'write' } } })
      )
    ).toEqual([]);
    expect(
      parseCredentialMigrationFailures(
        initializeResponseWithMeta({
          goose: {
            credentialMigration: {
              failures: [
                null,
                'provider',
                { owner: 'model', name: 'Gateway', stage: 'write' },
                { owner: 'provider', name: 'Gateway', stage: 'delete' },
                { owner: 'provider', name: '', stage: 'write' },
                { owner: 'provider', name: 42, stage: 'write' },
                { owner: 'provider', name: 'Gateway', stage: 'write', message: 7 },
              ],
            },
          },
        })
      )
    ).toEqual([{ owner: 'provider', name: 'Gateway', stage: 'write', message: '' }]);
  });
});

describe('reading the migration result from the connected Kernel', () => {
  it('takes the failures from the initialize response of the current connection', async () => {
    vi.mocked(getAcpInitializeResponse).mockResolvedValue({
      protocolVersion: 1,
      ...initializeResponseWithMeta({
        goose: {
          credentialMigration: {
            failures: [{ owner: 'provider', name: 'Gateway', stage: 'replace', message: 'm' }],
          },
        },
      }),
    });

    await expect(getCredentialMigrationFailures()).resolves.toEqual([
      { owner: 'provider', name: 'Gateway', stage: 'replace', message: 'm' },
    ]);
  });

  it('refreshes once a reconnection has finished, not while it is still running', () => {
    const unsubscribe = vi.fn();
    vi.mocked(subscribeToAcpRecovery).mockReturnValue(unsubscribe);
    const listener = vi.fn();

    const stop = subscribeToCredentialMigrationRefresh(listener);
    const onRecovery = vi.mocked(subscribeToAcpRecovery).mock.calls[0][0];

    onRecovery(true);
    expect(listener).not.toHaveBeenCalled();
    onRecovery(false);
    expect(listener).toHaveBeenCalledTimes(1);

    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

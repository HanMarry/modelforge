import { useCallback, useEffect, useMemo, useState } from 'react';
import { CircleAlert, ShieldAlert, ShieldCheck } from 'lucide-react';
import { defineMessages, useIntl } from '../../../i18n';
import type { CredentialSaveResult } from '../../../utils/credentialIpc';
import { onCredentialSaved } from '../../../utils/credentialSaveEvents';
import type { CredentialStoreStatus } from '../../../utils/credentialStore';
import type { IpcError } from '../../../utils/ipcResult';
import { errorMessage } from '../../../utils/conversionUtils';
import { Button } from '../../ui/button';

const i18n = defineMessages({
  unavailable: {
    id: 'credentialStorageStatus.unavailable',
    defaultMessage: 'Encryption is unavailable. Keys are valid for this session only.',
  },
  unavailableDetail: {
    id: 'credentialStorageStatus.unavailableDetail',
    defaultMessage:
      'The system secure storage cannot encrypt keys, so ModelForge keeps them in memory and forgets them when it quits. Enter them again after a restart.',
  },
  savedEncrypted: {
    id: 'credentialStorageStatus.savedEncrypted',
    defaultMessage: 'Encrypted and saved',
  },
  savedMemoryOnly: {
    id: 'credentialStorageStatus.savedMemoryOnly',
    defaultMessage: 'Not persisted: this key lasts until ModelForge quits',
  },
  saveFailed: {
    id: 'credentialStorageStatus.saveFailed',
    defaultMessage: 'The key was not saved: {reason}',
  },
  removeFailed: {
    id: 'credentialStorageStatus.removeFailed',
    defaultMessage: 'The saved key was not removed: {reason}',
  },
  reasonCorrupted: {
    id: 'credentialStorageStatus.reasonCorrupted',
    defaultMessage: 'the secrets file is damaged',
  },
  reasonWriteFailed: {
    id: 'credentialStorageStatus.reasonWriteFailed',
    defaultMessage: 'the secrets file could not be written, the previous keys are unchanged',
  },
  reasonEncryptionFailed: {
    id: 'credentialStorageStatus.reasonEncryptionFailed',
    defaultMessage: 'the system secure storage could not encrypt it',
  },
  reasonInvalid: {
    id: 'credentialStorageStatus.reasonInvalid',
    defaultMessage: 'the key is empty or invalid',
  },
  corrupted: {
    id: 'credentialStorageStatus.corrupted',
    defaultMessage:
      'The secrets file is damaged: {path}. ModelForge does not write to it until you repair or delete it.',
  },
  checkAgain: {
    id: 'credentialStorageStatus.checkAgain',
    defaultMessage: 'Check again',
  },
  migrationFailed: {
    id: 'credentialStorageStatus.migrationFailed',
    defaultMessage:
      'Keys saved by an older version that could not be encrypted: {count}. They stay as they are and are retried on the next start.',
  },
  retryMigration: {
    id: 'credentialStorageStatus.retryMigration',
    defaultMessage: 'Retry now',
  },
  statusUnavailable: {
    id: 'credentialStorageStatus.statusUnavailable',
    defaultMessage: 'Cannot read the key storage status: {reason}',
  },
});

export interface CredentialMessages {
  /** "Encrypted and saved", "Not persisted" or why the save failed (requirement 2.2, 2.3, 2.8). */
  saveOutcome: (result: CredentialSaveResult) => string;
  removeFailed: (error: IpcError) => string;
}

/** Texts for the outcome of a key save, shared by every settings page that saves keys. */
export function useCredentialMessages(): CredentialMessages {
  const intl = useIntl();
  return useMemo((): CredentialMessages => {
    const reason = (error: IpcError): string => {
      switch (error.code) {
        case 'SECRETS_FILE_CORRUPTED':
          return intl.formatMessage(i18n.reasonCorrupted);
        case 'ATOMIC_WRITE_FAILED':
          return intl.formatMessage(i18n.reasonWriteFailed);
        case 'ENCRYPTION_FAILED':
          return intl.formatMessage(i18n.reasonEncryptionFailed);
        case 'INVALID_INPUT':
          return intl.formatMessage(i18n.reasonInvalid);
        default:
          // Already masked in the main process.
          return error.message;
      }
    };
    return {
      saveOutcome: (result: CredentialSaveResult) => {
        if (!result.ok) {
          return intl.formatMessage(i18n.saveFailed, { reason: reason(result.error) });
        }
        return intl.formatMessage(
          result.data.outcome === 'encrypted' ? i18n.savedEncrypted : i18n.savedMemoryOnly
        );
      },
      removeFailed: (error: IpcError) =>
        intl.formatMessage(i18n.removeFailed, { reason: reason(error) }),
    };
  }, [intl]);
}

/**
 * State of the desktop credential store for the providers settings (requirement 2): a warning
 * while keys cannot be encrypted, the outcome of the latest save, a damaged secrets file and
 * legacy keys that could not be migrated. Renders nothing while all is well.
 */
export default function CredentialStorageStatus({ className = '' }: { className?: string }) {
  const intl = useIntl();
  const messages = useCredentialMessages();
  const [status, setStatus] = useState<CredentialStoreStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [lastSave, setLastSave] = useState<CredentialSaveResult | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const result = await window.electron.credentialStatus?.();
      if (!result) {
        return;
      }
      if (result.ok) {
        setStatus(result.data);
        setStatusError(null);
      } else {
        setStatusError(result.error.message);
      }
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(
    () =>
      onCredentialSaved((result) => {
        setLastSave(result);
        void loadStatus();
      }),
    [loadStatus]
  );

  const recheck = async () => {
    setIsBusy(true);
    try {
      await loadStatus();
    } finally {
      setIsBusy(false);
    }
  };

  const retryMigration = async () => {
    setIsBusy(true);
    try {
      const result = await window.electron.credentialMigrate();
      await loadStatus();
      if (!result.ok) {
        setStatusError(result.error.message);
      }
    } catch (error) {
      setStatusError(errorMessage(error));
    } finally {
      setIsBusy(false);
    }
  };

  const migrationFailures = status?.lastMigration?.failed ?? 0;
  const hasNotice =
    Boolean(statusError) ||
    Boolean(lastSave) ||
    (status !== null && (!status.persistent || status.corrupted || migrationFailures > 0));
  if (!hasNotice) {
    return null;
  }

  return (
    <div data-testid="credential-storage-status" className={`space-y-2 ${className}`}>
      {status && !status.persistent && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-border-primary p-3 text-sm"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" aria-hidden="true" />
          <div className="space-y-1">
            <div className="font-medium text-text-primary">
              {intl.formatMessage(i18n.unavailable)}
            </div>
            <div className="text-text-secondary">{intl.formatMessage(i18n.unavailableDetail)}</div>
          </div>
        </div>
      )}

      {status?.corrupted && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-border-primary p-3 text-sm"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          <div className="flex-1 space-y-2">
            <div className="break-words text-red-600">
              {intl.formatMessage(i18n.corrupted, { path: status.path })}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy}
              onClick={() => void recheck()}
            >
              {intl.formatMessage(i18n.checkAgain)}
            </Button>
          </div>
        </div>
      )}

      {migrationFailures > 0 && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-border-primary p-3 text-sm"
        >
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" aria-hidden="true" />
          <div className="flex-1 space-y-2">
            <div className="text-text-primary">
              {intl.formatMessage(i18n.migrationFailed, { count: migrationFailures })}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isBusy || !status?.persistent}
              onClick={() => void retryMigration()}
            >
              {intl.formatMessage(i18n.retryMigration)}
            </Button>
          </div>
        </div>
      )}

      {statusError && (
        <div role="alert" className="break-words text-sm text-red-600">
          {intl.formatMessage(i18n.statusUnavailable, { reason: statusError })}
        </div>
      )}

      {lastSave && (
        <div
          role="status"
          className={`flex items-center gap-2 text-sm ${
            lastSave.ok
              ? lastSave.data.outcome === 'encrypted'
                ? 'text-green-600'
                : 'text-yellow-600'
              : 'text-red-600'
          }`}
        >
          {lastSave.ok && lastSave.data.outcome === 'encrypted' ? (
            <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ShieldAlert className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="break-words">{messages.saveOutcome(lastSave)}</span>
        </div>
      )}
    </div>
  );
}

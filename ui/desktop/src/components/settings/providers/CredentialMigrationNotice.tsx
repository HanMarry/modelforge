import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { defineMessages, useIntl } from '../../../i18n';
import {
  getCredentialMigrationFailures,
  subscribeToCredentialMigrationRefresh,
  type CredentialMigrationFailure,
  type CredentialMigrationOwner,
  type CredentialMigrationStage,
} from '../../../acp/credentialMigration';

const i18n = defineMessages({
  title: {
    id: 'credentialMigrationNotice.title',
    defaultMessage: 'Some plaintext request headers could not be moved to the credential store',
  },
  failure: {
    id: 'credentialMigrationNotice.failure',
    defaultMessage: '{owner} {name}: the {step} step failed',
  },
  ownerProvider: {
    id: 'credentialMigrationNotice.ownerProvider',
    defaultMessage: 'Provider',
  },
  ownerExtension: {
    id: 'credentialMigrationNotice.ownerExtension',
    defaultMessage: 'Extension',
  },
  stepWrite: {
    id: 'credentialMigrationNotice.stepWrite',
    defaultMessage: 'write',
  },
  stepVerify: {
    id: 'credentialMigrationNotice.stepVerify',
    defaultMessage: 'verify',
  },
  stepReplace: {
    id: 'credentialMigrationNotice.stepReplace',
    defaultMessage: 'replace',
  },
  retry: {
    id: 'credentialMigrationNotice.retry',
    defaultMessage:
      'Their configuration was left unchanged. The migration is retried automatically on the next start.',
  },
});

type Message = (typeof i18n)[keyof typeof i18n];

const OWNER_LABELS: Record<CredentialMigrationOwner, Message> = {
  provider: i18n.ownerProvider,
  extension: i18n.ownerExtension,
};

const STEP_LABELS: Record<CredentialMigrationStage, Message> = {
  write: i18n.stepWrite,
  verify: i18n.stepVerify,
  replace: i18n.stepReplace,
};

/**
 * Plaintext header migrations the Kernel reported as failed at startup (requirement 1.9). Read
 * again after the connection to the Kernel is re-established, since a restarted Kernel retries.
 */
export function useCredentialMigrationFailures(): CredentialMigrationFailure[] {
  const [failures, setFailures] = useState<CredentialMigrationFailure[]>([]);

  useEffect(() => {
    let active = true;
    const load = () => {
      getCredentialMigrationFailures()
        .then((next) => {
          if (active) {
            setFailures(next);
          }
        })
        .catch((error: unknown) => {
          console.warn('Could not read the credential migration result:', error);
        });
    };
    load();
    const unsubscribe = subscribeToCredentialMigrationRefresh(load);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return failures;
}

/**
 * Names each provider or extension whose plaintext headers could not be migrated, the step that
 * failed (write, verify or replace) and that the migration is retried on the next start.
 */
export function CredentialMigrationNotice({
  failures,
  className = '',
}: {
  failures: CredentialMigrationFailure[];
  className?: string;
}) {
  const intl = useIntl();
  if (failures.length === 0) {
    return null;
  }

  return (
    <div
      role="alert"
      data-testid="credential-migration-notice"
      className={`flex items-start gap-2 rounded-md border border-border-primary p-3 text-sm ${className}`}
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <div className="font-medium text-text-primary">{intl.formatMessage(i18n.title)}</div>
        <ul className="list-disc space-y-1 pl-5 text-text-secondary">
          {failures.map((failure, index) => (
            <li key={`${failure.owner}:${failure.name}:${index}`}>
              {intl.formatMessage(i18n.failure, {
                owner: intl.formatMessage(OWNER_LABELS[failure.owner]),
                name: failure.name,
                step: intl.formatMessage(STEP_LABELS[failure.stage]),
              })}
              {failure.message && (
                <div className="break-all text-xs text-text-muted">{failure.message}</div>
              )}
            </li>
          ))}
        </ul>
        <div className="text-text-secondary">{intl.formatMessage(i18n.retry)}</div>
      </div>
    </div>
  );
}

/** The notice for the model provider settings; renders nothing while no migration failed. */
export default function CredentialMigrationStatus({ className = '' }: { className?: string }) {
  const failures = useCredentialMigrationFailures();
  return <CredentialMigrationNotice failures={failures} className={className} />;
}

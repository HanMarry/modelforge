import type { InitializeResponse } from '@agentclientprotocol/sdk';
import { getAcpInitializeResponse, subscribeToAcpRecovery } from './acpConnection';

/** Kept in sync with `MigrationOwner::as_str` in crates/goose/src/config/credential_migration.rs. */
export type CredentialMigrationOwner = 'provider' | 'extension';

/** Kept in sync with `MigrationStage::as_str` in crates/goose/src/config/credential_migration.rs. */
export type CredentialMigrationStage = 'write' | 'verify' | 'replace';

const OWNERS: readonly CredentialMigrationOwner[] = ['provider', 'extension'];
const STAGES: readonly CredentialMigrationStage[] = ['write', 'verify', 'replace'];

/**
 * A config whose plaintext auth headers the Kernel could not move into the credential store at
 * startup (requirement 1.9). The config was left as it was and the Kernel tries again on its
 * next start.
 */
export interface CredentialMigrationFailure {
  owner: CredentialMigrationOwner;
  /** Display name of the provider, or name of the extension. */
  name: string;
  /** The step that failed: writing to the store, reading it back, or replacing the config. */
  stage: CredentialMigrationStage;
  /** The Kernel's description. It never contains credential values. */
  message: string;
}

/**
 * Reads `agentCapabilities._meta.goose.credentialMigration.failures` of an initialize response,
 * the place `failures_meta` in crates/goose/src/config/credential_migration.rs puts them. The key
 * is absent when nothing failed; entries that do not have the expected shape are skipped.
 */
export function parseCredentialMigrationFailures(
  initializeResponse: Pick<InitializeResponse, 'agentCapabilities'>
): CredentialMigrationFailure[] {
  const meta: unknown = initializeResponse.agentCapabilities?._meta;
  if (!isRecord(meta)) {
    return [];
  }
  const goose = meta.goose;
  if (!isRecord(goose)) {
    return [];
  }
  const migration = goose.credentialMigration;
  if (!isRecord(migration)) {
    return [];
  }
  const entries: unknown = migration.failures;
  if (!Array.isArray(entries)) {
    return [];
  }

  const failures: CredentialMigrationFailure[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      continue;
    }
    const { owner, name, stage, message } = entry;
    const knownOwner = OWNERS.find((candidate) => candidate === owner);
    const knownStage = STAGES.find((candidate) => candidate === stage);
    if (!knownOwner || !knownStage || typeof name !== 'string' || name === '') {
      continue;
    }
    failures.push({
      owner: knownOwner,
      name,
      stage: knownStage,
      message: typeof message === 'string' ? message : '',
    });
  }
  return failures;
}

/** Migration failures reported by the connected Kernel. */
export async function getCredentialMigrationFailures(): Promise<CredentialMigrationFailure[]> {
  return parseCredentialMigrationFailures(await getAcpInitializeResponse());
}

/**
 * Calls `listener` whenever the connection to the Kernel has been re-established. A restarted
 * Kernel has tried the migration again, so its failures may have changed.
 */
export function subscribeToCredentialMigrationRefresh(listener: () => void): () => void {
  return subscribeToAcpRecovery((recovering) => {
    if (!recovering) {
      listener();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

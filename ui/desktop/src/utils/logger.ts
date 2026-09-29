import log from 'electron-log';
import path from 'node:path';
import { app } from 'electron';
import { redactLogData } from './logRedaction';

log.transports.file.resolvePathFn = () => {
  return path.join(app.getPath('userData'), 'logs', 'main.log');
};

log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? false : 'debug';

type SecretSource = () => Iterable<string>;

const secretSources: SecretSource[] = [];

/**
 * Adds a source of key values that must never appear in the logs (requirement 1.10), such as
 * the values the credential store handled in this session. Sources are read on every entry,
 * so values that turn up later are masked too.
 */
export function registerLogSecrets(source: SecretSource): void {
  secretSources.push(source);
}

// Runs before every transport (file, console, renderer), so no transport sees a key value.
log.hooks.push((message) => {
  const secrets = secretSources.flatMap((source) => [...source()]);
  return secrets.length > 0 ? { ...message, data: redactLogData(message.data, secrets) } : message;
});

export default log;

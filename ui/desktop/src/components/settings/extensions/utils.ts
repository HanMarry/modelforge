import type { FixedExtensionEntry } from '../../ConfigContext';
import type { ExtensionConfig } from '../../../types/extensions';
import {
  headerRowsFrom,
  headersForSubmit,
  isSecretReference,
} from '../providers/modal/subcomponents/forms/sensitiveHeaders';

// Default extension timeout in seconds
// TODO: keep in sync with rust better

export const DEFAULT_EXTENSION_TIMEOUT = 300;

/**
 * Converts an extension name to a key format
 * TODO: need to keep this in sync better with `name_to_key` on the rust side
 */
export function nameToKey(name: string): string {
  return name
    .split('')
    .filter((char) => !char.match(/\s/))
    .join('')
    .toLowerCase();
}

/** One request header of the extension editor. */
export interface ExtensionHeaderRow {
  key: string;
  /** Value typed in the editor. Empty for a saved sensitive value that was not replaced. */
  value: string;
  isEdited?: boolean;
  /** Kept in the credential store instead of the config file (requirements 1.1, 1.11). */
  sensitive?: boolean;
  /**
   * Secret reference of a value that is already in the credential store. It is sent back
   * unchanged when no new value is typed, which keeps the saved value; it is never shown.
   */
  storedReference?: string | null;
}

export interface ExtensionFormData {
  name: string;
  description: string;
  type: 'stdio' | 'streamable_http' | 'builtin';
  cmd?: string;
  endpoint?: string;
  enabled: boolean;
  timeout?: number;
  envVars: {
    key: string;
    value: string;
    isEdited?: boolean;
  }[];
  headers: ExtensionHeaderRow[];
  installation_notes?: string;
  available_tools?: string[];
  // streamable_http fields with no form input yet; carried through so an
  // unrelated edit does not strip them from the saved config.
  socket?: string | null;
  client_id?: string | null;
  client_secret_key?: string | null;
  scopes?: string[];
}

export function getDefaultFormData(): ExtensionFormData {
  return {
    name: '',
    description: '',
    type: 'stdio',
    cmd: '',
    endpoint: '',
    enabled: true,
    timeout: 300,
    envVars: [],
    headers: [],
  };
}

export function extensionToFormData(extension: FixedExtensionEntry): ExtensionFormData {
  // Type guard: Check if 'envs' property exists for this variant
  const hasEnvs = extension.type === 'streamable_http' || extension.type === 'stdio';

  // Handle both envs (legacy) and env_keys (new secrets)
  const envVars: ExtensionFormData['envVars'] = [];

  // Add legacy envs with their values
  if (hasEnvs && extension.envs) {
    envVars.push(
      ...Object.entries(extension.envs).map(([key, value]) => ({
        key,
        value: value as string,
        isEdited: true, // We want to submit legacy values as secrets to migrate forward
      }))
    );
  }

  const headerValues: Record<string, string> =
    extension.type === 'streamable_http' && 'headers' in extension && extension.headers
      ? { ...extension.headers }
      : {};
  const headerNames = new Set(Object.keys(headerValues).map(normalizeHeaderName));

  // Add env_keys with placeholder values. An entry that names a request header is the
  // sensitive mark of that header (task 2.12), not an environment variable.
  const headerMarks: string[] = [];
  if (hasEnvs && extension.env_keys) {
    for (const key of extension.env_keys) {
      if (headerNames.has(normalizeHeaderName(key))) {
        headerMarks.push(key);
      } else {
        envVars.push({
          key,
          value: '••••••••', // Placeholder for secret values
          isEdited: false, // Mark as not edited initially
        });
      }
    }
  }

  // Handle headers for streamable_http. A value kept in the credential store comes back as its
  // secret reference; the row keeps it to send back and never shows it (requirement 1.11).
  const headers: ExtensionHeaderRow[] = headerRowsFrom({
    headers: headerValues,
    sensitive_headers: headerMarks,
  }).map((row) => ({ ...row, isEdited: false }));

  const availableTools =
    'available_tools' in extension
      ? availableToolsOrUndefined(extension.available_tools)
      : undefined;

  return {
    name: extension.name || '',
    description: extension.description || '',
    type: extension.type === 'platform' ? 'stdio' : extension.type,
    cmd:
      extension.type === 'stdio'
        ? combineCmdAndArgs(extension.cmd, extension.args ?? [])
        : undefined,
    endpoint: extension.type === 'streamable_http' ? (extension.uri ?? undefined) : undefined,
    enabled: extension.enabled,
    timeout: 'timeout' in extension ? (extension.timeout ?? undefined) : undefined,
    envVars,
    headers,
    installation_notes: (extension as Record<string, unknown>)['installation_notes'] as
      string | undefined,
    ...(availableTools ? { available_tools: availableTools } : {}),
    ...(extension.type === 'streamable_http'
      ? {
          socket: extension.socket,
          client_id: extension.client_id,
          client_secret_key: extension.client_secret_key,
          scopes: extension.scopes,
        }
      : {}),
  };
}

function availableToolsOrUndefined(availableTools?: string[] | null): string[] | undefined {
  return availableTools && availableTools.length > 0 ? availableTools : undefined;
}

function availableToolsConfig(availableTools?: string[] | null) {
  const normalized = availableToolsOrUndefined(availableTools);
  return normalized ? { available_tools: normalized } : undefined;
}

/** Header names are case-insensitive. */
function normalizeHeaderName(name: string): string {
  return name.trim().toLowerCase();
}

/** `$NAME` or `${NAME}`, the same pattern as `variable_pattern` in extension_credentials.rs. */
const VARIABLE_PATTERN = /\$\{[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Whether `value` takes its credential from one of the extension's variables. */
function refersToVariable(value: string, variables: string[]): boolean {
  for (const match of value.matchAll(VARIABLE_PATTERN)) {
    const name = match[1] ?? match[2];
    if (name && variables.includes(name)) {
      return true;
    }
  }
  return false;
}

/**
 * Header values and sensitive marks to save for a streamable_http extension, following the
 * contract of crates/goose/src/config/extension_credentials.rs (task 2.12):
 * - a saved sensitive value that was not replaced goes back as its own secret reference, which
 *   the Kernel keeps as is;
 * - a header the user marked as sensitive is listed in `env_keys`; the Kernel stores its value,
 *   puts the reference in its place and drops the mark. Auth header names are sensitive on the
 *   Kernel side anyway, so they are not listed, the same as for custom providers.
 * A value that refers to one of `variables` is never stored, so its header is not marked: a mark
 * left in `env_keys` would be looked up as a secret when the extension starts.
 */
export function headersConfigFrom(
  rows: ExtensionHeaderRow[],
  variables: string[]
): { headers: Record<string, string>; marks: string[] } {
  const { headers, sensitiveHeaders } = headersForSubmit(
    rows.map((row) => ({
      key: row.key,
      value: row.value,
      sensitive: row.sensitive ?? false,
      storedReference: row.storedReference ?? null,
    }))
  );
  const marks = sensitiveHeaders.filter((name) => {
    const value = headers[name];
    return !isSecretReference(value) && !refersToVariable(value, variables);
  });
  return { headers, marks };
}

export function createExtensionConfig(formData: ExtensionFormData): ExtensionConfig {
  // Extract just the keys from env vars
  const env_keys = formData.envVars.map(({ key }) => key).filter((key) => key.length > 0);

  if (formData.type === 'stdio') {
    // we put the cmd + args all in the form cmd field but need to split out into cmd + args
    const { cmd, args } = splitCmdAndArgs(formData.cmd || '');

    return {
      type: 'stdio',
      name: formData.name,
      description: formData.description,
      cmd: cmd,
      args: args,
      timeout: formData.timeout,
      ...(env_keys.length > 0 ? { env_keys } : {}),
      ...availableToolsConfig(formData.available_tools),
    };
  } else if (formData.type === 'streamable_http') {
    const { headers, marks } = headersConfigFrom(formData.headers, env_keys);
    const allEnvKeys = [...env_keys];
    for (const mark of marks) {
      if (!allEnvKeys.some((key) => normalizeHeaderName(key) === normalizeHeaderName(mark))) {
        allEnvKeys.push(mark);
      }
    }

    return {
      type: 'streamable_http',
      name: formData.name,
      description: formData.description,
      timeout: formData.timeout,
      uri: formData.endpoint || '',
      ...(allEnvKeys.length > 0 ? { env_keys: allEnvKeys } : {}),
      headers,
      ...availableToolsConfig(formData.available_tools),
      ...(formData.socket != null ? { socket: formData.socket } : {}),
      ...(formData.client_id != null ? { client_id: formData.client_id } : {}),
      ...(formData.client_secret_key != null
        ? { client_secret_key: formData.client_secret_key }
        : {}),
      ...(formData.scopes?.length ? { scopes: formData.scopes } : {}),
    };
  }

  return {
    type: formData.type,
    name: formData.name,
    description: formData.description,
    timeout: formData.timeout,
    ...availableToolsConfig(formData.available_tools),
  };
}

function isWindowsPlatform(): boolean {
  return typeof window !== 'undefined' && window.electron?.platform === 'win32';
}

export function splitCmdAndArgs(str: string): { cmd: string; args: string[] } {
  const trimmed = str.trim();
  if (!trimmed) {
    return { cmd: '', args: [] };
  }

  const words = parseCommandLine(trimmed, isWindowsPlatform());

  const cmd = words[0] || '';
  const args = words.slice(1);

  return {
    cmd,
    args,
  };
}

function parseCommandLine(value: string, windows: boolean): string[] {
  const words: string[] = [];
  let word = '';
  let wordStarted = false;
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];

    if (windows && quote !== "'" && character === '\\') {
      let runEnd = index;
      while (value[runEnd] === '\\') {
        runEnd += 1;
      }

      const backslashCount = runEnd - index;
      if (value[runEnd] === '"') {
        word += '\\'.repeat(Math.floor(backslashCount / 2));
        if (backslashCount % 2 === 0) {
          quote = quote === '"' ? undefined : '"';
        } else {
          word += '"';
        }
        index = runEnd;
      } else {
        word += '\\'.repeat(backslashCount);
        index = runEnd - 1;
      }
      wordStarted = true;
    } else if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (quote === '"' && character === '\\' && index + 1 < value.length) {
        const next = value[index + 1];
        if (next === '"' || next === '\\' || next === '$') {
          word += next;
          index += 1;
        } else {
          word += character;
        }
      } else {
        word += character;
      }
      wordStarted = true;
    } else if (/\s/.test(character)) {
      if (wordStarted) {
        words.push(word);
        word = '';
        wordStarted = false;
      }
    } else if (character === '"' || (!windows && character === "'")) {
      quote = character;
      wordStarted = true;
    } else if (character === '\\' && !windows && index + 1 < value.length) {
      word += value[index + 1];
      wordStarted = true;
      index += 1;
    } else {
      word += character;
      wordStarted = true;
    }
  }

  if (wordStarted) {
    words.push(word);
  }

  return words;
}

export function combineCmdAndArgs(cmd: string, args: string[]): string {
  const windows = isWindowsPlatform();
  return [cmd, ...args].map((value) => quoteCommandPart(value, windows)).join(' ');
}

function quoteCommandPart(value: string, windows: boolean): string {
  if (windows) {
    return quoteWindowsCommandPart(value);
  }

  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function quoteWindowsCommandPart(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) {
    return value;
  }

  let quoted = '"';
  let backslashCount = 0;

  for (const character of value) {
    if (character === '\\') {
      backslashCount += 1;
    } else if (character === '"') {
      quoted += '\\'.repeat(backslashCount * 2 + 1) + character;
      backslashCount = 0;
    } else {
      quoted += '\\'.repeat(backslashCount) + character;
      backslashCount = 0;
    }
  }

  return quoted + '\\'.repeat(backslashCount * 2) + '"';
}

export function extractCommand(link: string): string {
  const url = new URL(link);
  const cmd = url.searchParams.get('cmd') || 'Unknown Command';
  const args = url.searchParams.getAll('arg').map(decodeURIComponent);

  // Combine the command and its arguments into a reviewable format
  return `${cmd} ${args.join(' ')}`.trim();
}

export function extractExtensionName(link: string): string {
  const url = new URL(link);
  const name = url.searchParams.get('name');
  return name ? decodeURIComponent(name) : 'Unknown Extension';
}

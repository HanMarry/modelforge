/**
 * Header names that always carry credentials, compared case-insensitively. Kept in sync with
 * AUTH_HEADER_NAMES in crates/goose/src/config/secret_headers.rs (requirement 1.1).
 */
const AUTH_HEADER_NAMES = ['authorization', 'proxy-authorization', 'x-api-key', 'api-key'];

/** Start of a value that refers to the credential store instead of holding the credential. */
const SECRET_REFERENCE_PREFIX = '${secret:';

/** Shown instead of a saved sensitive value, which is never read back. */
export const SAVED_VALUE_MASK = '••••••••';

export function isAuthHeaderName(name: string): boolean {
  return AUTH_HEADER_NAMES.includes(name.trim().toLowerCase());
}

export function isSecretReference(value: string): boolean {
  return value.startsWith(SECRET_REFERENCE_PREFIX);
}

/** One row of the custom headers editor. */
export interface HeaderRow {
  key: string;
  /** Value typed in this form. Empty for a saved sensitive value that was not replaced. */
  value: string;
  /** Kept in the credential store instead of the provider file. */
  sensitive: boolean;
  /**
   * Secret reference of a value that is already in the credential store. It is sent back
   * unchanged when no new value is typed, which keeps the saved value; it is never shown.
   */
  storedReference: string | null;
}

export interface HeaderRowsSource {
  headers?: Record<string, string> | null;
  sensitive_headers?: string[];
  stored_secret_headers?: string[];
}

/** Builds the editor rows for a saved provider without exposing saved sensitive values. */
export function headerRowsFrom(source: HeaderRowsSource): HeaderRow[] {
  const stored = new Set(source.stored_secret_headers ?? []);
  const marked = (source.sensitive_headers ?? []).map((name) => name.trim().toLowerCase());
  return Object.entries(source.headers ?? {}).map(([key, value]) => {
    const isStored = stored.has(key) || isSecretReference(value);
    return {
      key,
      value: isStored ? '' : value,
      sensitive: isStored || isAuthHeaderName(key) || marked.includes(key.trim().toLowerCase()),
      storedReference: isStored ? value : null,
    };
  });
}

/** Whether the row is treated as sensitive: auth header names always are. */
export function isSensitiveRow(row: Pick<HeaderRow, 'key' | 'sensitive'>): boolean {
  return row.sensitive || isAuthHeaderName(row.key);
}

/**
 * Header values and sensitive marks to submit. A saved sensitive value that was not replaced is
 * sent as its secret reference, which the Kernel keeps as is. Auth header names are sensitive
 * on the Kernel side anyway, so only other headers are listed as marks.
 */
export function headersForSubmit(rows: HeaderRow[]): {
  headers: Record<string, string>;
  sensitiveHeaders: string[];
} {
  const headers: Record<string, string> = {};
  const sensitiveHeaders: string[] = [];
  for (const row of rows) {
    const key = row.key.trim();
    const value = row.value.trim() || row.storedReference || '';
    if (!key || !value) continue;
    headers[key] = value;
    if (row.sensitive && !isAuthHeaderName(key)) {
      sensitiveHeaders.push(key);
    }
  }
  return { headers, sensitiveHeaders };
}

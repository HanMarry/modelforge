/**
 * Result shape shared by the main-process IPC handlers added for the MathModel parity work:
 * `{ ok: true, data } | { ok: false, error }`. Error messages leave the main process only
 * through `toIpcError`, which masks every known key value (requirement 1.10).
 */
import { redactText } from './secretMask';

export interface IpcError {
  /** Stable machine-readable code the renderer maps to a localized message. */
  code: string;
  /** English detail, already masked; safe to log or show. */
  message: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

export function toIpcError(code: string, cause: unknown, secrets: Iterable<string>): IpcError {
  return { code, message: redactText(describeError(cause), secrets) };
}

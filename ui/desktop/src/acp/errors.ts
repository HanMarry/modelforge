import { RequestError } from '@agentclientprotocol/sdk';
import { errorMessage } from '../utils/conversionUtils';

export interface AcpCreditsExhaustedError {
  message: string;
  url?: string;
}

const CREDITS_EXHAUSTED_REASON = 'credits_exhausted';
const AUTH_REQUIRED_CODE = -32000;

// Kept in sync with RECIPE_PARAMS_CANCELLED_REASON in crates/goose/src/acp/server/recipe.rs.
const RECIPE_PARAMS_CANCELLED_REASON = 'recipe_params_cancelled';

export const RECIPE_PARAMETER_SCOPES_UNSUPPORTED_MESSAGE =
  'The connected Goose server does not support securely scoped deeplink recipe parameters. Update the server and try again.';

export class RecipeParameterScopesUnsupportedError extends Error {
  constructor() {
    super(RECIPE_PARAMETER_SCOPES_UNSUPPORTED_MESSAGE);
    this.name = 'RecipeParameterScopesUnsupportedError';
  }
}

export function isRecipeParameterScopesUnsupported(
  error: unknown
): error is RecipeParameterScopesUnsupportedError {
  return error instanceof RecipeParameterScopesUnsupportedError;
}

export function isRecipeParamsCancelled(error: unknown): boolean {
  return asAcpJsonRpcError(error)?.data?.reason === RECIPE_PARAMS_CANCELLED_REASON;
}

export function parseAcpCreditsExhaustedError(error: unknown): AcpCreditsExhaustedError | null {
  const jsonRpcError = asAcpJsonRpcError(error);
  if (jsonRpcError?.data?.reason !== CREDITS_EXHAUSTED_REASON) {
    return null;
  }

  const url = typeof jsonRpcError.data.url === 'string' ? jsonRpcError.data.url : undefined;

  return {
    message: jsonRpcError.message,
    ...(url ? { url } : {}),
  };
}

/**
 * `error.data.code` values the Kernel attaches to custom provider credential failures
 * (crates/goose/src/acp/server/providers.rs).
 */
export type AcpProviderErrorCode =
  | 'SECRET_UNRESOLVED'
  | 'CREDENTIAL_WRITE_FAILED'
  | 'CONFIG_WRITE_FAILED'
  | 'INVALID_HEADER';

const PROVIDER_ERROR_CODES: readonly AcpProviderErrorCode[] = [
  'SECRET_UNRESOLVED',
  'CREDENTIAL_WRITE_FAILED',
  'CONFIG_WRITE_FAILED',
  'INVALID_HEADER',
];

export interface AcpProviderError {
  code: AcpProviderErrorCode;
  /** Display name of the provider. */
  provider: string;
  /** Header involved, for SECRET_UNRESOLVED and INVALID_HEADER. */
  header?: string;
  reason: string;
  message: string;
}

function isProviderErrorCode(value: unknown): value is AcpProviderErrorCode {
  return PROVIDER_ERROR_CODES.some((code) => code === value);
}

export function parseAcpProviderError(error: unknown): AcpProviderError | null {
  const jsonRpcError = asAcpJsonRpcError(error);
  if (!jsonRpcError) {
    return null;
  }

  const { code, provider, header, reason, message } = jsonRpcError.data;
  if (!isProviderErrorCode(code) || typeof provider !== 'string') {
    return null;
  }

  return {
    code,
    provider,
    ...(typeof header === 'string' ? { header } : {}),
    reason: typeof reason === 'string' ? reason : '',
    message: typeof message === 'string' ? message : jsonRpcError.message,
  };
}

export function formatAcpError(error: unknown): string {
  if (error instanceof RequestError && error.code === AUTH_REQUIRED_CODE) {
    return 'Sign in to your provider, then try again.';
  }
  const providerError = parseAcpProviderError(error);
  if (providerError?.code === 'SECRET_UNRESOLVED' && providerError.header) {
    const { provider, header, reason } = providerError;
    return (
      `Provider "${provider}" can't read the credential for header "${header}" (${reason}). ` +
      'Re-enter the header value in the provider settings, then try again.'
    );
  }
  return errorMessage(error);
}

interface AcpJsonRpcError {
  message: string;
  data: Record<string, unknown>;
}

function asAcpJsonRpcError(error: unknown): AcpJsonRpcError | null {
  if (!isRecord(error)) {
    return null;
  }

  const candidate = isRecord(error.error) ? error.error : error;
  if (typeof candidate.message !== 'string' || !isRecord(candidate.data)) {
    return null;
  }

  return {
    message: candidate.message,
    data: candidate.data,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function acpErrorMessage(error: unknown): string | null {
  if (!isRecord(error)) {
    return null;
  }

  const candidate = 'error' in error && isRecord(error.error) ? error.error : error;
  if (!isRecord(candidate)) {
    return null;
  }
  if (typeof candidate.data === 'string') {
    return candidate.data;
  }
  return typeof candidate.message === 'string' ? candidate.message : null;
}

export function normalizeAcpError(error: unknown, fallback: string): Error {
  const message = acpErrorMessage(error);
  if (message) {
    return new Error(message);
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(fallback);
}

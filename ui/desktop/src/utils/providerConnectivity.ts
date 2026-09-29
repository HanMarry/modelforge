/**
 * Provider connectivity test and error classification (spec mathmodel-parity-and-beyond,
 * requirement 5.2, 5.3, 6.2). The wizard sends one connectivity request to the chosen
 * provider; the diagnostics centre uses the same request for the provider category. Any
 * failure is folded into exactly one of six classes so the UI can show a precise message
 * and keep the user's input for a retry.
 */

export const PROVIDER_CONNECT_TIMEOUT_MS = 15_000;

export type ProviderErrorClass =
  | 'invalid_key'
  | 'network'
  | 'quota'
  | 'model_unsupported'
  | 'timeout'
  | 'other';

/** Chinese labels shown for each failure class (requirement 5.3). */
export const PROVIDER_ERROR_LABELS: Record<ProviderErrorClass, string> = {
  invalid_key: '密钥无效',
  network: '网络不可达',
  quota: '配额不足',
  model_unsupported: '模型不支持',
  timeout: '请求超时',
  other: '其他错误',
};

export interface ProviderConnectionTarget {
  /** Provider endpoint, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /**
   * Header that carries the key. Defaults to `Authorization` (sent as `Bearer <key>`); any
   * other header name is sent with the raw key as its value.
   */
  authHeader?: string;
  /** Overrides the default 15 second timeout. */
  timeoutMs?: number;
}

export interface ProviderConnectionFailure {
  /** HTTP status, or null when no response arrived (network failure, timeout or abort). */
  status: number | null;
  /** Response body when the provider answered with an error status. */
  body: string;
  /** The underlying exception (a network error or an abort/timeout). */
  cause: unknown;
}

export type ProviderConnectionResult =
  | { ok: true }
  | { ok: false; failure: ProviderConnectionFailure };

function headerValueFor(header: string, key: string): string {
  return header.toLowerCase() === 'authorization' ? `Bearer ${key}` : key;
}

/**
 * Sends one request to `<baseUrl>/models`. A 2xx answer means the key reached the provider;
 * any other status, or a thrown network/timeout error, comes back as a failure the caller
 * hands to `classifyProviderError`.
 */
export async function testProviderConnection(
  target: ProviderConnectionTarget,
  key: string,
  signal?: globalThis.AbortSignal
): Promise<ProviderConnectionResult> {
  const base = target.baseUrl.trim().replace(/\/+$/, '');
  const url = `${base}/models`;
  const authHeader = target.authHeader ?? 'Authorization';
  const timeoutMs = target.timeoutMs ?? PROVIDER_CONNECT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => controller.abort();
  signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        [authHeader]: headerValueFor(authHeader, key),
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true };
    }
    const body = await response.text().catch(() => '');
    return { ok: false, failure: { status: response.status, body, cause: null } };
  } catch (error) {
    return { ok: false, failure: { status: null, body: '', cause: error } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onExternalAbort);
  }
}

function isTimeoutCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }
  return (
    cause.name === 'AbortError' ||
    cause.name === 'TimeoutError' ||
    /timeout|timed out|abort/i.test(cause.message)
  );
}

const QUOTA_BODY = /quota|insufficient|rate limit|billing|balance|429/i;
const MODEL_BODY = /model.*(not found|not supported|does not exist|invalid|unknown)|not found|not supported|does not exist/i;

/**
 * Folds an HTTP status, response body and underlying error into exactly one of six classes
 * (requirement 5.3). A timeout or abort always maps to `timeout`; a missing response maps to
 * `network`; 401/403 to `invalid_key`; 402/429 or quota wording to `quota`; 404 or model
 * wording to `model_unsupported`; everything else to `other`.
 */
export function classifyProviderError(
  status: number | null,
  body: string,
  cause: unknown
): ProviderErrorClass {
  if (isTimeoutCause(cause) || status === 408 || status === 504) {
    return 'timeout';
  }
  if (status === null) {
    return 'network';
  }
  if (status === 401 || status === 403) {
    return 'invalid_key';
  }
  if (status === 402 || status === 429 || QUOTA_BODY.test(body)) {
    return 'quota';
  }
  if (status === 404 || MODEL_BODY.test(body)) {
    return 'model_unsupported';
  }
  return 'other';
}

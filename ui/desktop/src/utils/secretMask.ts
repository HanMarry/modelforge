/**
 * Masking rule for API keys and auth header values in logs, errors and exports
 * (requirement 1.10, 6.7). The kernel applies the same rule in
 * crates/goose/src/logging/secret_mask.rs; both are checked against
 * fixtures/secret-mask-vectors.json.
 *
 * The output never reveals the length: always eight asterisks, followed by the last four code
 * points when the value is longer than eight.
 */
export const MASK_PREFIX = '********';

/** Values this short would match ordinary text, so they are not searched for. */
const MIN_REDACT_CODE_POINTS = 5;

function codePoints(value: string): string[] {
  return Array.from(value);
}

export function maskSecret(value: string): string {
  const points = codePoints(value);
  if (points.length <= 8) {
    return MASK_PREFIX;
  }
  return MASK_PREFIX + points.slice(-4).join('');
}

/** Code point order, which is also how the kernel's byte-wise `str` ordering sorts. */
function compareCodePoints(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i += 1) {
    const diff = (left[i].codePointAt(0) ?? 0) - (right[i].codePointAt(0) ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return left.length - right.length;
}

/**
 * Replaces every known secret in `text` with its mask. Longer secrets go first so a secret that
 * contains another is replaced whole; ties are ordered by code point so both implementations
 * agree when two secrets overlap.
 */
export function redactText(text: string, secrets: Iterable<string>): string {
  const candidates = [...new Set(secrets)]
    .filter((secret) => codePoints(secret).length >= MIN_REDACT_CODE_POINTS)
    .sort(
      (a, b) => codePoints(b).length - codePoints(a).length || compareCodePoints(a, b)
    );

  let result = text;
  for (const secret of candidates) {
    if (result.includes(secret)) {
      result = result.split(secret).join(maskSecret(secret));
    }
  }
  return result;
}

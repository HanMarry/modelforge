/**
 * Code-point truncation shared by the browser panel body (100,000), gallery card titles (200,
 * with ellipsis) and abstracts (300), and the Feishu summary (2,000) — requirements 12.2, 13.1
 * and 15.2. Counting happens over code points, never UTF-16 units, so a surrogate pair is never
 * split in half.
 */
export interface TruncateResult {
  text: string;
  truncated: boolean;
}

export interface TruncateOptions {
  /** Appended when the text is cut; its code points count toward the limit. */
  ellipsis?: string;
}

export function truncateText(
  value: string,
  limit: number,
  options: TruncateOptions = {}
): TruncateResult {
  const points = Array.from(value);
  if (points.length <= limit) {
    return { text: value, truncated: false };
  }

  const { ellipsis } = options;
  if (!ellipsis) {
    return { text: points.slice(0, limit).join(''), truncated: true };
  }

  const ellipsisLength = Array.from(ellipsis).length;
  const keep = limit - ellipsisLength;
  // The ellipsis alone would already reach or exceed the limit, so it cannot be appended while
  // staying within the limit.
  if (keep <= 0) {
    return { text: points.slice(0, limit).join(''), truncated: true };
  }
  return { text: points.slice(0, keep).join('') + ellipsis, truncated: true };
}

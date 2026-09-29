/**
 * Code-point-safe text truncation (requirement 15.2, 15.7 and 16.1).
 *
 * // 与 s1-browser-gallery 的 textTruncate.ts 合并时去重
 *
 * The ellipsis counts toward `limit`, so the returned string never exceeds `limit` code
 * points. Splitting is done on code points, so a surrogate pair (a character outside the
 * Basic Multilingual Plane) is never cut in half.
 */
export interface TruncateOptions {
  ellipsis?: string;
}

export function truncateText(s: string, limit: number, options: TruncateOptions = {}): string {
  const points = Array.from(s);
  if (points.length <= limit) {
    return s;
  }
  if (limit <= 0) {
    return '';
  }
  const marker = Array.from(options.ellipsis ?? '…');
  const head = points.slice(0, Math.max(0, limit - marker.length));
  const tail = marker.slice(0, Math.max(0, limit - head.length));
  return head.concat(tail).join('');
}

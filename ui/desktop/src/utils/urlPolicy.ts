// 与 s1-catalog 的 urlPolicy.ts 合并时去重

/**
 * Only http: and https: may be loaded in the built-in browser panel (requirement 12.5).
 * `javascript:`, `file:`, `data:`, `chrome:` and anything that does not parse are rejected.
 * The URL parser lower-cases the protocol, so an input written as `HTTPS://…` is accepted.
 */
export function isAllowedUrl(input: string): boolean {
  try {
    const protocol = new URL(input).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

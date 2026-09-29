/**
 * URL protocol allow-list for the in-app browser and competition "official site" links.
 *
 * Only `http:`/`https:` are allowed (requirements 8.9 and 12.5). The competition hub
 * opens a confirmed site with `shell.openExternal`, and the browser panel refuses every
 * other scheme; both call this single function so the rule cannot drift.
 */
export function isAllowedUrl(input: string): boolean {
  if (typeof input !== 'string' || input.trim() === '') {
    return false;
  }
  try {
    const parsed = new URL(input);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

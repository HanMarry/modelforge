/**
 * LAN collab access control (requirement 14.5, 14.7).
 *
 * `authorize` is a pure function over a request, the guest's role, the host-selected share
 * set and the exclusion set. Only files inside the share set and outside the exclusion set can
 * be listed or read; text edits additionally require the editable role, while comments are
 * accepted from both roles.
 *
 * The mandatory exclusion patterns mirror task 17.1's forced exclusions
 * (`.modelforge/sessions/**`, `*.log`, `.env*`, `**/credentials*`,
 * `agent-kernel-secrets.json`). The share filter that computes the share set is owned by the
 * gallery workstream (`shareFilter.ts`); this module only applies it.
 */

export const MANDATORY_EXCLUDE_PATTERNS: readonly string[] = [
  '.modelforge/sessions/**',
  '*.log',
  '.env*',
  '**/credentials*',
  'agent-kernel-secrets.json',
];

export type CollabGuestRole = 'read-only' | 'editable';

export interface CollabGuest {
  displayName: string;
  role: CollabGuestRole;
}

export type CollabRequestKind = 'list' | 'read' | 'edit' | 'comment';

export interface CollabRequest {
  kind: CollabRequestKind;
  /** Project-relative path, `\` separators tolerated. */
  path: string;
}

/** Collapses `\` separators, strips `./` prefixes and normalizes duplicate slashes. */
export function normalizeCollabPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

const escapeRegExp = (ch: string): string => /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;

function segmentToRegex(segment: string): string {
  let out = '';
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (ch === '*') {
      while (segment[i + 1] === '*') i += 1;
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

/** Matches a single path segment, `*` and `?` as wildcards (no `/`). */
function matchSegment(segment: string, pathSegment: string): boolean {
  return new RegExp(`^${segmentToRegex(segment)}$`).test(pathSegment);
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) {
    return path.length === 0;
  }
  const head = pattern[0];
  if (head === '**') {
    for (let consumed = 0; consumed <= path.length; consumed += 1) {
      if (matchSegments(pattern.slice(1), path.slice(consumed))) {
        return true;
      }
    }
    return false;
  }
  if (path.length === 0 || !matchSegment(head, path[0])) {
    return false;
  }
  return matchSegments(pattern.slice(1), path.slice(1));
}

/**
 * Minimal `*`/`**`/`?` glob matcher over `/`-separated relative paths. `**` matches zero or
 * more whole segments; `*` and `?` stay within a segment.
 */
export function globMatch(pattern: string, path: string): boolean {
  const patSegments = normalizeCollabPath(pattern).split('/').filter((segment) => segment !== '');
  const pathSegments = normalizeCollabPath(path).split('/').filter((segment) => segment !== '');
  return matchSegments(patSegments, pathSegments);
}

/**
 * A path is excluded when it matches any pattern. Patterns without a `/` also match the
 * basename, so `*.log` and `.env*` cover files in nested directories.
 */
export function isExcludedPath(path: string, patterns: readonly string[]): boolean {
  const normalized = normalizeCollabPath(path);
  const segments = normalized.split('/');
  const basename = segments[segments.length - 1] ?? normalized;
  return patterns.some(
    (pattern) =>
      globMatch(pattern, normalized) ||
      (!pattern.includes('/') && globMatch(pattern, basename))
  );
}

export function authorize(
  request: CollabRequest,
  guest: CollabGuest,
  shareSet: ReadonlySet<string>,
  excludeSet: readonly string[]
): boolean {
  const normalized = normalizeCollabPath(request.path);
  if (!shareSet.has(normalized) || isExcludedPath(normalized, excludeSet)) {
    return false;
  }
  if (request.kind === 'edit') {
    return guest.role === 'editable';
  }
  return true;
}

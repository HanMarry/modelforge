/**
 * Share package file filtering (requirement 13.2, 13.3). Forced exclusions always win over a
 * user's checked files, so a share package can never carry credentials, session logs or content
 * that embeds a known secret value.
 */
export type ShareExclusionReason =
  | 'sessions'
  | 'log'
  | 'env'
  | 'credentials'
  | 'kernel-secrets'
  | 'sensitive-content';

export interface ShareFilterPolicy {
  /** Paths whose content matched a known sensitive value, decided at the I/O layer (17.5). */
  sensitiveContent: ReadonlySet<string>;
}

export interface ExcludedFile {
  path: string;
  reason: ShareExclusionReason;
}

export interface ShareFilterResult {
  /** Checked files that survived the exclusion rules, in candidate order. */
  selected: string[];
  /** Every candidate a forced rule rejected, with the reason, for the export dialog to show. */
  excluded: ExcludedFile[];
}

const PATH_RULE_REASONS = [
  'sessions',
  'log',
  'env',
  'credentials',
  'kernel-secrets',
] as const satisfies readonly Exclude<ShareExclusionReason, 'sensitive-content'>[];

/** The path-based rules that apply regardless of what the user checked. */
export function forcedExclusionReason(
  path: string
): Exclude<ShareExclusionReason, 'sensitive-content'> | null {
  const segments = path.replace(/\\/g, '/').split('/');
  const basename = (segments[segments.length - 1] ?? '').toLowerCase();

  const modelforge = segments.indexOf('.modelforge');
  if (modelforge !== -1 && segments[modelforge + 1] === 'sessions') return 'sessions';
  if (basename.endsWith('.log')) return 'log';
  if (basename.startsWith('.env')) return 'env';
  if (segments.some((segment) => segment.toLowerCase().startsWith('credentials')))
    return 'credentials';
  if (basename === 'agent-kernel-secrets.json') return 'kernel-secrets';
  return null;
}

export function selectShareFiles(
  candidates: readonly string[],
  checked: ReadonlySet<string>,
  policy: ShareFilterPolicy
): ShareFilterResult {
  const selected: string[] = [];
  const excluded: ExcludedFile[] = [];

  for (const candidate of candidates) {
    const reason = forcedExclusionReason(candidate) ?? (policy.sensitiveContent.has(candidate) ? 'sensitive-content' : null);
    if (reason !== null) {
      excluded.push({ path: candidate, reason });
    } else if (checked.has(candidate)) {
      selected.push(candidate);
    }
  }

  return { selected, excluded };
}

export const SHARE_EXCLUSION_REASONS: readonly ShareExclusionReason[] = [
  ...PATH_RULE_REASONS,
  'sensitive-content',
];

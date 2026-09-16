/**
 * When to nudge the user about a filling context window.
 *
 * The bar already turns orange/red, but a colour change is easy to miss — and with an external
 * kernel the window that matters is the user's model, not the kernel's own.
 */
export type ContextWarningLevel = 0 | 1 | 2;

export const CONTEXT_WARNING_PERCENT = 80;
export const CONTEXT_CRITICAL_PERCENT = 95;

export function contextWarningLevel(used: number, limit: number): ContextWarningLevel {
  if (!limit || limit <= 0 || !used || used <= 0) {
    return 0;
  }
  const percent = (used / limit) * 100;
  if (percent >= CONTEXT_CRITICAL_PERCENT) {
    return 2;
  }
  if (percent >= CONTEXT_WARNING_PERCENT) {
    return 1;
  }
  return 0;
}

/** Levels only ever escalate within one session, so a warning never repeats. */
export function shouldAnnounce(
  level: ContextWarningLevel,
  lastAnnounced: ContextWarningLevel
): boolean {
  return level > lastAnnounced;
}

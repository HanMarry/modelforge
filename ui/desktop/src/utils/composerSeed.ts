/**
 * Hands a prompt from a catalogue page to the home composer.
 *
 * The composer lives inside the Hub view, so a catalogue page cannot pass it props
 * directly. A module-level slot survives the navigation to `/` and is taken exactly once
 * when the Hub mounts, which keeps the catalogue pages independent of any global store
 * while still letting "使用模板" actually shape what the agent does.
 */
export interface ComposerSeed {
  /** Stable id so the composer applies each seed once, even for repeated clicks. */
  id: string;
  text: string;
  mode?: 'append';
}

export function mergeComposerPreset(current: string, incoming: string, previous?: string): string {
  if (!current.trim()) return incoming;
  if (previous && current === previous) return incoming;
  if (previous && current.startsWith(`${previous}\n\n`))
    return incoming + current.slice(previous.length);
  if (previous && current.endsWith(`\n\n${previous}`))
    return current.slice(0, -previous.length) + incoming;
  return `${current.trimEnd()}\n\n${incoming}`;
}

let pending: ComposerSeed | null = null;

/** Queue a prompt for the next Hub mount. */
export function seedComposer(text: string, id: string = `seed-${Date.now()}`): void {
  pending = { id, text };
}

/** Take the queued prompt, clearing it so it is applied only once. */
export function takeComposerSeed(): ComposerSeed | null {
  const seed = pending;
  pending = null;
  return seed;
}

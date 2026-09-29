/**
 * Hands a freshly created Project to the home view (requirements 5.1 step 4, 8.3, 9.3).
 *
 * The competition page, example library and first-run wizard create a Project and then
 * navigate home; the home view picks the directory up here and opens it in the Project panel.
 * A module-level slot keeps this independent of router state, so the home view also works
 * when rendered outside a router (tests).
 */
type Listener = (dir: string) => void;

let pendingDir: string | null = null;
const listeners = new Set<Listener>();

/** Records `dir` as the Project to open; a mounted home view is notified right away. */
export function requestOpenProject(dir: string): void {
  if (!dir) return;
  if (listeners.size > 0) {
    pendingDir = null;
    for (const listener of listeners) listener(dir);
    return;
  }
  pendingDir = dir;
}

/** Returns and clears the Project waiting to be opened, if any. */
export function consumePendingProject(): string | null {
  const dir = pendingDir;
  pendingDir = null;
  return dir;
}

/** Subscribes a mounted home view to later requests; returns the unsubscribe function. */
export function onOpenProjectRequest(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

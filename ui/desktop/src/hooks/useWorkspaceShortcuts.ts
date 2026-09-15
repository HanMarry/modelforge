import { useEffect, useRef } from 'react';

interface WorkspaceShortcutHandlers {
  onTogglePanel: () => void;
  onToggleEditor: () => void;
}

/**
 * Keyboard access to the workspace surfaces: Cmd/Ctrl+Shift+B for the right panel and
 * Cmd/Ctrl+Shift+E for the editor column. Disabled for sessions that are mounted but hidden so
 * a background chat cannot react to the user's keystrokes.
 */
export function useWorkspaceShortcuts(enabled: boolean, handlers: WorkspaceShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;

    const handleKeyDown = (event: KeyboardEvent) => {
      const isMac = window.electron?.platform === 'darwin';
      const withModifier = isMac ? event.metaKey : event.ctrlKey;
      if (!withModifier || !event.shiftKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key !== 'e' && key !== 'b') return;

      event.preventDefault();
      if (key === 'e') handlersRef.current.onToggleEditor();
      else handlersRef.current.onTogglePanel();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}

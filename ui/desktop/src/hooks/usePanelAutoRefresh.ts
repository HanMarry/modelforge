import { useEffect, useRef } from 'react';

/**
 * Re-runs `refresh` on an interval while the agent is producing output, so panels
 * that mirror the working directory (file tree, diagram gallery) follow along
 * instead of going stale until the user clicks refresh.
 */
export function usePanelAutoRefresh(
  isAgentActive: boolean,
  refresh: () => void,
  intervalMs = 4000
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!isAgentActive) return undefined;
    const timer = window.setInterval(() => refreshRef.current(), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, isAgentActive]);
}

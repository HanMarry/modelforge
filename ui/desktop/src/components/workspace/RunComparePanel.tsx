import type { WorkspaceFeaturePanelProps } from './featurePanelProps';

/**
 * Run comparison tab (requirement 21, task 24.3). It is a workspace tab rather than a popover of
 * `ProjectPanel`, so it picks its two runs from `runsList` itself. C0 placeholder:
 * `mp/s2-c1-compare` replaces the body.
 */
export default function RunComparePanel(_props: WorkspaceFeaturePanelProps) {
  return <div className="h-full min-h-0" data-testid="run-compare-panel" />;
}

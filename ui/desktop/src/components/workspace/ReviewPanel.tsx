import type { WorkspaceFeaturePanelProps } from './featurePanelProps';

/**
 * Mock review tab (requirement 19, task 26.5). C0 placeholder: `mp/s2-c1-review` replaces the body
 * with paper and competition selection, scores, suggestions and the fixed disclaimer banner.
 */
export default function ReviewPanel(_props: WorkspaceFeaturePanelProps) {
  return <div className="h-full min-h-0" data-testid="review-panel" />;
}

import type { MessageDescriptor } from 'react-intl';
import { defineMessages, useIntl } from '../../i18n';
import type { ArtifactStatus } from '../../types/artifactStatus';

const messages = defineMessages({
  notStarted: { id: 'runs.statusNotStarted', defaultMessage: 'Not started' },
  fileFound: { id: 'runs.statusFileFound', defaultMessage: 'File found' },
  running: { id: 'runs.statusRunning', defaultMessage: 'Running' },
  failed: { id: 'runs.statusFailed', defaultMessage: 'Run failed' },
  generated: { id: 'runs.statusGenerated', defaultMessage: 'Generated' },
  verified: { id: 'runs.statusVerified', defaultMessage: 'Verified' },
  stale: { id: 'runs.statusStale', defaultMessage: 'Out of date' },
  badgeLabel: { id: 'runs.badgeLabel', defaultMessage: '{status}: show details for {path}' },
});

/** The label of each of the seven Artifact_Status values (requirement 17.1). */
export const ARTIFACT_STATUS_LABELS: Record<ArtifactStatus, MessageDescriptor> = {
  '未开始': messages.notStarted,
  '已发现文件': messages.fileFound,
  '执行中': messages.running,
  '执行失败': messages.failed,
  '已生成': messages.generated,
  '已验证': messages.verified,
  '已过期': messages.stale,
};

const TONES: Record<ArtifactStatus, string> = {
  '未开始': 'border-border-primary text-text-secondary',
  '已发现文件': 'border-border-primary text-text-secondary',
  '执行中': 'border-border-info text-text-primary',
  '执行失败': 'border-border-danger text-text-danger',
  '已生成': 'border-border-info text-text-primary',
  '已验证': 'border-border-info bg-background-secondary font-medium text-text-primary',
  '已过期': 'border-border-danger text-text-danger',
};

interface ArtifactStatusBadgeProps {
  status: ArtifactStatus;
  /** Project-relative path of the Artifact. */
  path: string;
  onSelect: (path: string) => void;
}

/** The one Artifact_Status of a file; selecting it opens the Artifact's details. */
export default function ArtifactStatusBadge({ status, path, onSelect }: ArtifactStatusBadgeProps) {
  const intl = useIntl();
  const label = intl.formatMessage(ARTIFACT_STATUS_LABELS[status]);
  const description = intl.formatMessage(messages.badgeLabel, { status: label, path });
  return (
    <button
      type="button"
      className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] leading-4 transition-colors hover:bg-background-tertiary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info motion-reduce:transition-none ${TONES[status]}`}
      aria-label={description}
      title={description}
      onClick={() => onSelect(path)}
    >
      {label}
    </button>
  );
}

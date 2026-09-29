import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, RotateCcw, FileDiff } from 'lucide-react';
import type {
  AutoCheckpoint,
  AutoCheckpointDiff,
} from '../../types/workspaceApi';
import DiffView from './preview/DiffView';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';

const i18n = defineMessages({
  title: {
    id: 'autoCheckpointsTab.title',
    defaultMessage: 'Automatic snapshots',
  },
  empty: {
    id: 'autoCheckpointsTab.empty',
    defaultMessage: 'No automatic snapshots yet. Snapshots are created before the agent writes files.',
  },
  unavailable: {
    id: 'autoCheckpointsTab.unavailable',
    defaultMessage: 'Git is unavailable, so snapshots cannot be created.',
  },
  loading: {
    id: 'autoCheckpointsTab.loading',
    defaultMessage: 'Loading…',
  },
  selectHint: {
    id: 'autoCheckpointsTab.selectHint',
    defaultMessage: 'Select two snapshots to compare, or one to restore.',
  },
  restore: {
    id: 'autoCheckpointsTab.restore',
    defaultMessage: 'Restore to here',
  },
  restoring: {
    id: 'autoCheckpointsTab.restoring',
    defaultMessage: 'Restoring…',
  },
  cancel: {
    id: 'autoCheckpointsTab.cancel',
    defaultMessage: 'Cancel',
  },
  confirmTitle: {
    id: 'autoCheckpointsTab.confirmTitle',
    defaultMessage: 'Restore this snapshot?',
  },
  confirmBody: {
    id: 'autoCheckpointsTab.confirmBody',
    defaultMessage: 'Created {createdAt}. {count} files will change.',
  },
  agentActive: {
    id: 'autoCheckpointsTab.agentActive',
    defaultMessage: 'Wait for the current turn to finish before restoring.',
  },
  restored: {
    id: 'autoCheckpointsTab.restored',
    defaultMessage: 'Restored to this snapshot',
  },
  restoreFailed: {
    id: 'autoCheckpointsTab.restoreFailed',
    defaultMessage: 'Restore failed: {message}',
  },
  filesChanged: {
    id: 'autoCheckpointsTab.filesChanged',
    defaultMessage: '{count} files changed',
  },
  showDiff: {
    id: 'autoCheckpointsTab.showDiff',
    defaultMessage: 'Compare',
  },
  binary: {
    id: 'autoCheckpointsTab.binary',
    defaultMessage: 'Changed (binary)',
  },
  select: {
    id: 'autoCheckpointsTab.select',
    defaultMessage: 'Select',
  },
});

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

interface AutoCheckpointsTabProps {
  workingDir: string;
  isAgentActive: boolean;
}

export default function AutoCheckpointsTab({ workingDir, isAgentActive }: AutoCheckpointsTabProps) {
  const intl = useIntl();
  const [checkpoints, setCheckpoints] = useState<AutoCheckpoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'idle' | 'restoring'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [diff, setDiff] = useState<AutoCheckpointDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [willChange, setWillChange] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    const result = await window.electron.checkpointList(workingDir, 100);
    if (result.ok) {
      setCheckpoints(result.value);
    } else if (result.error.code === 'GIT_UNAVAILABLE') {
      setError(intl.formatMessage(i18n.unavailable));
      setCheckpoints([]);
    } else {
      setError(result.error.message);
    }
  }, [intl, workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedCheckpoints = useMemo(
    () =>
      checkpoints.filter((checkpoint) => selected.includes(checkpoint.id)),
    [checkpoints, selected]
  );

  const runDiff = useCallback(
    async (a: string, b: string) => {
      setDiffLoading(true);
      setDiff(null);
      try {
        const result = await window.electron.checkpointDiff(workingDir, a, b);
        if (result.ok) setDiff(result.value);
        else setNotice(result.error.message);
      } finally {
        setDiffLoading(false);
      }
    },
    [workingDir]
  );

  const toggleSelect = useCallback(
    (id: string) => {
      setSelected((current) => {
        const next = current.includes(id)
          ? current.filter((entry) => entry !== id)
          : [...current, id].slice(-2);
        setDiff(null);
        if (next.length === 2) {
          void runDiff(next[0], next[1]);
        }
        return next;
      });
    },
    [runDiff]
  );

  const requestRestore = useCallback(
    async (id: string) => {
      setRestoreTarget(id);
      setWillChange(null);
      const result = await window.electron.checkpointDiff(workingDir, id, 'worktree');
      if (result.ok) {
        setWillChange(result.value.files.length);
      }
    },
    [workingDir]
  );

  const handleRestore = useCallback(
    async (id: string) => {
      setBusy('restoring');
      setNotice(null);
      try {
        const result = await window.electron.checkpointRestore(workingDir, id);
        if (result.ok) {
          setNotice(intl.formatMessage(i18n.restored));
        } else {
          setNotice(intl.formatMessage(i18n.restoreFailed, { message: result.error.message }));
        }
        setRestoreTarget(null);
        await refresh();
      } finally {
        setBusy('idle');
      }
    },
    [intl, refresh, workingDir]
  );

  const targetCheckpoint = checkpoints.find((checkpoint) => checkpoint.id === restoreTarget);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1.5">
        <History className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {intl.formatMessage(i18n.title)}
        </span>
      </div>

      {notice && (
        <div className="border-b border-border-primary px-2 py-1 text-[11px] text-text-tertiary">
          {notice}
        </div>
      )}
      {isAgentActive && (
        <div className="border-b border-border-primary bg-background-secondary px-2 py-1 text-[11px] text-text-tertiary">
          {intl.formatMessage(i18n.agentActive)}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {error && <p className="p-3 text-xs text-text-tertiary">{error}</p>}
        {!error && checkpoints.length === 0 && (
          <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
        )}
        {!error && checkpoints.length > 0 && (
          <p className="px-3 pb-1 pt-2 text-[10px] text-text-tertiary">
            {intl.formatMessage(i18n.selectHint)}
          </p>
        )}
        {checkpoints.map((checkpoint) => {
          const isSelected = selected.includes(checkpoint.id);
          return (
            <div
              key={checkpoint.id}
              className={cn(
                'group border-b border-border-primary/60 px-3 py-2 last:border-b-0',
                isSelected && 'bg-background-secondary/60'
              )}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleSelect(checkpoint.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="font-mono text-[10px] text-text-tertiary">
                    {checkpoint.shortId}
                  </span>
                  <span className="text-[10px] text-text-tertiary">
                    {formatTimestamp(checkpoint.createdAt)}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">
                    {intl.formatMessage(i18n.filesChanged, { count: checkpoint.filesChanged })}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={busy !== 'idle' || isAgentActive}
                  onClick={() => void requestRestore(checkpoint.id)}
                  className={cn(
                    'flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
                    busy === 'idle' && !isAgentActive
                      ? 'text-text-secondary hover:bg-background-tertiary hover:text-text-primary'
                      : 'text-text-tertiary'
                  )}
                >
                  <RotateCcw className="h-3 w-3" />
                  {intl.formatMessage(i18n.restore)}
                </button>
              </div>
              <p className="mt-0.5 text-[10px] text-text-tertiary">
                {checkpoint.sessionId ? `session ${checkpoint.sessionId} · ` : ''}
                turn {checkpoint.turn}
                {checkpoint.kind === 'pre-restore' ? ' · pre-restore' : ''}
              </p>
            </div>
          );
        })}
      </div>

      {diff && selectedCheckpoints.length === 2 && (
        <div className="max-h-64 shrink-0 overflow-auto border-t border-border-primary p-2">
          <div className="mb-1 flex items-center gap-1.5">
            <FileDiff className="h-3.5 w-3.5 text-text-tertiary" />
            <span className="text-[11px] text-text-secondary">
              {intl.formatMessage(i18n.showDiff)}
            </span>
          </div>
          {diffLoading && (
            <p className="text-[10px] text-text-tertiary">{intl.formatMessage(i18n.loading)}</p>
          )}
          {diff.files.map((file) => (
            <div key={`${file.status}-${file.path}`} className="py-0.5">
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'w-3 shrink-0 text-center font-mono text-[10px] font-semibold',
                    file.status === 'A' && 'text-text-success',
                    file.status === 'D' && 'text-red-500',
                    file.status === 'M' && 'text-text-info'
                  )}
                >
                  {file.status}
                </span>
                <span dir="auto" className="truncate font-mono text-[10px] text-text-secondary">
                  {file.path}
                </span>
                {file.binary && (
                  <span className="shrink-0 text-[10px] text-text-tertiary">
                    {intl.formatMessage(i18n.binary)}
                  </span>
                )}
              </div>
              {!file.binary && diff.textByPath[file.path] && (
                <div className="mt-0.5 max-h-40 overflow-auto">
                  <DiffView diff={diff.textByPath[file.path]} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {restoreTarget && targetCheckpoint && (
        <div className="shrink-0 border-t border-border-primary bg-background-secondary p-2">
          <p className="text-[10px] text-text-secondary">
            {intl.formatMessage(i18n.confirmTitle)}
          </p>
          <p className="mt-0.5 text-[10px] text-text-tertiary">
            {intl.formatMessage(i18n.confirmBody, {
              createdAt: formatTimestamp(targetCheckpoint.createdAt),
              count: willChange ?? '…',
            })}
          </p>
          <div className="mt-1.5 flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[11px]"
              disabled={busy !== 'idle'}
              onClick={() => void handleRestore(restoreTarget)}
            >
              {busy === 'restoring'
                ? intl.formatMessage(i18n.restoring)
                : intl.formatMessage(i18n.restore)}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[11px]"
              onClick={() => setRestoreTarget(null)}
            >
              {intl.formatMessage(i18n.cancel)}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

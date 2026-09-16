import { useCallback, useEffect, useState } from 'react';
import { History, RotateCcw, Save, GitBranch, FileDiff } from 'lucide-react';
import type { GitCheckpoint, GitCheckpointFile, GitVersionStatus } from '../../types/workspaceApi';
import DiffView from './preview/DiffView';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';

const i18n = defineMessages({
  title: {
    id: 'versionsPanel.title',
    defaultMessage: 'Project versions',
  },
  notARepo: {
    id: 'versionsPanel.notARepo',
    defaultMessage: 'This working directory is not a git repository, so changes cannot be tracked.',
  },
  init: {
    id: 'versionsPanel.init',
    defaultMessage: 'Enable version history',
  },
  save: {
    id: 'versionsPanel.save',
    defaultMessage: 'Save version',
  },
  saving: {
    id: 'versionsPanel.saving',
    defaultMessage: 'Saving…',
  },
  restore: {
    id: 'versionsPanel.restore',
    defaultMessage: 'Restore to here',
  },
  restoring: {
    id: 'versionsPanel.restoring',
    defaultMessage: 'Restoring…',
  },
  restoreConfirm: {
    id: 'versionsPanel.restoreConfirm',
    defaultMessage:
      'Restore all tracked files to this version? Current unsaved edits are overwritten.',
  },
  changed: {
    id: 'versionsPanel.changed',
    defaultMessage: '{count} changed files',
  },
  noChanges: {
    id: 'versionsPanel.noChanges',
    defaultMessage: 'No pending changes',
  },
  empty: {
    id: 'versionsPanel.empty',
    defaultMessage: 'No saved versions yet',
  },
  saved: {
    id: 'versionsPanel.saved',
    defaultMessage: 'Version saved',
  },
  restored: {
    id: 'versionsPanel.restored',
    defaultMessage: 'Restored to this version',
  },
  cancel: {
    id: 'versionsPanel.cancel',
    defaultMessage: 'Cancel',
  },
  nothingToCommit: {
    id: 'versionsPanel.nothingToCommit',
    defaultMessage: 'Nothing new to save',
  },
  missingIdentity: {
    id: 'versionsPanel.missingIdentity',
    defaultMessage: 'Git has no user identity configured',
  },
  gitMissing: {
    id: 'versionsPanel.gitMissing',
    defaultMessage: 'Git is not installed',
  },
  failed: {
    id: 'versionsPanel.failed',
    defaultMessage: 'Operation failed',
  },
  refreshed: {
    id: 'versionsPanel.refreshed',
    defaultMessage: 'Refreshed',
  },
  showFiles: {
    id: 'versionsPanel.showFiles',
    defaultMessage: 'Changed files',
  },
  hideFiles: {
    id: 'versionsPanel.hideFiles',
    defaultMessage: 'Hide files',
  },
  loadingFiles: {
    id: 'versionsPanel.loadingFiles',
    defaultMessage: 'Loading files…',
  },
  noFiles: {
    id: 'versionsPanel.noFiles',
    defaultMessage: 'No file changes recorded',
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

interface VersionsPanelProps {
  workingDir: string;
}

export default function VersionsPanel({ workingDir }: VersionsPanelProps) {
  const intl = useIntl();
  const [status, setStatus] = useState<GitVersionStatus | null>(null);
  const [checkpoints, setCheckpoints] = useState<GitCheckpoint[]>([]);
  const [busy, setBusy] = useState<'idle' | 'saving' | 'restoring' | 'initializing'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | null>(null);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, GitCheckpointFile[]>>({});
  const [activeDiffKey, setActiveDiffKey] = useState<string | null>(null);
  const [diffByKey, setDiffByKey] = useState<Record<string, string>>({});
  const [diffLoading, setDiffLoading] = useState(false);

  const showDiff = useCallback(
    async (hash: string, filePath: string) => {
      const key = `${hash}:${filePath}`;
      if (activeDiffKey === key) {
        setActiveDiffKey(null);
        return;
      }
      setActiveDiffKey(key);
      if (diffByKey[key] !== undefined) return;

      setDiffLoading(true);
      try {
        const diff = await window.electron.gitVersionFileDiff(workingDir, hash, filePath);
        setDiffByKey((current) => ({ ...current, [key]: diff }));
      } finally {
        setDiffLoading(false);
      }
    },
    [activeDiffKey, diffByKey, workingDir]
  );

  const toggleFiles = useCallback(
    async (hash: string) => {
      if (expandedHash === hash) {
        setExpandedHash(null);
        return;
      }
      setExpandedHash(hash);
      if (filesByHash[hash]) return;
      const files = await window.electron.gitVersionFiles(workingDir, hash);
      setFilesByHash((current) => ({ ...current, [hash]: files }));
    },
    [expandedHash, filesByHash, workingDir]
  );

  const refresh = useCallback(async () => {
    const [nextStatus, nextCheckpoints] = await Promise.all([
      window.electron.gitVersionStatus(workingDir),
      window.electron.gitVersionList(workingDir, 25),
    ]);
    setStatus(nextStatus);
    setCheckpoints(nextCheckpoints);
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const describeFailure = useCallback(
    (reason?: string): string => {
      switch (reason) {
        case 'nothing-to-commit':
          return intl.formatMessage(i18n.nothingToCommit);
        case 'missing-identity':
          return intl.formatMessage(i18n.missingIdentity);
        case 'git-missing':
          return intl.formatMessage(i18n.gitMissing);
        default:
          return intl.formatMessage(i18n.failed);
      }
    },
    [intl]
  );

  const handleSave = useCallback(async () => {
    setBusy('saving');
    setNotice(null);
    try {
      const result = await window.electron.gitVersionSave(
        workingDir,
        `ModelForge checkpoint ${new Date().toLocaleString()}`
      );
      setNotice(result.ok ? intl.formatMessage(i18n.saved) : describeFailure(result.reason));
      await refresh();
    } finally {
      setBusy('idle');
    }
  }, [describeFailure, intl, refresh, workingDir]);

  const handleRestore = useCallback(
    async (hash: string) => {
      setBusy('restoring');
      setNotice(null);
      try {
        const result = await window.electron.gitVersionRestore(workingDir, hash);
        setNotice(result.ok ? intl.formatMessage(i18n.restored) : describeFailure(result.reason));
        await refresh();
      } finally {
        setBusy('idle');
        setRestoreTarget(null);
      }
    },
    [describeFailure, intl, refresh, workingDir]
  );

  const handleInit = useCallback(async () => {
    setBusy('initializing');
    setNotice(null);
    try {
      const result = await window.electron.gitVersionInit(workingDir);
      setNotice(result.ok ? intl.formatMessage(i18n.saved) : describeFailure(result.reason));
      await refresh();
    } finally {
      setBusy('idle');
    }
  }, [describeFailure, intl, refresh, workingDir]);

  if (status && !status.isRepo) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6 text-center">
        <History className="h-8 w-8 text-text-tertiary" />
        <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.notARepo)}</p>
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          disabled={busy !== 'idle'}
          onClick={() => void handleInit()}
        >
          {busy === 'initializing'
            ? intl.formatMessage(i18n.saving)
            : intl.formatMessage(i18n.init)}
        </Button>
        {notice && <p className="text-[11px] text-text-tertiary">{notice}</p>}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1.5">
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {status?.branch ?? ''} ·{' '}
          {status && status.changedFiles > 0
            ? intl.formatMessage(i18n.changed, { count: status.changedFiles })
            : intl.formatMessage(i18n.noChanges)}
          {status && (status.insertions > 0 || status.deletions > 0) && (
            <span className="ml-1 font-mono text-[10px]">
              <span className="text-text-success">+{status.insertions}</span>{' '}
              <span className="text-red-500">-{status.deletions}</span>
            </span>
          )}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-6 shrink-0 gap-1 px-2 text-[11px]"
          disabled={busy !== 'idle'}
          onClick={() => void handleSave()}
        >
          <Save className="h-3 w-3" />
          {busy === 'saving' ? intl.formatMessage(i18n.saving) : intl.formatMessage(i18n.save)}
        </Button>
      </div>

      {notice && (
        <div className="border-b border-border-primary px-2 py-1 text-[11px] text-text-tertiary">
          {notice}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {checkpoints.length === 0 && (
          <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
        )}
        {checkpoints.map((checkpoint) => (
          <div
            key={checkpoint.hash}
            className="group border-b border-border-primary/60 px-3 py-2 last:border-b-0"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] text-text-tertiary">
                {checkpoint.shortHash}
              </span>
              <span className="text-[10px] text-text-tertiary">
                {formatTimestamp(checkpoint.timestamp)}
              </span>
              <span className="ml-auto text-[10px] text-text-tertiary">
                {intl.formatMessage(i18n.changed, { count: checkpoint.filesChanged })}
                {checkpoint.insertions > 0 && (
                  <span className="ml-1 font-mono text-text-success">+{checkpoint.insertions}</span>
                )}
                {checkpoint.deletions > 0 && (
                  <span className="ml-1 font-mono text-red-500">-{checkpoint.deletions}</span>
                )}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs text-text-primary">{checkpoint.subject}</p>
            <div className="mt-1 flex items-center gap-2">
              <span className="text-[10px] text-text-tertiary">{checkpoint.author}</span>
              <button
                type="button"
                onClick={() => void toggleFiles(checkpoint.hash)}
                className="ml-auto flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-text-secondary transition-colors hover:bg-background-tertiary hover:text-text-primary"
              >
                <FileDiff className="h-3 w-3" />
                {intl.formatMessage(
                  expandedHash === checkpoint.hash ? i18n.hideFiles : i18n.showFiles
                )}
              </button>
              <button
                type="button"
                disabled={busy !== 'idle'}
                onClick={() =>
                  setRestoreTarget((current) =>
                    current === checkpoint.hash ? null : checkpoint.hash
                  )
                }
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors',
                  busy === 'idle'
                    ? 'text-text-secondary hover:bg-background-tertiary hover:text-text-primary'
                    : 'text-text-tertiary'
                )}
              >
                <RotateCcw className="h-3 w-3" />
                {intl.formatMessage(i18n.restore)}
              </button>
            </div>

            {expandedHash === checkpoint.hash && (
              <div className="mt-1 max-h-56 overflow-auto rounded border border-border-primary bg-background-secondary/60 p-1">
                {filesByHash[checkpoint.hash] === undefined && (
                  <p className="px-1 py-0.5 text-[10px] text-text-tertiary">
                    {intl.formatMessage(i18n.loadingFiles)}
                  </p>
                )}
                {filesByHash[checkpoint.hash]?.length === 0 && (
                  <p className="px-1 py-0.5 text-[10px] text-text-tertiary">
                    {intl.formatMessage(i18n.noFiles)}
                  </p>
                )}
                {filesByHash[checkpoint.hash]?.map((file) => {
                  const diffKey = `${checkpoint.hash}:${file.path}`;
                  const isDiffOpen = activeDiffKey === diffKey;
                  return (
                    <div key={`${file.status}-${file.path}`}>
                      <button
                        type="button"
                        onClick={() => void showDiff(checkpoint.hash, file.path)}
                        title={file.path}
                        className={cn(
                          'flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors',
                          isDiffOpen ? 'bg-background-tertiary' : 'hover:bg-background-tertiary/60'
                        )}
                      >
                        <span
                          className={cn(
                            'w-3 shrink-0 text-center font-mono text-[10px] font-semibold',
                            file.status === 'A' && 'text-text-success',
                            file.status === 'D' && 'text-red-500',
                            file.status === 'M' && 'text-text-info',
                            !['A', 'D', 'M'].includes(file.status) && 'text-text-tertiary'
                          )}
                        >
                          {file.status}
                        </span>
                        <span
                          dir="auto"
                          className="truncate font-mono text-[10px] text-text-secondary"
                        >
                          {file.path}
                        </span>
                      </button>
                      {isDiffOpen && (
                        <div className="mt-1">
                          {diffByKey[diffKey] === undefined ? (
                            <p className="px-2 py-1 text-[10px] text-text-tertiary">
                              {diffLoading
                                ? intl.formatMessage(i18n.loadingFiles)
                                : intl.formatMessage(i18n.noFiles)}
                            </p>
                          ) : (
                            <DiffView diff={diffByKey[diffKey]} />
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {restoreTarget === checkpoint.hash && (
              <div className="mt-1 rounded border border-border-primary bg-background-secondary p-2">
                <p className="text-[10px] text-text-secondary">
                  {intl.formatMessage(i18n.restoreConfirm)}
                </p>
                <div className="mt-1.5 flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-[11px]"
                    disabled={busy !== 'idle'}
                    onClick={() => void handleRestore(checkpoint.hash)}
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
        ))}
      </div>
    </div>
  );
}

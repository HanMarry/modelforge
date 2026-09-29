import { useCallback, useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import { MainPanelLayout } from '../Layout/MainPanelLayout';

const messages = defineMessages({
  title: { id: 'collabGuest.title', defaultMessage: '加入协作' },
  subtitle: {
    id: 'collabGuest.subtitle',
    defaultMessage: '输入房主提供的邀请码，核对证书指纹后加入局域网协作。',
  },
  code: { id: 'collabGuest.code', defaultMessage: '邀请码' },
  displayName: { id: 'collabGuest.displayName', defaultMessage: '显示名' },
  fingerprint: { id: 'collabGuest.fingerprint', defaultMessage: '证书指纹' },
  join: { id: 'collabGuest.join', defaultMessage: '加入' },
  joining: { id: 'collabGuest.joining', defaultMessage: '加入中…' },
  rejected: { id: 'collabGuest.rejected', defaultMessage: '加入被拒绝' },
  ended: { id: 'collabGuest.ended', defaultMessage: '会话已结束' },
  readOnly: { id: 'collabGuest.readOnly', defaultMessage: '只读' },
  editable: { id: 'collabGuest.editable', defaultMessage: '可编辑' },
  editRejected: { id: 'collabGuest.editRejected', defaultMessage: '当前为只读，编辑已被拒绝' },
  files: { id: 'collabGuest.files', defaultMessage: '共享文件' },
  role: { id: 'collabGuest.role', defaultMessage: '权限' },
  leave: { id: 'collabGuest.leave', defaultMessage: '离开' },
});

const control =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info transition-colors';

type GuestPhase =
  | { kind: 'form' }
  | { kind: 'joining' }
  | { kind: 'joined'; role: string; files: Record<string, string> }
  | { kind: 'rejected'; reason: string }
  | { kind: 'ended' };

export default function CollabGuestView() {
  const intl = useIntl();
  const [code, setCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [guestId, setGuestId] = useState<string | null>(null);
  const [phase, setPhase] = useState<GuestPhase>({ kind: 'form' });
  const [editRejected, setEditRejected] = useState(false);

  useEffect(() => {
    return window.electron.onCollabGuestEvent((payload) => {
      if (payload.guestId !== guestId) {
        return;
      }
      if (payload.type === 'approved') {
        void window.electron.collabGuestFiles(guestId ?? '').then((result) => {
          if (result.ok) {
            setPhase({ kind: 'joined', role: payload.payload.role, files: result.data });
          }
        });
      } else if (payload.type === 'rejected') {
        setPhase({ kind: 'rejected', reason: String(payload.payload ?? '') });
      } else if (payload.type === 'session-ended') {
        setPhase({ kind: 'ended' });
      } else if (payload.type === 'edit-rejected') {
        setEditRejected(true);
      }
    });
  }, [guestId]);

  const join = useCallback(async () => {
    setPhase({ kind: 'joining' });
    const result = await window.electron.collabGuestJoin({
      address: '127.0.0.1',
      port: 0,
      fingerprint,
      inviteCode: code,
      displayName,
    });
    if (!result.ok) {
      setPhase({ kind: 'rejected', reason: result.error.message });
      return;
    }
    setGuestId(result.data.guestId);
  }, [code, displayName, fingerprint]);

  const leave = useCallback(() => {
    if (guestId) {
      void window.electron.collabGuestLeave(guestId);
    }
    setPhase({ kind: 'form' });
    setGuestId(null);
  }, [guestId]);

  const updateFile = (path: string, content: string) => {
    if (guestId) {
      void window.electron.collabGuestSetText(guestId, path, content);
    }
    setPhase((current) =>
      current.kind === 'joined'
        ? { ...current, files: { ...current.files, [path]: content } }
        : current
    );
  };

  return (
    <MainPanelLayout>
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="text-lg font-semibold text-text-primary">
          {intl.formatMessage(messages.title)}
        </h1>
        <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(messages.subtitle)}</p>

        {phase.kind === 'form' || phase.kind === 'joining' ? (
          <form
            className="mt-6 space-y-4 rounded-xl border border-border-secondary p-5"
            onSubmit={(event) => {
              event.preventDefault();
              void join();
            }}
          >
            <label className="block text-xs text-text-primary">
              {intl.formatMessage(messages.code)}
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-3 py-2 font-mono text-sm outline-none focus:border-border-primary"
                autoComplete="off"
              />
            </label>
            <label className="block text-xs text-text-primary">
              {intl.formatMessage(messages.displayName)}
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-3 py-2 text-sm outline-none focus:border-border-primary"
              />
            </label>
            <label className="block text-xs text-text-primary">
              {intl.formatMessage(messages.fingerprint)}
              <input
                value={fingerprint}
                onChange={(event) => setFingerprint(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-3 py-2 font-mono text-sm outline-none focus:border-border-primary"
                placeholder="AA:BB:CC:…"
              />
            </label>
            <button
              type="submit"
              disabled={phase.kind === 'joining' || !code.trim() || !displayName.trim()}
              className={`${control} w-full bg-text-primary px-4 py-2.5 text-sm text-background-primary disabled:opacity-50`}
            >
              {phase.kind === 'joining'
                ? intl.formatMessage(messages.joining)
                : intl.formatMessage(messages.join)}
            </button>
          </form>
        ) : null}

        {phase.kind === 'joined' && (
          <section className="mt-6 rounded-xl border border-border-secondary p-5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">
                {intl.formatMessage(messages.role)}:
                {phase.role === 'editable'
                  ? intl.formatMessage(messages.editable)
                  : intl.formatMessage(messages.readOnly)}
              </span>
              <button type="button" className={`${control} px-3 py-1.5 text-xs underline`} onClick={leave}>
                {intl.formatMessage(messages.leave)}
              </button>
            </div>
            {editRejected && (
              <p role="alert" className="mt-3 rounded-md border border-border-danger p-2 text-xs">
                {intl.formatMessage(messages.editRejected)}
              </p>
            )}
            <h2 className="mt-4 text-xs font-medium text-text-primary">
              {intl.formatMessage(messages.files)}
            </h2>
            <div className="mt-2 space-y-3">
              {Object.entries(phase.files).map(([path, content]) => (
                <label key={path} className="block">
                  <span className="block break-all font-mono text-xs text-text-secondary">{path}</span>
                  <textarea
                    value={content}
                    readOnly={phase.role !== 'editable'}
                    onChange={(event) => updateFile(path, event.target.value)}
                    className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-3 py-2 font-mono text-sm outline-none focus:border-border-primary"
                    rows={6}
                  />
                </label>
              ))}
            </div>
          </section>
        )}

        {phase.kind === 'rejected' && (
          <p role="alert" className="mt-6 rounded-lg border border-border-danger p-3 text-sm">
            {intl.formatMessage(messages.rejected)}: {phase.reason}
          </p>
        )}
        {phase.kind === 'ended' && (
          <p role="alert" className="mt-6 rounded-lg border border-border-danger p-3 text-sm">
            {intl.formatMessage(messages.ended)}
          </p>
        )}
      </div>
    </MainPanelLayout>
  );
}

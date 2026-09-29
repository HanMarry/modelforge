import { useCallback, useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../i18n';
import type { CollabMember } from '../../utils/collab/collabService';
import type { CollabGuestRole } from '../../utils/collab/collabPolicy';

const messages = defineMessages({
  title: { id: 'collabHost.title', defaultMessage: '发起协作' },
  subtitle: {
    id: 'collabHost.subtitle',
    defaultMessage: '仅在局域网内共享。访客需核对证书指纹后加入。',
  },
  start: { id: 'collabHost.start', defaultMessage: '开始会话' },
  inviteCode: { id: 'collabHost.inviteCode', defaultMessage: '邀请码' },
  fingerprint: { id: 'collabHost.fingerprint', defaultMessage: '证书指纹' },
  members: { id: 'collabHost.members', defaultMessage: '成员' },
  approve: { id: 'collabHost.approve', defaultMessage: '批准' },
  reject: { id: 'collabHost.reject', defaultMessage: '拒绝' },
  readOnly: { id: 'collabHost.readOnly', defaultMessage: '只读' },
  editable: { id: 'collabHost.editable', defaultMessage: '可编辑' },
  end: { id: 'collabHost.end', defaultMessage: '结束会话' },
  joinRequest: { id: 'collabHost.joinRequest', defaultMessage: '请求加入' },
  empty: { id: 'collabHost.empty', defaultMessage: '暂无成员' },
});

const control =
  'rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-info transition-colors';

interface JoinRequest {
  guestId: string;
  displayName: string;
}

interface CollabHostPanelProps {
  onClose: () => void;
}

export default function CollabHostPanel({ onClose }: CollabHostPanelProps) {
  const intl = useIntl();
  const [state, setState] = useState<{
    inviteCode: string;
    fingerprint: string;
    fingerprintDisplay: string;
  } | null>(null);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [members, setMembers] = useState<CollabMember[]>([]);

  useEffect(() => {
    const offJoin = window.electron.onCollabJoinRequest((request) => {
      setRequests((current) => [...current, request]);
    });
    const offMembers = window.electron.onCollabMemberChange((next) => setMembers(next));
    return () => {
      offJoin();
      offMembers();
    };
  }, []);

  const start = useCallback(async () => {
    const result = await window.electron.collabHostStart([{ path: 'paper.tex', content: '' }]);
    if (result.ok) {
      setState(result.data);
    }
  }, []);

  const end = useCallback(async () => {
    await window.electron.collabHostStop();
    setState(null);
    setRequests([]);
    setMembers([]);
  }, []);

  const respond = (guestId: string, role: CollabGuestRole | null) => {
    if (role === null) {
      void window.electron.collabHostReject(guestId);
    } else {
      void window.electron.collabHostApprove(guestId, role);
    }
    setRequests((current) => current.filter((request) => request.guestId !== guestId));
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-md rounded-xl border border-border-secondary bg-background-primary p-5">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">
              {intl.formatMessage(messages.title)}
            </h2>
            <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(messages.subtitle)}</p>
          </div>
          <button type="button" className={`${control} p-1 text-text-tertiary`} onClick={onClose}>
            ✕
          </button>
        </div>

        {!state ? (
          <button
            type="button"
            className={`${control} mt-4 w-full bg-text-primary px-4 py-2.5 text-sm text-background-primary`}
            onClick={() => void start()}
          >
            {intl.formatMessage(messages.start)}
          </button>
        ) : (
          <>
            <dl className="mt-4 space-y-2 text-xs">
              <div>
                <dt className="text-text-secondary">{intl.formatMessage(messages.inviteCode)}</dt>
                <dd className="mt-0.5 font-mono text-lg tracking-widest text-text-primary">
                  {state.inviteCode}
                </dd>
              </div>
              <div>
                <dt className="text-text-secondary">{intl.formatMessage(messages.fingerprint)}</dt>
                <dd className="mt-0.5 break-all font-mono text-text-primary">
                  {state.fingerprintDisplay}
                </dd>
              </div>
            </dl>

            {requests.length > 0 && (
              <section className="mt-4 rounded-lg border border-border-secondary p-3">
                <h3 className="text-xs font-medium text-text-primary">
                  {intl.formatMessage(messages.joinRequest)}
                </h3>
                {requests.map((request) => (
                  <div key={request.guestId} className="mt-2 flex items-center gap-2">
                    <span className="flex-1 text-sm text-text-primary">{request.displayName}</span>
                    <button
                      type="button"
                      className={`${control} px-2 py-1 text-xs underline`}
                      onClick={() => respond(request.guestId, 'read-only')}
                    >
                      {intl.formatMessage(messages.readOnly)}
                    </button>
                    <button
                      type="button"
                      className={`${control} px-2 py-1 text-xs underline`}
                      onClick={() => respond(request.guestId, 'editable')}
                    >
                      {intl.formatMessage(messages.editable)}
                    </button>
                    <button
                      type="button"
                      className={`${control} px-2 py-1 text-xs underline`}
                      onClick={() => respond(request.guestId, null)}
                    >
                      {intl.formatMessage(messages.reject)}
                    </button>
                  </div>
                ))}
              </section>
            )}

            <section className="mt-4">
              <h3 className="text-xs font-medium text-text-primary">
                {intl.formatMessage(messages.members)}
              </h3>
              {members.length === 0 ? (
                <p className="mt-1 text-xs text-text-tertiary">{intl.formatMessage(messages.empty)}</p>
              ) : (
                <ul className="mt-1 space-y-1">
                  {members.map((member) => (
                    <li key={member.guestId} className="text-sm text-text-primary">
                      {member.displayName} — {intl.formatMessage(member.role === 'editable' ? messages.editable : messages.readOnly)}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <button
              type="button"
              className={`${control} mt-5 w-full border border-border-danger px-4 py-2 text-sm text-text-primary`}
              onClick={() => void end()}
            >
              {intl.formatMessage(messages.end)}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

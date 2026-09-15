import { useEffect, useMemo, useState } from 'react';
import { ChatState } from '../types/chatState';
import {
  getTextAndImageContent,
  getToolRequests,
  getToolResponses,
  type Message,
} from '../types/message';
import { describeToolCall, unwrapToolCall } from '../utils/toolDescription';
import { STATE_ICONS } from './LoadingGoose';
import { defineMessages, useIntl } from '../i18n';

const i18n = defineMessages({
  thinking: {
    id: 'activityStatus.thinking',
    defaultMessage: 'Thinking…',
  },
  running: {
    id: 'activityStatus.running',
    defaultMessage: '{operation}',
  },
  streaming: {
    id: 'activityStatus.streaming',
    defaultMessage: 'Writing the reply…',
  },
  waiting: {
    id: 'activityStatus.waiting',
    defaultMessage: 'Waiting for your confirmation…',
  },
  compacting: {
    id: 'activityStatus.compacting',
    defaultMessage: 'Compacting the conversation…',
  },
  completedOps: {
    id: 'activityStatus.completedOps',
    defaultMessage: '{count} operations completed',
  },
  elapsed: {
    id: 'activityStatus.elapsed',
    defaultMessage: '{time} elapsed',
  },
});

const STATE_MESSAGE_KEYS: Partial<Record<ChatState, keyof typeof i18n>> = {
  [ChatState.Thinking]: 'thinking',
  [ChatState.Streaming]: 'streaming',
  [ChatState.WaitingForUserInput]: 'waiting',
  [ChatState.Compacting]: 'compacting',
};

const TOOL_STATES = new Set([ChatState.Thinking, ChatState.Streaming]);

interface TurnActivity {
  completedOperations: number;
  currentOperation: string | null;
  startedAt: number | null;
}

export function deriveTurnActivity(messages: Message[]): TurnActivity {
  let turnStartIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user' && getTextAndImageContent(message).textContent.trim()) {
      turnStartIndex = index;
      break;
    }
  }

  const turnMessages = messages.slice(turnStartIndex + 1);
  const respondedIds = new Set<string>();
  for (const message of turnMessages) {
    for (const response of getToolResponses(message)) {
      respondedIds.add(response.id);
    }
  }

  const requests = turnMessages.flatMap((message) => getToolRequests(message));
  const pending = requests.filter((request) => !respondedIds.has(request.id));
  const lastPending = pending[pending.length - 1];
  const lastPendingCall = lastPending ? unwrapToolCall(lastPending.toolCall) : null;

  return {
    completedOperations: requests.length - pending.length,
    currentOperation: lastPendingCall ? describeToolCall(lastPendingCall) : null,
    startedAt: turnStartIndex >= 0 ? messages[turnStartIndex].created : null,
  };
}

function formatElapsed(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

interface ActivityStatusProps {
  chatState: ChatState;
  messages: Message[];
  progressMessage?: string;
}

export default function ActivityStatus({
  chatState,
  messages,
  progressMessage,
}: ActivityStatusProps) {
  const intl = useIntl();
  const activity = useMemo(() => deriveTurnActivity(messages), [messages]);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (chatState === ChatState.Idle || chatState === ChatState.LoadingConversation) {
    return null;
  }

  const operation =
    activity.currentOperation && TOOL_STATES.has(chatState) ? activity.currentOperation : null;
  const statusKey = STATE_MESSAGE_KEYS[chatState];
  const statusText = operation
    ? intl.formatMessage(i18n.running, { operation })
    : statusKey
      ? intl.formatMessage(i18n[statusKey])
      : intl.formatMessage(i18n.streaming);

  const elapsedSeconds =
    activity.startedAt && Number.isFinite(activity.startedAt)
      ? now / 1000 - activity.startedAt
      : null;

  const meta: string[] = [];
  if (progressMessage) {
    meta.push(progressMessage);
  }
  if (activity.completedOperations > 0) {
    meta.push(intl.formatMessage(i18n.completedOps, { count: activity.completedOperations }));
  }
  if (elapsedSeconds !== null && elapsedSeconds >= 1) {
    meta.push(intl.formatMessage(i18n.elapsed, { time: formatElapsed(elapsedSeconds) }));
  }

  return (
    <div className="mt-4 flex w-full animate-fade-slide-up" data-testid="activity-status">
      <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border-primary bg-background-secondary px-3 py-1.5 text-xs text-text-primary">
        <span className="flex min-w-0 items-center gap-1.5">
          {STATE_ICONS[chatState]}
          <span className="truncate" title={statusText}>
            {statusText}
          </span>
        </span>
        {meta.length > 0 && (
          <span className="flex items-center gap-2 font-mono text-text-secondary">
            {meta.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

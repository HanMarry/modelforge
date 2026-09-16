import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntlTestWrapper } from '../i18n/test-utils';
import ActivityStatus, { deriveTurnActivity } from './ActivityStatus';
import { ChatState } from '../types/chatState';
import type { Message, MessageContent } from '../types/message';

const metadata: Message['metadata'] = { agentVisible: true, userVisible: true };

function userMessage(text: string, created: number): Message {
  return {
    id: `user-${created}`,
    role: 'user',
    created,
    content: [{ type: 'text', text }],
    metadata,
  };
}

function toolRequestMessage(id: string, command: string): Message {
  const content: MessageContent = {
    type: 'toolRequest',
    id,
    toolCall: {
      status: 'success',
      value: { name: 'developer__shell', arguments: { command } },
    },
  };
  return { id: `assistant-${id}`, role: 'assistant', created: 1, content: [content], metadata };
}

function toolResponseMessage(id: string): Message {
  const content: MessageContent = {
    type: 'toolResponse',
    id,
    toolResult: {
      status: 'success',
      value: { content: [{ type: 'text', text: 'ok' }], isError: false },
    },
  };
  return { id: `response-${id}`, role: 'user', created: 1, content: [content], metadata };
}

function renderStatus(messages: Message[], chatState: ChatState, progressMessage?: string) {
  return render(
    <ActivityStatus chatState={chatState} messages={messages} progressMessage={progressMessage} />,
    { wrapper: IntlTestWrapper }
  );
}

describe('deriveTurnActivity', () => {
  it('counts finished operations and reports the pending one', () => {
    const user = userMessage('build the paper', 100);
    const activity = deriveTurnActivity([
      user,
      toolRequestMessage('tool-1', 'uv run prepare.py'),
      toolResponseMessage('tool-1'),
      toolRequestMessage('tool-2', 'uv run make_pdf.py'),
    ]);

    expect(activity.completedOperations).toBe(1);
    expect(activity.currentOperation).toBe('running uv run make_pdf.py');
    expect(activity.startedAt).toBe(100);
  });

  it('ignores tool responses when locating the turn start', () => {
    const user = userMessage('build the paper', 200);
    const activity = deriveTurnActivity([
      user,
      toolRequestMessage('tool-1', 'ls'),
      toolResponseMessage('tool-1'),
    ]);

    expect(activity.startedAt).toBe(200);
    expect(activity.completedOperations).toBe(1);
    expect(activity.currentOperation).toBeNull();
  });
});

describe('ActivityStatus', () => {
  it('is hidden while idle', () => {
    renderStatus([userMessage('hi', 1)], ChatState.Idle);
    expect(screen.queryByTestId('activity-status')).toBeNull();
  });

  it('shows the running operation, finished count and elapsed time', () => {
    const created = Math.floor(Date.now() / 1000) - 65;
    renderStatus(
      [
        userMessage('build the paper', created),
        toolRequestMessage('tool-1', 'uv run prepare.py'),
        toolResponseMessage('tool-1'),
        toolRequestMessage('tool-2', 'uv run make_pdf.py'),
      ],
      ChatState.Streaming
    );

    expect(screen.getByText('running uv run make_pdf.py')).toBeTruthy();
    expect(screen.getByText('1 operations completed')).toBeTruthy();
    expect(screen.getByText(/elapsed/)).toBeTruthy();
  });

  it('falls back to the state label when no tool is running', () => {
    renderStatus([userMessage('hi', 1)], ChatState.Thinking);
    expect(screen.getByText('Thinking…')).toBeTruthy();
  });

  it('surfaces backend progress messages as secondary detail', () => {
    renderStatus([userMessage('hi', 1)], ChatState.Streaming, 'Still working');
    expect(screen.getByText('Writing the reply…')).toBeTruthy();
    expect(screen.getByText('Still working')).toBeTruthy();
  });
});

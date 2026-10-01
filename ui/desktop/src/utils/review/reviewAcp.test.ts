import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cancelAcpPermissionRequestsForSession,
  requestAcpPermission,
} from '../../acp/permissionRequests';
import { acpChatSessionActions } from '../../acp/chatSessionStore';
import { acpCloseSession, acpNewSession, acpRenameSession } from '../../acp/sessions';
import { acpReviewKernel } from './reviewAcp';

vi.mock('../../acp/chatSessionStore', () => ({
  acpPermissionUserInputRequestId: (toolCallId: string) => `permission:${toolCallId}`,
  acpChatSessionActions: {
    applyPermissionRequest: vi.fn(),
    cancelPermissionRequest: vi.fn(),
    resolveUserInputRequest: vi.fn(),
    deleteSnapshot: vi.fn(),
  },
  acpChatSessionStore: {
    getSnapshot: vi.fn(),
  },
}));

vi.mock('../../acp/elicitationRequests', () => ({
  cancelAcpElicitationRequestsForSession: vi.fn(),
}));

vi.mock('../../acp/prompt', () => ({
  acpCancelPrompt: vi.fn(),
  acpPromptSession: vi.fn(),
}));

vi.mock('../../acp/sessions', () => ({
  acpCloseSession: vi.fn(),
  acpNewSession: vi.fn(),
  acpRenameSession: vi.fn(),
}));

const SESSION_ID = 'review-session';

function permissionRequest(toolCallId: string): RequestPermissionRequest {
  return {
    sessionId: SESSION_ID,
    options: [
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'reject_once', name: 'Deny once', kind: 'reject_once' },
      { optionId: 'reject_always', name: 'Always deny', kind: 'reject_always' },
    ],
    toolCall: {
      toolCallId,
      title: 'shell',
      rawInput: { command: 'latexmk main.tex' },
    },
  };
}

async function isPending(response: Promise<RequestPermissionResponse>): Promise<boolean> {
  let settled = false;
  response.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  return !settled;
}

describe('acpReviewKernel approvals (MP-26)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(acpNewSession).mockResolvedValue({
      sessionId: SESSION_ID,
    } as Awaited<ReturnType<typeof acpNewSession>>);
    vi.mocked(acpRenameSession).mockResolvedValue(undefined);
    vi.mocked(acpCloseSession).mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await acpReviewKernel.closeSession(SESSION_ID);
    cancelAcpPermissionRequestsForSession(SESSION_ID);
  });

  it('refuses tool approvals of a review session once, without asking the user', async () => {
    expect(await acpReviewKernel.openSession('/project', 'Mock review: paper/main.tex')).toBe(
      SESSION_ID
    );

    // `reject_once`, never `reject_always`: no permission rule is stored for the tool.
    await expect(requestAcpPermission(permissionRequest('tool-1'))).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'reject_once' },
    });
    expect(acpChatSessionActions.applyPermissionRequest).not.toHaveBeenCalled();
    // Nothing waits for the user, so the runner does not stop the review.
    expect(acpReviewKernel.isWaitingForUser(SESSION_ID)).toBe(false);
  });

  it('stops answering once the review session is closed', async () => {
    await acpReviewKernel.openSession('/project', 'Mock review: paper/main.tex');
    await acpReviewKernel.closeSession(SESSION_ID);

    expect(acpCloseSession).toHaveBeenCalledWith(SESSION_ID);
    const response = requestAcpPermission(permissionRequest('tool-2'));
    expect(await isPending(response)).toBe(true);
    expect(acpChatSessionActions.applyPermissionRequest).toHaveBeenCalledTimes(1);
  });
});

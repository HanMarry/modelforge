/**
 * The review runner's Kernel access over ACP (requirement 19, task 26.5). The availability
 * check is the one the datasets page uses before it hands a task to the Kernel
 * (`getAgentKernelStatus().error`); the review then runs in a session of its own, so its reply
 * can be read back from the session store instead of the user's chat.
 */
import { acpChatSessionActions, acpChatSessionStore } from '../../acp/chatSessionStore';
import { cancelAcpElicitationRequestsForSession } from '../../acp/elicitationRequests';
import { formatAcpError } from '../../acp/errors';
import { cancelAcpPermissionRequestsForSession } from '../../acp/permissionRequests';
import { acpCancelPrompt, acpPromptSession } from '../../acp/prompt';
import { acpCloseSession, acpNewSession, acpRenameSession } from '../../acp/sessions';
import { ChatState } from '../../types/chatState';
import { createUserMessage, type Message } from '../../types/message';
import type { ReviewKernel } from './reviewRunner';

function messageText(message: Message): string {
  return message.content
    .map((content) => (content.type === 'text' ? content.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

export const acpReviewKernel: ReviewKernel = {
  async unavailableReason() {
    // A status call that fails says nothing about the Kernel; opening the session will tell.
    const status = await window.electron.getAgentKernelStatus().catch(() => null);
    return status?.error ? status.error : null;
  },

  async openSession(workingDir, title) {
    try {
      const { sessionId } = await acpNewSession(workingDir, []);
      // A readable name in the session list; failing to rename does not affect the review.
      void acpRenameSession(sessionId, title).catch(() => undefined);
      return sessionId;
    } catch (error) {
      throw new Error(formatAcpError(error));
    }
  },

  async prompt(sessionId, text) {
    try {
      const response = await acpPromptSession(sessionId, createUserMessage(text));
      return String(response.stopReason);
    } catch (error) {
      throw new Error(formatAcpError(error));
    }
  },

  async cancel(sessionId) {
    cancelAcpPermissionRequestsForSession(sessionId);
    cancelAcpElicitationRequestsForSession(sessionId);
    await acpCancelPrompt(sessionId);
  },

  isWaitingForUser(sessionId) {
    return acpChatSessionStore.getSnapshot(sessionId)?.chatState === ChatState.WaitingForUserInput;
  },

  replyTexts(sessionId) {
    const messages = acpChatSessionStore.getSnapshot(sessionId)?.messages ?? [];
    return messages
      .filter((message) => message.role === 'assistant')
      .map(messageText)
      .filter((text) => text.trim() !== '');
  },

  async closeSession(sessionId) {
    cancelAcpPermissionRequestsForSession(sessionId);
    cancelAcpElicitationRequestsForSession(sessionId);
    try {
      await acpCloseSession(sessionId);
    } finally {
      acpChatSessionActions.deleteSnapshot(sessionId);
    }
  },
};

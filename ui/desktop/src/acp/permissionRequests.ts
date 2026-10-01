import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Permission } from '../types/permissions';
import { acpChatSessionActions, acpPermissionUserInputRequestId } from './chatSessionStore';
import type { AcpPermissionRequest } from './permissionRequestTypes';

interface PendingPermissionRequest {
  request: RequestPermissionRequest;
  generation: string;
  resolve: (response: RequestPermissionResponse) => void;
}

const pendingRequests = new Map<string, PendingPermissionRequest>();

/**
 * Sessions whose permission requests are answered without asking anyone. A panel that runs the
 * Kernel on its own, like the mock review, has no approval prompt to show.
 */
const automaticAnswers = new Map<string, { action: Permission }>();

/**
 * Answers every permission request of `sessionId` with `action` until the returned function is
 * called. With `deny_once` the Kernel tells the model that this one tool call was refused and
 * the model carries on with its turn; no permission rule is stored.
 */
export function answerAcpPermissionRequestsWith(
  sessionId: string,
  action: Permission
): () => void {
  const answer = { action };
  automaticAnswers.set(sessionId, answer);
  return () => {
    if (automaticAnswers.get(sessionId) === answer) {
      automaticAnswers.delete(sessionId);
    }
  };
}

export async function requestAcpPermission(
  request: RequestPermissionRequest
): Promise<RequestPermissionResponse> {
  const automatic = automaticAnswers.get(request.sessionId);
  if (automatic) {
    return permissionResponseForAction(request, automatic.action);
  }

  const key = permissionRequestKey(request.sessionId, request.toolCall.toolCallId);
  const previous = pendingRequests.get(key);
  if (previous) {
    previous.resolve(cancelledPermissionResponse());
  }

  return new Promise<RequestPermissionResponse>((resolve) => {
    const permissionRequest: AcpPermissionRequest = {
      generation: globalThis.crypto.randomUUID(),
      request,
    };
    pendingRequests.set(key, { ...permissionRequest, resolve });
    acpChatSessionActions.applyPermissionRequest(permissionRequest);
  });
}

export function resolveAcpPermissionRequest(
  sessionId: string,
  toolCallId: string,
  generation: string | undefined,
  action: Permission
): boolean {
  const key = permissionRequestKey(sessionId, toolCallId);
  const pending = pendingRequests.get(key);
  if (!pending || !generation || pending.generation !== generation) {
    return false;
  }

  pendingRequests.delete(key);
  acpChatSessionActions.resolveUserInputRequest(
    sessionId,
    acpPermissionUserInputRequestId(toolCallId)
  );
  pending.resolve(permissionResponseForAction(pending.request, action));
  return true;
}

export function cancelAcpPermissionRequestsForSession(sessionId: string): void {
  for (const [key, pending] of pendingRequests) {
    if (pending.request.sessionId === sessionId) {
      pendingRequests.delete(key);
      acpChatSessionActions.cancelPermissionRequest(
        sessionId,
        pending.request.toolCall.toolCallId,
        pending.generation
      );
      pending.resolve(cancelledPermissionResponse());
    }
  }
}

function permissionResponseForAction(
  request: RequestPermissionRequest,
  action: Permission
): RequestPermissionResponse {
  if (action === 'cancel') {
    return cancelledPermissionResponse();
  }

  const optionId = permissionOptionIdForAction(request, action);
  if (!optionId) {
    return cancelledPermissionResponse();
  }

  return {
    outcome: {
      outcome: 'selected',
      optionId,
    },
  };
}

function permissionOptionIdForAction(
  request: RequestPermissionRequest,
  action: Permission
): string | undefined {
  const kind = permissionOptionKindForAction(action);
  if (!kind) {
    return undefined;
  }

  return request.options.find((candidate) => candidate.kind === kind)?.optionId;
}

function permissionOptionKindForAction(action: Permission) {
  switch (action) {
    case 'allow_once':
      return 'allow_once';
    case 'always_allow':
      return 'allow_always';
    case 'deny_once':
      return 'reject_once';
    case 'always_deny':
      return 'reject_always';
    case 'cancel':
      return undefined;
  }
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return {
    outcome: {
      outcome: 'cancelled',
    },
  };
}

function permissionRequestKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}\u0000${toolCallId}`;
}

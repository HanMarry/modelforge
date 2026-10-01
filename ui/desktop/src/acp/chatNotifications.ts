import type {
  GooseSessionNotification_unstable,
  ProviderDeviceCodeNotification_unstable,
} from '@aaif/goose-acp-client';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import { AppEvents } from '../constants/events';
import { maybeHandlePlatformEvent } from '../utils/platform_events';
import { toolNotificationEvent } from './adapter/toolNotifications';
import { acpChatSessionActions, acpChatSessionStore } from './chatSessionStore';
import { handleRunToolCallEnded } from './runNotifications';

export function handleAcpSessionNotification(notification: SessionNotification): Promise<void> {
  const sessionNameBeforeNotification = acpChatSessionStore.getSnapshot(
    notification.sessionId
  )?.session?.name;
  const updatedName =
    notification.update.sessionUpdate === 'session_info_update'
      ? notification.update.title
      : undefined;
  acpChatSessionActions.applyAcpSessionNotification(notification);
  maybeHandleLivePlatformEvent(notification);
  maybeEndRun(notification);

  if (updatedName && updatedName !== sessionNameBeforeNotification) {
    window.dispatchEvent(
      new CustomEvent(AppEvents.SESSION_RENAMED, {
        detail: { sessionId: notification.sessionId, newName: updatedName },
      })
    );
  }

  return Promise.resolve();
}

function maybeHandleLivePlatformEvent(notification: SessionNotification): void {
  const update = notification.update;
  if (
    update.sessionUpdate !== 'tool_call_update' ||
    update.status === 'completed' ||
    update.status === 'failed'
  ) {
    return;
  }

  const event = toolNotificationEvent(update);
  if (event?.message.method === 'platform_event') {
    maybeHandlePlatformEvent(event.message, notification.sessionId);
  }
}

/** A tool call that ended may have started a run whose end nothing else reports. */
function maybeEndRun(notification: SessionNotification): void {
  const update = notification.update;
  if (
    update.sessionUpdate === 'tool_call_update' &&
    (update.status === 'completed' || update.status === 'failed')
  ) {
    handleRunToolCallEnded(notification.sessionId, update.toolCallId);
  }
}

export function handleAcpGooseSessionNotification(
  notification: GooseSessionNotification_unstable
): Promise<void> {
  acpChatSessionActions.applyAcpGooseSessionNotification(notification);
  return Promise.resolve();
}

export function handleAcpProviderDeviceCodeNotification(
  notification: ProviderDeviceCodeNotification_unstable
): Promise<void> {
  window.dispatchEvent(new CustomEvent('goose:device-code', { detail: notification }));
  return Promise.resolve();
}

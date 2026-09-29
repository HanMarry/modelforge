/**
 * Inbound Feishu message routing (requirement 15.1, 15.3).
 *
 * A message is forwarded to the Kernel only when it is a private chat (`chat_type=p2p`),
 * a text message, 1–4000 code points long, and from an open_id present in a non-empty
 * whitelist. Everything else — group chats, non-text messages, unknown or unlisted senders —
 * is ignored and receives no task content in reply.
 */

export type RouteDecision = 'forward' | 'ignore';

export const FEISHU_TEXT_MIN_CODE_POINTS = 1;
export const FEISHU_TEXT_MAX_CODE_POINTS = 4000;

export interface FeishuInboundMessage {
  chatType: string;
  messageType: string;
  /** Decoded text payload; empty when the message is not text. */
  text: string;
  senderOpenId: string;
}

/** Trims entries and drops blanks, so "empty whitelist" is decided after normalization. */
export function normalizeWhitelist(whitelist: readonly string[]): string[] {
  return [...new Set(whitelist.map((entry) => entry.trim()).filter((entry) => entry !== ''))];
}

export function routeInbound(
  message: FeishuInboundMessage,
  whitelist: readonly string[]
): RouteDecision {
  if (message.chatType !== 'p2p') {
    return 'ignore';
  }
  if (message.messageType !== 'text') {
    return 'ignore';
  }
  const length = [...message.text].length;
  if (length < FEISHU_TEXT_MIN_CODE_POINTS || length > FEISHU_TEXT_MAX_CODE_POINTS) {
    return 'ignore';
  }
  const openId = message.senderOpenId.trim();
  if (!openId) {
    return 'ignore';
  }
  if (!normalizeWhitelist(whitelist).includes(openId)) {
    return 'ignore';
  }
  return 'forward';
}

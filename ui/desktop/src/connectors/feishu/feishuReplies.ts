/**
 * Texts the Feishu connector sends back to a chat (requirement 15), and the parser for approval
 * replies. Pure functions, so the wording and the limits can be tested without a connection.
 */
import { randomInt } from 'node:crypto';
import { truncateText } from '../../utils/textTruncate';

/** Argument summary limit of an approval request (requirement 15.4). */
export const FEISHU_APPROVAL_TEXT_LIMIT = 500;
/** Unambiguous alphabet of one-time approval codes: no 0/O, 1/I. */
export const FEISHU_APPROVAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const FEISHU_APPROVAL_CODE_LENGTH = 6;
/** Session names are `飞书：` plus the start of the first message. */
export const FEISHU_SESSION_TITLE_PREFIX = '飞书：';
export const FEISHU_SESSION_TITLE_EXCERPT = 24;
/** Step name of a progress message sent before any step completed. */
export const FEISHU_NO_STEP_YET = '暂无已完成的步骤';

export type FeishuFailureCategory = '模型供应商错误' | '工具执行错误' | '用户中断' | '内核异常';

export type FeishuApprovalAction = 'approve' | 'reject';

export interface FeishuApprovalReply {
  action: FeishuApprovalAction;
  /** Upper-cased approval code. */
  code: string;
}

/** Title of the desktop session a private chat drives. */
export function feishuSessionTitle(firstMessage: string): string {
  const excerpt = firstMessage.replace(/\s+/g, ' ').trim();
  const cut = truncateText(excerpt, FEISHU_SESSION_TITLE_EXCERPT, { ellipsis: '…' }).text;
  return `${FEISHU_SESSION_TITLE_PREFIX}${cut || '新任务'}`;
}

export function acceptedText(sessionName: string): string {
  return `已受理，ModelForge 会话「${sessionName}」开始处理。`;
}

export function steeredText(sessionName: string): string {
  return `已受理，已追加到会话「${sessionName}」正在进行的任务中。`;
}

export function queuedText(sessionName: string): string {
  return `已受理，会话「${sessionName}」正在处理上一条任务，这条消息会在它结束后接着处理。`;
}

export function sessionUnavailableText(): string {
  return '任务未受理：无法创建 ModelForge 会话（内核异常）。请确认 ModelForge 已打开，然后重新发送。';
}

export function failureText(category: FeishuFailureCategory, sessionName: string): string {
  return `任务失败：${category}。已产生的对话记录和文件保留在 ModelForge 会话「${sessionName}」中。`;
}

/** `1 小时 2 分`, `5 分 3 秒`, `42 秒`. */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${seconds} 秒`;
  }
  return `${seconds} 秒`;
}

export function progressText(elapsedMs: number, stepName: string): string {
  return `任务进行中：已运行 ${formatElapsed(elapsedMs)}，最近完成的步骤：${stepName}。`;
}

/** Approval request: tool name, an argument summary of at most 500 code points, and the code. */
export function buildApprovalMessage(toolName: string, args: string, code: string): string {
  const summary = truncateText(args, FEISHU_APPROVAL_TEXT_LIMIT, { ellipsis: '…' }).text;
  return [
    `工具调用需要审批：${toolName}`,
    `参数：${summary || '（无）'}`,
    `回复「批准 ${code}」执行，回复「拒绝 ${code}」不执行；10 分钟内未批准按超时处理。`,
  ].join('\n');
}

export function approvalApprovedText(toolName: string): string {
  return `已批准，继续执行工具「${toolName}」。`;
}

export function approvalRejectedText(toolName: string): string {
  return `工具「${toolName}」未执行：审批被拒绝。`;
}

export function approvalTimedOutText(toolName: string): string {
  return `工具「${toolName}」未执行：审批已超时（10 分钟内未获批准）。`;
}

export function approvalUnknownCodeText(code: string): string {
  return `审批码 ${code} 无效或已失效，没有对应的待审批工具调用。`;
}

const APPROVAL_REPLY = new RegExp(
  `^(批准|拒绝)[\\s\\u3000]*([A-Za-z0-9]{${FEISHU_APPROVAL_CODE_LENGTH}})$`
);

/**
 * Recognizes `批准 <code>` and `拒绝 <code>` (any spacing, any letter case). Anything that
 * matches is an approval reply and is never forwarded as a new task, even with an unknown code.
 */
export function parseApprovalReply(text: string): FeishuApprovalReply | null {
  const match = APPROVAL_REPLY.exec(text.trim());
  if (!match) {
    return null;
  }
  return {
    action: match[1] === '批准' ? 'approve' : 'reject',
    code: match[2].toUpperCase(),
  };
}

export function generateApprovalCode(
  nextInt: (max: number) => number = (max) => randomInt(max)
): string {
  return Array.from(
    { length: FEISHU_APPROVAL_CODE_LENGTH },
    () => FEISHU_APPROVAL_ALPHABET[nextInt(FEISHU_APPROVAL_ALPHABET.length)]
  ).join('');
}

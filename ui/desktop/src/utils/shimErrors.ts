/**
 * Turns an upstream provider error into something the user can act on.
 *
 * The kernel surfaces whatever message we hand back, so a raw
 * `{"error":{"message":"..."}}` body is not good enough: these paths are where a wrong key,
 * a wrong endpoint, an exhausted balance or a too-small context window show up.
 */
function extractDetail(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) {
    return '';
  }
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: string } | string;
      message?: string;
    };
    const error = parsed.error;
    if (typeof error === 'string') return error;
    return error?.message ?? parsed.message ?? trimmed;
  } catch {
    return trimmed;
  }
}

function withDetail(lead: string, detail: string): string {
  return detail ? `${lead}\n${detail}` : lead;
}

const CONTEXT_OVERFLOW = /context|too long|length/i;
const TOOL_UNSUPPORTED = /tool|function/i;

/**
 * Providers reject an oversized `max_tokens` with wording that also matches the context-overflow
 * pattern, so the two must be told apart explicitly: the wrapped CLI asks for its own output budget
 * (64k), and reporting that as "prompt is too long" sends the kernel off to compact history instead
 * of lowering the output budget.
 */
const OUTPUT_LIMIT = /max_?tokens|max_?completion_?tokens|max_?output_?tokens|output_?limit/i;
const OUTPUT_LIMIT_QUALIFIER = /must be|at most|no more than|maximum|exceed|less than|<=|larger/i;
const STATED_NUMBER = /(\d[\d,_]{2,})/;

/** The output budget the upstream says it will accept, when it states one. */
export function parseMaxOutputTokens(body: string): number | null {
  const detail = extractDetail(body);
  if (!OUTPUT_LIMIT.test(detail) || !OUTPUT_LIMIT_QUALIFIER.test(detail)) {
    return null;
  }
  const stated = STATED_NUMBER.exec(detail);
  if (!stated) {
    return null;
  }
  const value = Number(stated[1].replace(/[,_]/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** True when the failure is about the requested output budget rather than the prompt size. */
export function isOutputLimitError(status: number, body: string): boolean {
  return status === 400 && parseMaxOutputTokens(body) !== null;
}

/** Anthropic-shaped error type, so a kernel's own error handling sees what it expects. */
export function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  if (status >= 400 && status < 500) return 'invalid_request_error';
  return 'api_error';
}

/**
 * Anthropic's SDK recognises an over-long prompt by its wording, which is what triggers the
 * kernel's reactive compaction. Keep that phrasing in front of our own hint.
 */
export function isContextOverflow(status: number, body: string): boolean {
  return status === 400 && CONTEXT_OVERFLOW.test(extractDetail(body));
}

/**
 * `max_tokens` is not part of the wrap-up: it is sent because the CLI believes it is talking to a
 * model with a 64k output budget. When the real model is smaller, the size error is the actionable
 * one, so name it instead of letting it read as an exhausted context window.
 */
export function describeOutputLimitError(body: string, model: string): string {
  const detail = extractDetail(body);
  const allowed = parseMaxOutputTokens(body);
  return (
    `输出上限超出模型限制：模型「${model}」不接受本次请求的 max_tokens（${allowed ?? '上游未给出具体值'}）。\n` +
    `已自动按上游允许的上限重试；若仍失败，请在「设置 → 应用 → 智能体内核」里为「${model}」填写正确的输出上限。\n${detail}`
  );
}

export function describeUpstreamError(status: number, body: string, model: string): string {
  const detail = extractDetail(body);

  if (status === 401 || status === 403) {
    return withDetail(
      `API Key 被拒绝（${status}）：密钥无效、过期或没有该模型的权限。请在「设置 → 模型」或「设置 → 应用 → 智能体内核」重新填写密钥。`,
      detail
    );
  }
  if (status === 404) {
    return withDetail(
      `找不到接口或模型（404）：请确认 provider 的 API 地址与模型名「${model}」是否正确。`,
      detail
    );
  }
  if (status === 429) {
    return withDetail('上游限流或余额不足（429）：稍后重试，或检查账户余额。', detail);
  }
  if (status === 402) {
    return withDetail('上游账户余额不足（402）：请充值后重试。', detail);
  }
  if (isContextOverflow(status, body)) {
    // Recognisable by both the wording and (for Responses clients) the error code.
    return `prompt is too long: ${detail}\n提示：请求已超过模型「${model}」的上下文窗口。可以开始一个新会话；内核接近上限时也会自行压缩历史。`;
  }
  if (status === 400 && TOOL_UNSUPPORTED.test(detail)) {
    return `${detail}\n提示：模型「${model}」可能不支持工具调用，换一个支持 function calling 的模型（例如 deepseek-chat / deepseek-v4-pro）即可。`;
  }
  if (status >= 500) {
    return withDetail(`上游服务异常（${status}）：通常是临时的，稍后重试即可。`, detail);
  }
  return withDetail(`上游返回 ${status}。`, detail || '没有更详细的信息。');
}

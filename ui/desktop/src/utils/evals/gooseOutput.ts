/**
 * What the evaluation runner (evals/modeling/run.mts) reads back from headless goose runs (spec
 * mathmodel-parity-and-beyond, requirement 23.2, 23.7, 23.8).
 *
 * Token usage comes from two places in goose (crates/goose-cli/src/session/mod.rs):
 * - `goose run --output-format json` prints one JSON object when the run ends, whether it
 *   succeeded or not: `{ "messages": [...], "metadata": { "total_tokens", "input_tokens",
 *   "output_tokens", ..., "status": "completed" | "error" } }`. The counts are the session's
 *   accumulated usage including subagent sessions (`get_session_usage_totals`).
 * - A run that is stopped (timeout, budget, Ctrl+C) prints nothing. Its usage is still in the
 *   session record, updated after every model response: `goose session list --format json -w
 *   <dir>` lists the sessions of a working directory with their `accumulated_usage`. Only user
 *   sessions are listed, so subagent usage is missing from this fallback. The runner also polls it
 *   while a task runs, to stop the task once the budget is reached.
 *
 * Pure functions without runtime imports, runnable under Node's type stripping.
 */
import type { EvalFailure, EvalTaskStatus, TokenSource } from './evalSummary';

export interface TokenUsage {
  tokensIn: number;
  tokensOut: number;
}

export interface GooseJsonOutput {
  /** `metadata.status`; `null` when missing. */
  status: 'completed' | 'error' | null;
  /** `null` when goose could not read the session's usage. */
  usage: TokenUsage | null;
  /** Text blocks of the assistant messages, in order. */
  assistantText: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Input and output tokens from goose's `input_tokens`, `output_tokens` and `total_tokens`. A
 * missing side is derived from the total when possible; `null` when nothing is known.
 */
export function usageFromCounts(counts: unknown): TokenUsage | null {
  if (!isRecord(counts)) {
    return null;
  }
  const input = count(counts.input_tokens);
  const output = count(counts.output_tokens);
  const total = count(counts.total_tokens);
  if (input !== null && output !== null) {
    return { tokensIn: input, tokensOut: output };
  }
  if (input !== null) {
    return { tokensIn: input, tokensOut: total === null ? 0 : Math.max(0, total - input) };
  }
  if (output !== null) {
    return { tokensIn: total === null ? 0 : Math.max(0, total - output), tokensOut: output };
  }
  return total === null ? null : { tokensIn: total, tokensOut: 0 };
}

function assistantTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) {
    return [];
  }
  const texts: string[] = [];
  for (const message of messages) {
    if (!isRecord(message) || message.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
        texts.push(block.text);
      }
    }
  }
  return texts;
}

function toOutput(value: unknown): GooseJsonOutput | null {
  if (!isRecord(value) || (!isRecord(value.metadata) && !Array.isArray(value.messages))) {
    return null;
  }
  const metadata: Record<string, unknown> = isRecord(value.metadata) ? value.metadata : {};
  const status =
    metadata.status === 'completed' || metadata.status === 'error' ? metadata.status : null;
  return { status, usage: usageFromCounts(metadata), assistantText: assistantTexts(value.messages) };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The JSON object `goose run --output-format json` prints at the end of stdout. Other lines
 * printed before or after it are skipped: serde pretty-prints the object with its opening and
 * closing braces alone at the start of a line, and string values never contain a raw newline,
 * so the object is the last run of lines from a line starting with `{` to a line `}` that parses
 * (or a single line `{...}`).
 */
export function parseGooseJsonOutput(stdout: string): GooseJsonOutput | null {
  const text = stdout.trim();
  if (text.length === 0) {
    return null;
  }
  const whole = toOutput(tryParse(text));
  if (whole !== null) {
    return whole;
  }
  const lines = text.split(/\r?\n/);
  for (let start = lines.length - 1; start >= 0; start -= 1) {
    if (!lines[start].startsWith('{')) {
      continue;
    }
    for (let end = lines.length - 1; end >= start; end -= 1) {
      const line = lines[end].trimEnd();
      const closes = line === '}' || (end === start && line.endsWith('}'));
      if (!closes) {
        continue;
      }
      const parsed = toOutput(tryParse(lines.slice(start, end + 1).join('\n')));
      if (parsed !== null) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Normalized form of a path for comparison: forward slashes, no `\\?\` prefix, no duplicate or
 * trailing separators, lowercase when the file system ignores case (Windows).
 */
export function normalizePathForCompare(value: string, caseInsensitive: boolean): string {
  let normalized = value.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (normalized.length > 1 && normalized.endsWith('/') && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '');
  }
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string, caseInsensitive: boolean): boolean {
  return normalizePathForCompare(a, caseInsensitive) === normalizePathForCompare(b, caseInsensitive);
}

export interface SessionUsage extends TokenUsage {
  /** Number of sessions recorded for the working directory. */
  sessions: number;
}

function parseSessionList(listJson: string): unknown[] | null {
  const whole = tryParse(listJson.trim());
  if (Array.isArray(whole)) {
    return whole;
  }
  const lines = listJson.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.startsWith('[')) {
      const parsed = tryParse(line);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}

/**
 * Tokens recorded for the sessions whose working directory is exactly `workDir`, from the output
 * of `goose session list --format json -w <workDir>` (goose's `-w` filter matches substrings, so
 * the directory is compared again here). `null` when the output has no session list; a list
 * without a matching session gives 0 sessions. A session without recorded usage counts 0.
 */
export function sessionUsageForDir(
  listJson: string,
  workDir: string,
  caseInsensitive: boolean
): SessionUsage | null {
  const sessions = parseSessionList(listJson);
  if (sessions === null) {
    return null;
  }
  let matched = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const session of sessions) {
    if (
      !isRecord(session) ||
      typeof session.working_dir !== 'string' ||
      !samePath(session.working_dir, workDir, caseInsensitive)
    ) {
      continue;
    }
    matched += 1;
    const usage = usageFromCounts(session.accumulated_usage);
    if (usage !== null) {
      tokensIn += usage.tokensIn;
      tokensOut += usage.tokensOut;
    }
  }
  return { tokensIn, tokensOut, sessions: matched };
}

/**
 * The session record as a fallback for a run without usable JSON output. No session for the
 * working directory means goose never started one, so no model was called, for a run that ended
 * by itself. For a run the runner had to stop, a missing session more likely means the record
 * could not be matched, so the usage stays unknown and the budget gate stops later calls.
 */
export function fallbackUsage(session: SessionUsage | null, stopped: boolean): TokenUsage | null {
  if (session === null) {
    return null;
  }
  if (session.sessions > 0) {
    return { tokensIn: session.tokensIn, tokensOut: session.tokensOut };
  }
  return stopped ? null : { tokensIn: 0, tokensOut: 0 };
}

export interface ResolvedTokens extends TokenUsage {
  tokenSource: TokenSource;
}

/** Prefers goose's own output, then the session record; NaN when neither is known. */
export function resolveTokens(
  output: TokenUsage | null,
  session: TokenUsage | null
): ResolvedTokens {
  if (output !== null) {
    return { ...output, tokenSource: 'output' };
  }
  if (session !== null) {
    return { ...session, tokenSource: 'session' };
  }
  return { tokensIn: Number.NaN, tokensOut: Number.NaN, tokenSource: 'unknown' };
}

/** How one headless goose run ended. */
export interface RunOutcome {
  /** Error code when goose could not be started (for example ENOENT). */
  spawnError: string | null;
  /** Why the runner stopped goose, if it did. */
  stoppedBy: 'timeout' | 'budget' | 'interrupted' | null;
  exitCode: number | null;
  signal: string | null;
  /** `metadata.status` of the JSON output, when there was one. */
  reported: 'completed' | 'error' | null;
}

export interface RunClassification {
  status: EvalTaskStatus;
  failure?: EvalFailure;
}

/**
 * Requirement 23.7 and 23.8: a run over the time limit is 失败 / 超时; a run stopped for the
 * budget or by the maintainer is 已中止; any other run that did not end cleanly is 失败 /
 * 模型调用失败 (goose exits non-zero when the model call fails).
 */
export function classifyRun(outcome: RunOutcome): RunClassification {
  if (outcome.spawnError !== null) {
    return { status: '失败', failure: '模型调用失败' };
  }
  if (outcome.stoppedBy === 'timeout') {
    return { status: '失败', failure: '超时' };
  }
  if (outcome.stoppedBy !== null) {
    return { status: '已中止' };
  }
  if (outcome.exitCode !== 0 || outcome.reported === 'error') {
    return { status: '失败', failure: '模型调用失败' };
  }
  return { status: '完成' };
}

/**
 * A short description of an unclean end, for the result file. It never includes goose's own
 * error text, which stays in the local log, because the result file is committed.
 */
export function describeOutcome(outcome: RunOutcome, timeoutMinutes: number): string | undefined {
  if (outcome.spawnError !== null) {
    return `无法启动 goose（${outcome.spawnError}）`;
  }
  switch (outcome.stoppedBy) {
    case 'timeout':
      return `超过 ${timeoutMinutes} 分钟未结束，已停止`;
    case 'budget':
      return 'token 用量达到预算上限，已停止';
    case 'interrupted':
      return '维护者中断了运行';
    case null:
      break;
  }
  if (outcome.exitCode === null) {
    return `goose 被信号 ${outcome.signal ?? '未知'} 终止`;
  }
  if (outcome.exitCode !== 0) {
    return `goose 退出码 ${outcome.exitCode}`;
  }
  return outcome.reported === 'error' ? 'goose 报告运行出错' : undefined;
}

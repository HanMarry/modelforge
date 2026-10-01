/**
 * Feishu reply formatting (requirement 15.2, 15.7).
 *
 * `formatSummary` renders the task status, the Artifact file names produced by the run and,
 * when there is one, the final reply of the turn, then caps the result at 2000 code points.
 * When it is truncated, a note pointing the user at the corresponding ModelForge session is
 * appended and counts toward the limit.
 */
import { truncateText } from '../../utils/textTruncate';

export const FEISHU_SUMMARY_LIMIT = 2000;
export const FEISHU_SUMMARY_NOTE = '完整结果请在 ModelForge 对应会话中查看';

export interface SummaryResult {
  status: string;
  artifactFileNames: string[];
  /** The final assistant reply of the turn; the part most likely to be cut, so it goes last. */
  reply?: string;
}

function buildSummary(result: SummaryResult): string {
  const lines = [`状态：${result.status}`];
  if (result.artifactFileNames.length > 0) {
    lines.push('生成文件：', ...result.artifactFileNames.map((name) => `- ${name}`));
  }
  const reply = result.reply?.trim();
  if (reply) {
    lines.push('结果：', reply);
  }
  return lines.join('\n');
}

export function formatSummary(result: SummaryResult): string {
  const body = buildSummary(result);
  if ([...body].length <= FEISHU_SUMMARY_LIMIT) {
    return body;
  }
  const noteLength = [...FEISHU_SUMMARY_NOTE].length;
  const head = truncateText(body, FEISHU_SUMMARY_LIMIT - noteLength, { ellipsis: '' }).text;
  return head + FEISHU_SUMMARY_NOTE;
}

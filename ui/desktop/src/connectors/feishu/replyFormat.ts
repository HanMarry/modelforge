/**
 * Feishu reply formatting (requirement 15.2, 15.7).
 *
 * `formatSummary` renders the task status and the Artifact file names produced by the run,
 * then caps the result at 2000 code points. When it is truncated, a note pointing the user at
 * the corresponding ModelForge session is appended and counts toward the limit.
 */
import { truncateText } from '../../utils/textTruncate';

export const FEISHU_SUMMARY_LIMIT = 2000;
export const FEISHU_SUMMARY_NOTE = '完整结果请在 ModelForge 对应会话中查看';

export interface SummaryResult {
  status: string;
  artifactFileNames: string[];
}

function buildSummary(result: SummaryResult): string {
  if (result.artifactFileNames.length === 0) {
    return `状态：${result.status}`;
  }
  const files = result.artifactFileNames.map((name) => `- ${name}`).join('\n');
  return `状态：${result.status}\n生成文件：\n${files}`;
}

export function formatSummary(result: SummaryResult): string {
  const body = buildSummary(result);
  if ([...body].length <= FEISHU_SUMMARY_LIMIT) {
    return body;
  }
  const noteLength = [...FEISHU_SUMMARY_NOTE].length;
  const head = truncateText(body, FEISHU_SUMMARY_LIMIT - noteLength, { ellipsis: '' });
  return head + FEISHU_SUMMARY_NOTE;
}

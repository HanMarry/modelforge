import type { LearningModeDto } from '@aaif/goose-acp-client';
import { getAcpClient } from './acpConnection';

export type LearningMode = LearningModeDto;

/**
 * Sets the learning mode of session `sessionId`, or leaves it with `null`
 * (`_goose/unstable/session/learning-mode/set`, spec mathmodel-parity-and-beyond, task 27.5). The
 * Kernel keeps `learningMode { exerciseId, solutionUnlocked }` in the session `extension_data`
 * and, while it is set, adds the learning-mode system prompt (hints and questions instead of full
 * solution code; `crates/goose/src/acp/server/learning_mode_prompt.md`), also after the session
 * is loaded again. Contract: `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 *
 * Errors are thrown as they come: an unknown session is `ResourceNotFound`, an exercise id that
 * is not kebab-case is `InvalidParams`, and a Kernel that was not told about the capability
 * answers `data.code = CAPABILITY_NOT_DECLARED`. `utils/learning/learningChat.ts` wraps it for
 * the learning page.
 */
export async function setLearningMode(
  sessionId: string,
  learningMode: LearningMode | null
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionLearningModeSet_unstable({ sessionId, learningMode });
}

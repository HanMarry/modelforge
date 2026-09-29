import type { LearningModeDto } from '@aaif/goose-acp-client';
import { getAcpClient } from './acpConnection';

export type LearningMode = LearningModeDto;

/**
 * Sets the learning mode of session `sessionId`, or leaves it with `null`
 * (`_goose/unstable/session/learning-mode/set`, spec mathmodel-parity-and-beyond, task 27.5). The
 * Kernel keeps `learningMode { exerciseId, solutionUnlocked }` in the session and, while it is
 * set, answers with hints and questions instead of full solution code. Contract:
 * `.kiro/specs/mathmodel-parity-and-beyond/layer-c-contract-acp.md`.
 *
 * Until branch `mp/s2-c1-learning` implements the Kernel side, the request fails with an error
 * whose `data.code` is `NOT_IMPLEMENTED`.
 */
export async function setLearningMode(
  sessionId: string,
  learningMode: LearningMode | null
): Promise<void> {
  const client = await getAcpClient();
  await client.goose.sessionLearningModeSet_unstable({ sessionId, learningMode });
}

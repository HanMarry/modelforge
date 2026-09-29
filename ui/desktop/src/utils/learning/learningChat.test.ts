import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LearningExercise } from '../../types/learningApi';
import {
  exerciseChatMessage,
  leaveLearningMode,
  startLearningChat,
  unlockLearningChats,
} from './learningChat';
import { learningSessionsFor, rememberLearningSession } from './learningSessions';

const acp = vi.hoisted(() => ({ setLearningMode: vi.fn(), acpDeleteSession: vi.fn() }));
vi.mock('../../acp/learningMode', () => ({ setLearningMode: acp.setLearningMode }));
vi.mock('../../acp/sessions', () => ({ acpDeleteSession: acp.acpDeleteSession }));

const exercise: LearningExercise = {
  id: 'lp-production-plan',
  title: '两种产品的周生产计划',
  prompt: '建立线性规划模型。',
  checks: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  acp.setLearningMode.mockResolvedValue(undefined);
  acp.acpDeleteSession.mockResolvedValue(undefined);
});

describe('exerciseChatMessage', () => {
  it('hands the exercise to the Kernel and asks for the solution only once unlocked', () => {
    const locked = exerciseChatMessage(exercise, false);
    expect(locked).toContain('两种产品的周生产计划');
    expect(locked).toContain('建立线性规划模型。');
    expect(locked).not.toContain('完整解答代码');

    expect(exerciseChatMessage(exercise, true)).toContain('完整解答代码');
  });
});

describe('startLearningChat', () => {
  it('puts the new session into learning mode and remembers it', async () => {
    const createSession = vi.fn(async () => ({ id: 's1', name: 'chat' }));

    const started = await startLearningChat(exercise, '/project', false, { createSession });

    expect(createSession).toHaveBeenCalledWith('/project');
    expect(acp.setLearningMode).toHaveBeenCalledWith('s1', {
      exerciseId: 'lp-production-plan',
      solutionUnlocked: false,
    });
    expect(started.session).toEqual({ id: 's1', name: 'chat' });
    expect(started.message).toBe(exerciseChatMessage(exercise, false));
    expect(learningSessionsFor('lp-production-plan')).toEqual(['s1']);
  });

  it('deletes the session when the Kernel refuses learning mode', async () => {
    acp.setLearningMode.mockRejectedValueOnce(new Error('CAPABILITY_NOT_DECLARED'));
    const createSession = vi.fn(async () => ({ id: 's2' }));

    await expect(
      startLearningChat(exercise, '/project', true, { createSession })
    ).rejects.toThrow('CAPABILITY_NOT_DECLARED');

    expect(acp.acpDeleteSession).toHaveBeenCalledWith('s2');
    expect(learningSessionsFor('lp-production-plan')).toEqual([]);
  });
});

describe('unlockLearningChats and leaveLearningMode', () => {
  it('update every remembered chat of the exercise, even when one fails', async () => {
    rememberLearningSession('lp-production-plan', 'a');
    rememberLearningSession('lp-production-plan', 'b');
    rememberLearningSession('lp-production-plan', 'a');
    rememberLearningSession('other', 'c');
    acp.setLearningMode.mockRejectedValueOnce(new Error('Session not found'));

    await unlockLearningChats('lp-production-plan');

    expect(acp.setLearningMode.mock.calls).toEqual([
      ['a', { exerciseId: 'lp-production-plan', solutionUnlocked: true }],
      ['b', { exerciseId: 'lp-production-plan', solutionUnlocked: true }],
    ]);
    expect(learningSessionsFor('lp-production-plan')).toEqual(['a', 'b']);

    acp.setLearningMode.mockClear();
    await leaveLearningMode('lp-production-plan');

    expect(acp.setLearningMode.mock.calls).toEqual([
      ['a', null],
      ['b', null],
    ]);
    expect(learningSessionsFor('lp-production-plan')).toEqual([]);
    expect(learningSessionsFor('other')).toEqual(['c']);
  });

  it('ignores a corrupt session list', async () => {
    window.localStorage.setItem('modelforge.learning.sessions', '{not json');
    expect(learningSessionsFor('lp-production-plan')).toEqual([]);
    await leaveLearningMode('lp-production-plan');
    expect(acp.setLearningMode).not.toHaveBeenCalled();
  });
});

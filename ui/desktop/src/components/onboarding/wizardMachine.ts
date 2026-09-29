/**
 * First-boot wizard state machine (spec mathmodel-parity-and-beyond, requirement 5.1, 5.2,
 * 5.4). Pure transitions over four ordered steps; the UI holds this state and renders one
 * step at a time. Skipped steps are remembered so the diagnostics centre can offer "补做".
 */
import type { OnboardingState, OnboardingStepId, OnboardingStepStatus } from '../../utils/settings';

export const ONBOARDING_STEPS: readonly OnboardingStepId[] = [
  'provider',
  'key',
  'environment',
  'example',
];

export const ONBOARDING_STEP_COUNT = ONBOARDING_STEPS.length;

/** Length bounds the key input enforces before a submit is allowed (requirement 5.2). */
export const KEY_MIN_LENGTH = 1;
export const KEY_MAX_LENGTH = 512;

export interface WizardState {
  current: OnboardingStepId;
  steps: Record<OnboardingStepId, OnboardingStepStatus>;
  completed: boolean;
}

export function initialWizardState(persisted?: OnboardingState): WizardState {
  return {
    current: 'provider',
    steps: persisted
      ? { ...persisted.steps }
      : { provider: 'pending', key: 'pending', environment: 'pending', example: 'pending' },
    completed: persisted?.completed ?? false,
  };
}

export function stepIndex(step: OnboardingStepId): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/** Marks the current step done and advances, completing the wizard after the last step. */
export function next(state: WizardState): WizardState {
  const index = stepIndex(state.current);
  const steps = { ...state.steps, [state.current]: 'done' };
  if (index >= ONBOARDING_STEPS.length - 1) {
    return { ...state, steps, completed: true };
  }
  return { ...state, steps, current: ONBOARDING_STEPS[index + 1] };
}

/** Marks the current step skipped and advances, completing the wizard after the last step. */
export function skip(state: WizardState): WizardState {
  const index = stepIndex(state.current);
  const steps = { ...state.steps, [state.current]: 'skipped' };
  if (index >= ONBOARDING_STEPS.length - 1) {
    return { ...state, steps, completed: true };
  }
  return { ...state, steps, current: ONBOARDING_STEPS[index + 1] };
}

/** Returns to the previous step; the first step has no previous step. */
export function prev(state: WizardState): WizardState {
  const index = stepIndex(state.current);
  if (index <= 0) {
    return state;
  }
  return { ...state, current: ONBOARDING_STEPS[index - 1] };
}

/** Jumps to a step, for the diagnostics centre's "补做" entry (requirement 5.4). */
export function openAt(state: WizardState, step: OnboardingStepId): WizardState {
  return { ...state, current: step };
}

/** Steps the user skipped, in wizard order — the diagnostics centre's "补做" list. */
export function skippedSteps(state: WizardState): OnboardingStepId[] {
  return ONBOARDING_STEPS.filter((step) => state.steps[step] === 'skipped');
}

/**
 * A key is submittable when, after trimming, it has 1 to 512 characters (requirement 5.2).
 */
export function isKeySubmittable(key: string): boolean {
  const trimmed = key.trim();
  return trimmed.length >= KEY_MIN_LENGTH && trimmed.length <= KEY_MAX_LENGTH;
}

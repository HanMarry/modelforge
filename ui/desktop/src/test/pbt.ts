/**
 * Shared settings for property-based tests (spec: mathmodel-parity-and-beyond, Testing Strategy).
 *
 * Every correctness property runs at least 100 generated cases and carries the tag
 *   // Feature: mathmodel-parity-and-beyond, Property N: <title>
 * next to its test.
 */
export const PBT_RUNS = 100;

export const pbtParams = { numRuns: PBT_RUNS } as const;

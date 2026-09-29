import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  forcedExclusionReason,
  selectShareFiles,
  SHARE_EXCLUSION_REASONS,
} from './shareFilter';

const FORCED_PATHS = [
  '.modelforge/sessions/abc.json',
  '.modelforge/sessions/deep/nested.md',
  'notes.log',
  '.env',
  '.env.local',
  'data/credentials.json',
  'credentials',
  'agent-kernel-secrets.json',
];

const NORMAL_PATHS = ['paper.pdf', 'abstract.md', 'data/input.csv', 'figures/plot.png', 'code.py'];

const pathArb = fc.constantFrom(...FORCED_PATHS, ...NORMAL_PATHS);
const candidatesArb = fc.array(pathArb, { maxLength: 20 });

// Feature: mathmodel-parity-and-beyond, Property 29: 分享包排除规则优先
describe('Property 29: 分享包排除规则优先', () => {
  it('selection is a subset of checked files and never includes a forced exclusion', () => {
    fc.assert(
      fc.property(
        candidatesArb,
        fc.boolean(),
        (candidates, withSensitive) => {
          const candidateSet = new Set(candidates);
          const sensitive = withSensitive
            ? new Set(candidates.filter((_, i) => i % 2 === 0))
            : new Set<string>();
          const checked = new Set(candidates.filter((_, i) => i % 3 === 0));
          const result = selectShareFiles(candidates, checked, { sensitiveContent: sensitive });

          for (const path of result.selected) {
            expect(checked.has(path)).toBe(true);
            expect(result.excluded.some((excluded) => excluded.path === path)).toBe(false);
          }

          for (const path of candidateSet) {
            if (!checked.has(path)) {
              expect(result.selected).not.toContain(path);
            }
          }

          for (const { path, reason } of result.excluded) {
            expect(SHARE_EXCLUSION_REASONS).toContain(reason);
            const pathRule = forcedExclusionReason(path);
            if (reason === 'sensitive-content') {
              expect(sensitive.has(path)).toBe(true);
              expect(pathRule).toBeNull();
            } else {
              expect(pathRule).toBe(reason);
            }
          }
        }
      ),
      pbtParams
    );
  });

  it('reports a reason for every forced exclusion, checked or not', () => {
    const candidates = [...FORCED_PATHS, ...NORMAL_PATHS];
    const result = selectShareFiles(candidates, new Set(), { sensitiveContent: new Set() });
    expect(result.selected).toEqual([]);
    expect(result.excluded.map((entry) => entry.path)).toEqual(FORCED_PATHS);
  });
});

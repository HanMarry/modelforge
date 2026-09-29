import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTaskPlan, serializeTaskPlan } from '../resumePlanner';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

interface TaskPlanVectors {
  plans: unknown[];
  invalid: Array<{ name: string; plan: unknown; missing: string[]; invalid: string[] }>;
}

const vectors = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'fixtures/task-plan-vectors.json'), 'utf8')
) as TaskPlanVectors;

// The kernel half is `shared_vectors_*` in crates/goose-run-record/src/task_plan.rs: both sides
// write these plans byte for byte and reject the same invalid ones with the same field names.
describe('shared task plan vectors (fixtures/task-plan-vectors.json)', () => {
  it('reads every plan and writes it back unchanged', () => {
    expect(vectors.plans.length).toBeGreaterThan(0);
    for (const value of vectors.plans) {
      const canonical = `${JSON.stringify(value, null, 2)}\n`;
      const result = parseTaskPlan(canonical);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.plan).toEqual(value);
        expect(serializeTaskPlan(result.plan)).toBe(canonical);
      }
    }
  });

  it('rejects every invalid plan with the listed fields', () => {
    expect(vectors.invalid.length).toBeGreaterThan(0);
    for (const vector of vectors.invalid) {
      const result = parseTaskPlan(JSON.stringify(vector.plan), 'plan.json');
      expect(result.ok, vector.name).toBe(false);
      if (!result.ok) {
        expect({ missing: result.missing, invalid: result.invalid }, vector.name).toEqual({
          missing: vector.missing,
          invalid: vector.invalid,
        });
      }
    }
  });
});

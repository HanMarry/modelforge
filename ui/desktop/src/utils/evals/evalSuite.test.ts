import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structure of the modeling evaluation suite in evals/modeling/ (requirement 23.1). The desktop
 * package has no YAML parser, so task.yaml and checks.yaml are read with line patterns that match
 * the layout those files use; baseline.json is validated in full.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const suiteDir = path.join(repoRoot, 'evals', 'modeling');

const CATEGORIES = ['优化类', '预测/统计类', '综合评价类'];
const QUESTIONS = ['问题一', '问题二', '问题三'];
const CHECK_QUESTIONS = ['全题', ...QUESTIONS];
const CHECK_METHODS = ['file', 'baseline', 'manual'];
const KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TEMPLATE_DELIMITERS = ['{{', '}}', '{%', '%}', '{#', '#}'];

const taskIds = fs
  .readdirSync(suiteDir, { withFileTypes: true })
  .filter(
    (entry) => entry.isDirectory() && fs.existsSync(path.join(suiteDir, entry.name, 'task.yaml'))
  )
  .map((entry) => entry.name)
  .sort();

function read(taskId: string, file: string): string {
  return fs.readFileSync(path.join(suiteDir, taskId, file), 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) && Object.keys(value).length > 0 && Object.values(value).every(isFiniteNumber)
  );
}

/** `[a, b, c]` on one line, as task.yaml and checks.yaml write their lists. */
function parseFlowList(value: string | undefined): string[] | undefined {
  const match = value === undefined ? null : /^\[(.*)\]$/.exec(value.trim());
  if (match === null) {
    return undefined;
  }
  return match[1]
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/** The value of a `name: value` line indented by `indent` spaces. */
function field(text: string, name: string, indent: number): string | undefined {
  return new RegExp(`^ {${indent}}${name}: (.+)$`, 'm').exec(text)?.[1].trim();
}

interface CheckEntry {
  id: string;
  question: string | undefined;
  method: string | undefined;
  path: string | undefined;
  keys: string[] | undefined;
  criterion: string | undefined;
}

function parseChecks(text: string): { taskId: string | undefined; checks: CheckEntry[] } {
  const [head, ...blocks] = text.split(/^ {2}- id: /m);
  return {
    taskId: field(head, 'id', 0),
    checks: blocks.map((block) => {
      const newline = block.indexOf('\n');
      const body = newline === -1 ? '' : block.slice(newline + 1);
      const keys = field(body, 'keys', 4);
      return {
        id: (newline === -1 ? block : block.slice(0, newline)).trim(),
        question: field(body, 'question', 4),
        method: field(body, 'method', 4),
        path: field(body, 'path', 4),
        keys: keys === undefined ? undefined : (parseFlowList(keys) ?? []),
        criterion: field(body, 'criterion', 4),
      };
    }),
  };
}

interface BaselineItem {
  key: string;
  value: unknown;
}

function valueProblems(item: Record<string, unknown>): string[] {
  const { value, tolerance } = item;
  if (value === null) {
    const problems: string[] = [];
    if (tolerance !== null) problems.push('a pending value must have tolerance null');
    if (!isNonEmptyString(item.pending)) problems.push('a pending value must say why');
    return problems;
  }
  if (item.pending !== undefined) {
    return ['only values that are null may be pending'];
  }
  if (!isNonEmptyString(item.toleranceBasis)) {
    return ['toleranceBasis must explain the tolerance'];
  }
  if (!isRecord(tolerance)) {
    return ['tolerance must be an object'];
  }
  switch (tolerance.mode) {
    case 'exact': {
      const ok =
        isFiniteNumber(value) ||
        isNonEmptyString(value) ||
        (Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString)) ||
        isNumberRecord(value);
      return ok ? [] : ['exact values must be a number, a string, a string list or a number map'];
    }
    case 'abs': {
      const problems: string[] = [];
      if (!isFiniteNumber(tolerance.value) || tolerance.value < 0) {
        problems.push('abs tolerance needs a non-negative value');
      }
      if (!isFiniteNumber(value) && !isNumberRecord(value)) {
        problems.push('abs values must be a number or a number map');
      }
      return problems;
    }
    case 'range': {
      const { min, max } = tolerance;
      if (!isFiniteNumber(min) || !isFiniteNumber(max) || min > max) {
        return ['range tolerance needs finite min <= max'];
      }
      if (!isFiniteNumber(value) || value < min || value > max) {
        return ['a range value must be a number inside [min, max]'];
      }
      return [];
    }
    default:
      return [`unknown tolerance mode ${JSON.stringify(tolerance.mode)}`];
  }
}

/** Every structural problem of a baseline.json, one line each; empty when it is valid. */
function baselineProblems(baseline: unknown, taskId: string): string[] {
  if (!isRecord(baseline)) {
    return ['baseline is not a JSON object'];
  }
  const problems: string[] = [];
  if (baseline.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (baseline.id !== taskId) problems.push(`id must be ${taskId}`);
  if (!isNonEmptyString(baseline.conventions)) problems.push('conventions must be described');
  if (!isNonEmptyString(baseline.method)) problems.push('method must say how values were computed');

  const data = baseline.data;
  const isDataFile = (file: unknown) =>
    isRecord(file) && isNonEmptyString(file.path) && SHA256_PATTERN.test(String(file.sha256));
  if (
    !isRecord(data) ||
    !isNonEmptyString(data.generator) ||
    !Number.isSafeInteger(data.seed) ||
    !Array.isArray(data.files) ||
    data.files.length === 0 ||
    !data.files.every(isDataFile)
  ) {
    problems.push('data needs generator, seed and files with path and sha256');
  }

  const values = baseline.values;
  if (!Array.isArray(values) || values.length === 0) {
    return [...problems, 'values must list at least one reference value'];
  }
  const seen = new Set<string>();
  values.forEach((item: unknown, index: number) => {
    const where = `values[${index}]`;
    if (!isRecord(item)) {
      problems.push(`${where}: not an object`);
      return;
    }
    const key = item.key;
    if (!isNonEmptyString(key) || !KEY_PATTERN.test(key)) {
      problems.push(`${where}: key must be snake_case`);
      return;
    }
    const at = `${where} (${key})`;
    if (seen.has(key)) problems.push(`${at}: duplicate key`);
    seen.add(key);
    if (typeof item.question !== 'string' || !QUESTIONS.includes(item.question)) {
      problems.push(`${at}: question must be one of ${QUESTIONS.join(', ')}`);
    }
    if (!isNonEmptyString(item.description)) problems.push(`${at}: description is missing`);
    if (!isNonEmptyString(item.definition)) problems.push(`${at}: definition is missing`);
    if (item.note !== undefined && !isNonEmptyString(item.note)) {
      problems.push(`${at}: note must be a non-empty string`);
    }
    for (const problem of valueProblems(item)) problems.push(`${at}: ${problem}`);
  });
  return problems;
}

function baselineItems(taskId: string): BaselineItem[] {
  const baseline = JSON.parse(read(taskId, 'baseline.json')) as { values: BaselineItem[] };
  return baseline.values;
}

describe('modeling evaluation suite (evals/modeling)', () => {
  it('has at least 3 tasks covering 优化类, 预测/统计类 and 综合评价类', () => {
    expect(taskIds.length).toBeGreaterThanOrEqual(3);
    const categories = taskIds.map((taskId) => field(read(taskId, 'task.yaml'), 'category', 2));
    for (const category of CATEGORIES) {
      expect(categories).toContain(category);
    }
  });

  describe.each(taskIds)('%s', (taskId) => {
    it('has task.yaml, checks.yaml and baseline.json', () => {
      for (const file of ['task.yaml', 'checks.yaml', 'baseline.json']) {
        expect(fs.existsSync(path.join(suiteDir, taskId, file)), file).toBe(true);
      }
    });

    it('task.yaml describes a runnable task built on a redistributable example', () => {
      const text = read(taskId, 'task.yaml');
      expect(text).toMatch(/^eval:$/m);
      expect(text).toMatch(/^recipe:$/m);
      expect(field(text, 'id', 2)).toBe(taskId);
      expect(CATEGORIES).toContain(field(text, 'category', 2));
      expect(field(text, 'timeoutMinutes', 2)).toBe('60');
      expect(field(text, 'paper', 4)).toBe('paper.pdf');
      expect(field(text, 'values', 4)).toBe('results.json');
      expect(field(text, 'checks', 2)).toBe('checks.yaml');
      expect(field(text, 'baseline', 2)).toBe('baseline.json');
      // goose renders the whole file as a template before parsing it.
      for (const delimiter of TEMPLATE_DELIMITERS) {
        expect(text.includes(delimiter), delimiter).toBe(false);
      }

      const example = field(text, 'example', 2);
      expect(example).toBe(`ui/desktop/resources/examples/${taskId}`);
      const exampleDir = path.join(repoRoot, ...String(example).split('/'));
      const manifestText = fs.readFileSync(path.join(exampleDir, 'example.json'), 'utf8');
      const manifest = JSON.parse(manifestText) as {
        id: string;
        category: string;
        license: { redistributable: boolean };
        problemFile: string;
        attachments: string[];
      };
      expect(manifest.id).toBe(taskId);
      expect(manifest.category).toBe(field(text, 'category', 2));
      expect(manifest.license.redistributable).toBe(true);

      const inputs = parseFlowList(field(text, 'inputs', 2));
      expect(inputs).toBeDefined();
      expect(inputs).toContain(manifest.problemFile);
      for (const attachment of manifest.attachments) {
        expect(inputs).toContain(attachment);
      }
      for (const input of inputs ?? []) {
        expect(input.startsWith('solution'), input).toBe(false);
        expect(fs.existsSync(path.join(exampleDir, ...input.split('/'))), input).toBe(true);
      }

      // The prompt asks the agent to report every baseline key.
      for (const { key } of baselineItems(taskId)) {
        expect(text.includes(key), key).toBe(true);
      }
    });

    it('checks.yaml has at least 5 checks, each judgeable as 通过 or 未通过', () => {
      const { taskId: declared, checks } = parseChecks(read(taskId, 'checks.yaml'));
      expect(declared).toBe(taskId);
      expect(checks.length).toBeGreaterThanOrEqual(5);
      expect(new Set(checks.map((check) => check.id)).size).toBe(checks.length);

      const items = baselineItems(taskId);
      const referenced = new Set<string>();
      for (const check of checks) {
        expect(CHECK_QUESTIONS, check.id).toContain(check.question);
        expect(CHECK_METHODS, check.id).toContain(check.method);
        expect(isNonEmptyString(check.criterion), check.id).toBe(true);
        if (check.method === 'file') {
          expect(isNonEmptyString(check.path), check.id).toBe(true);
        }
        if (check.method === 'baseline') {
          expect(check.keys?.length ?? 0, check.id).toBeGreaterThan(0);
          for (const key of check.keys ?? []) {
            const item = items.find((candidate) => candidate.key === key);
            expect(item, `${check.id}: ${key}`).toBeDefined();
            expect(item?.value, `${check.id}: ${key} has no reference value`).not.toBeNull();
            referenced.add(key);
          }
        } else {
          expect(check.keys, check.id).toBeUndefined();
        }
      }
      // Every reference value is compared by some check.
      for (const item of items) {
        if (item.value !== null) {
          expect(referenced.has(item.key), item.key).toBe(true);
        }
      }
    });

    it('baseline.json records reference values, tolerances and the data they came from', () => {
      const baseline: unknown = JSON.parse(read(taskId, 'baseline.json'));
      expect(baselineProblems(baseline, taskId)).toEqual([]);

      const { data } = baseline as {
        data: { generator: string; files: { path: string; sha256: string }[] };
      };
      const exampleDir = path.join(repoRoot, 'ui', 'desktop', 'resources', 'examples', taskId);
      expect(data.generator).toBe(`ui/desktop/resources/examples/${taskId}/generate-data.js`);
      expect(fs.existsSync(path.join(repoRoot, ...data.generator.split('/')))).toBe(true);
      for (const file of data.files) {
        const content = fs.readFileSync(path.join(exampleDir, ...file.path.split('/')));
        expect(createHash('sha256').update(content).digest('hex'), file.path).toBe(file.sha256);
      }
    });
  });
});

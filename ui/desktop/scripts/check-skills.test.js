// @vitest-environment node
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

// The script under test is CommonJS (it runs as a plain `node` script in CI).
const requireCjs = createRequire(import.meta.url);
const {
  BUILTINS,
  LEARNING_GROUP_TITLES,
  LEARNING_PATH_FILE,
  REVIEW_DIMENSIONS,
  builtinSkillNames,
  competitionFocusIds,
  loadMockReviewInputs,
  validateLearningPath,
  validateMockReview,
} = requireCjs('./check-skills.js');

const skillNames = builtinSkillNames(BUILTINS);
const shippedCatalog = JSON.parse(fs.readFileSync(LEARNING_PATH_FILE, 'utf8'));

/** A deep copy of the shipped catalogue, changed by `edit`. */
function editedCatalog(edit) {
  const catalog = structuredClone(shippedCatalog);
  edit(catalog);
  return catalog;
}

const firstCourse = (catalog) => catalog.groups[0].courses[0];
const firstExercise = (catalog) => firstCourse(catalog).exercises[0];

describe('builtin skill names', () => {
  it('include the skills the learning path and the review panel rely on', () => {
    expect(skillNames.has('mathmodel-mock-review')).toBe(true);
    expect(skillNames.has('data-prep')).toBe(true);
    expect(skillNames.has('not-a-skill')).toBe(false);
  });
});

describe('learning path catalogue (requirement 20.1)', () => {
  it('accepts the shipped catalogue', () => {
    expect(validateLearningPath(shippedCatalog, skillNames)).toEqual([]);
  });

  it('has the five groups in order', () => {
    expect(shippedCatalog.groups.map((group) => group.title)).toEqual(LEARNING_GROUP_TITLES);
  });

  it('reports a linked skill that is not builtin', () => {
    const catalog = editedCatalog((draft) => {
      firstCourse(draft).skills.push('imaginary-skill');
    });
    const problems = validateLearningPath(catalog, skillNames);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"imaginary-skill" is not a builtin skill');
  });

  it('reports a course without linked skills, objectives or exercises', () => {
    const catalog = editedCatalog((draft) => {
      const course = firstCourse(draft);
      course.skills = [];
      course.objectives = ['  '];
      course.exercises = [];
    });
    const problems = validateLearningPath(catalog, skillNames);
    expect(problems.some((problem) => problem.includes('at least one linked skill'))).toBe(true);
    expect(problems.some((problem) => problem.includes('at least one learning objective'))).toBe(
      true
    );
    expect(problems.some((problem) => problem.includes('at least one exercise'))).toBe(true);
  });

  it('requires exactly the five groups in the required order', () => {
    const reordered = editedCatalog((draft) => {
      draft.groups.reverse();
    });
    const missing = editedCatalog((draft) => {
      draft.groups.pop();
    });
    for (const catalog of [reordered, missing]) {
      const problems = validateLearningPath(catalog, skillNames);
      expect(problems.some((problem) => problem.startsWith('groups must be'))).toBe(true);
    }
  });

  it('reports a group without courses', () => {
    const catalog = editedCatalog((draft) => {
      draft.groups[4].courses = [];
    });
    expect(validateLearningPath(catalog, skillNames)).toContain(
      `group "${shippedCatalog.groups[4].id}": needs at least one course`
    );
  });

  it('reports exercises without a prompt or check items, and duplicate exercise ids', () => {
    const catalog = editedCatalog((draft) => {
      const exercise = firstExercise(draft);
      exercise.prompt = '';
      exercise.checks = [];
      draft.groups[1].courses[0].exercises[0].id = exercise.id;
    });
    const problems = validateLearningPath(catalog, skillNames);
    const id = firstExercise(shippedCatalog).id;
    expect(problems).toContain(`exercise "${id}": needs a prompt`);
    expect(problems).toContain(`exercise "${id}": needs at least one check item`);
    expect(problems).toContain(`exercise "${id}": duplicate exercise id "${id}"`);
  });

  it('reports malformed check items', () => {
    const catalog = editedCatalog((draft) => {
      firstExercise(draft).checks = [
        { id: 'escape', kind: 'file-exists', description: '越界路径', path: '../secret.txt' },
        { id: 'absolute', kind: 'file-exists', description: '绝对路径', path: '/etc/passwd' },
        {
          id: 'range',
          kind: 'number-in-range',
          description: '上下界颠倒',
          path: 'results/answer.json',
          field: 'value',
          min: 2,
          max: 1,
        },
        {
          id: 'not-json',
          kind: 'number-in-range',
          description: '不是 JSON 文件',
          path: 'results/answer.csv',
          field: 'value',
          min: 0,
          max: 1,
        },
        { id: 'unknown', kind: 'regex', description: '未知类型' },
        { id: 'unknown', kind: 'subjective', description: '重复的 id' },
        { id: 'blank', kind: 'subjective', description: ' ' },
      ];
    });
    const problems = validateLearningPath(catalog, skillNames).join('\n');
    expect(problems).toContain('check "escape": path "../secret.txt" must be relative');
    expect(problems).toContain('check "absolute": path "/etc/passwd" must be relative');
    expect(problems).toContain('check "range": needs finite min <= max');
    expect(problems).toContain('check "not-json": number-in-range reads a field of a .json file');
    expect(problems).toContain('check "unknown": kind "regex" is not one of');
    expect(problems).toContain('check "unknown": duplicate check id');
    expect(problems).toContain('check "blank": needs a description');
  });

  it('rejects a catalogue without groups', () => {
    expect(validateLearningPath({}, skillNames)).toEqual(['"groups" must be an array']);
    expect(validateLearningPath(null, skillNames)).toEqual(['"groups" must be an array']);
  });
});

describe('mock review skill (requirements 19.1, 19.2)', () => {
  const inputs = loadMockReviewInputs();

  it('accepts the shipped skill', () => {
    expect(validateMockReview(inputs)).toEqual([]);
  });

  it('covers every competition of the catalogue in the focus table', () => {
    expect(competitionFocusIds(inputs.body)).toEqual(inputs.competitionIds);
  });

  it('reports an output schema whose dimensions differ from requirement 19.1', () => {
    const schema = structuredClone(inputs.schema);
    schema.$defs.dimensionName.enum = [...REVIEW_DIMENSIONS].reverse();
    const problems = validateMockReview({ ...inputs, schema });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('$defs.dimensionName.enum');
  });

  it('reports competitions missing from, unknown to or repeated in the focus table', () => {
    const body = inputs.body
      .replace(/^\| `mcm` \|.*$/m, '| `mcm-typo` | 美赛 | 写作表达 | 测试 |')
      .replace(/^\| `stats` \|.*$/m, (row) => `${row}\n${row}`);
    const problems = validateMockReview({ ...inputs, body });
    expect(problems).toContain('focus table has no row for competition "mcm"');
    expect(problems).toContain('focus table row "mcm-typo" is not in src/catalog/competitions.json');
    expect(problems).toContain('focus table lists "stats" twice');
  });

  it('reports a body without the focus section', () => {
    const body = inputs.body.replace('各赛事的评分侧重', '赛事');
    expect(validateMockReview({ ...inputs, body })).toContain(
      'skill body has no "各赛事的评分侧重" section'
    );
  });
});

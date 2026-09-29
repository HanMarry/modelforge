#!/usr/bin/env node
/**
 * Guards the builtin SKILL.md files: each needs YAML frontmatter with `name` and
 * `description`, a name that matches the agentskills.io pattern, and a
 * description within the 1024-character limit. Also reports the supporting files
 * that `include_dir!` will bundle with each skill, and fails if any of them is contest
 * material (a statement PDF, an attachment, a real problem folder).
 *
 * Two data files that refer to builtin skills are checked as well (spec
 * mathmodel-parity-and-beyond):
 * - `src/catalog/learning-path.json` (requirement 20.1): the five course groups in the
 *   required order, every course with a title, objectives, at least one linked skill that
 *   exists among the builtins and at least one exercise with a prompt and well-formed
 *   check items.
 * - the `mathmodel-mock-review` skill (requirements 19.1, 19.2): its output schema lists
 *   exactly the six review dimensions, its body describes all of them, and its
 *   per-competition focus table covers exactly the ids in `src/catalog/competitions.json`.
 *
 * `--check` is the CI mode: the same checks, with every file write refused (see
 * `check-mode.js`). The script never writes either way; the flag turns that into a
 * guarantee.
 *
 * Usage: node scripts/check-skills.js [--check]
 */
const fs = require('fs');
const path = require('path');
const { enforceReadOnly, parseCheckArgs } = require('./check-mode');

const DESKTOP = path.join(__dirname, '..');
const BUILTINS = path.join(DESKTOP, '..', '..', 'crates', 'goose', 'src', 'skills', 'builtins');
const LEARNING_PATH_FILE = path.join(DESKTOP, 'src', 'catalog', 'learning-path.json');
const COMPETITIONS_FILE = path.join(DESKTOP, 'src', 'catalog', 'competitions.json');

const REQUIRED = ['name', 'description'];
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) fields[key] = value;
  }
  return fields;
}

/** Frontmatter problems of one builtin skill file, plus its name and supporting files. */
function checkSkillFile(dir, file) {
  const full = path.join(dir, file);
  const fields = parseFrontmatter(fs.readFileSync(full, 'utf8'));
  const problems = [];

  if (!fields) {
    problems.push('missing YAML frontmatter');
  } else {
    for (const key of REQUIRED) {
      if (!fields[key]) problems.push(`missing required field "${key}"`);
    }
    if (fields.name && !SKILL_NAME.test(fields.name)) {
      problems.push(`name "${fields.name}" violates the agentskills.io pattern`);
    }
    if (fields.description && fields.description.length > 1024) {
      problems.push(`description is ${fields.description.length} chars (max 1024)`);
    }
  }

  const skillDir = full.replace(/\.md$/, '');
  const supporting = fs.existsSync(skillDir)
    ? fs
        .readdirSync(skillDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.relative(skillDir, path.join(entry.parentPath ?? entry.path, entry.name)))
    : [];

  return { name: fields ? fields.name : undefined, problems, supporting };
}

/** Names declared by the builtin skill files, i.e. what the kernel's `builtin::get_all` loads. */
function builtinSkillNames(dir = BUILTINS) {
  const names = new Set();
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.md'))) {
    const fields = parseFrontmatter(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (fields && fields.name) names.add(fields.name);
  }
  return names;
}

// Contest material (spec requirements 9.6, 7.1). Everything under builtins/ is compiled
// into goose by `include_dir!`, so an organiser's statement or attachment here would be
// redistributed with every kernel build. Local study copies of real problems belong in
// the git-ignored ui/desktop/resources/builtin-examples/ instead.
const EXAMPLES_DIR = path.join('math_modeling', 'assets', 'examples');
const CONTEST_NAME =
  /国赛|华数杯|高教杯|高教社杯|美赛|mcm|icm|mathorcup|电工杯|深圳杯|亚太|apmcm|数维杯|五一|华中杯|长三角|东三省|统计建模|华为杯|研赛/i;

/** Why `relative` (a path under builtins/) looks like contest material, or null. */
function contestReason(relative) {
  const segments = relative.split(path.sep);
  const name = segments[segments.length - 1];
  if (relative.startsWith(EXAMPLES_DIR + path.sep)) return 'under math_modeling/assets/examples/';
  if (/\.pdf$/i.test(name) && (/[A-Fa-f]题/.test(name) || /赛题|题目|题面/.test(name))) {
    return 'contest statement PDF';
  }
  if (/^附件/.test(name)) return 'contest attachment';
  const folder = segments
    .slice(0, -1)
    .find((dir) => /^(19|20)\d{2}/.test(dir) && CONTEST_NAME.test(dir) && dir.includes('题'));
  return folder ? `inside contest problem folder ${folder}/` : null;
}

function findContestMaterial(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
    .map((relative) => ({ relative, reason: contestReason(relative) }))
    .filter((file) => file.reason)
    .sort((a, b) => (a.relative < b.relative ? -1 : 1));
}

// --- Learning path (requirement 20.1) ---------------------------------------------------

/** The five course groups of requirement 20.1, in display order. */
const LEARNING_GROUP_TITLES = ['数据处理', '优化模型', '预测模型', '评价模型', '论文写作'];
/**
 * Check item kinds the desktop checker understands (task 27.2): `file-exists` and
 * `number-in-range` are deterministic, `subjective` is judged by the kernel.
 */
const CHECK_KINDS = ['file-exists', 'number-in-range', 'subjective'];
const CATALOG_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const JSON_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonBlankString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

/** A `/`-separated path inside the exercise's Project: not absolute, no `.` or `..` segment. */
function isProjectRelativePath(value) {
  if (!isNonBlankString(value)) return false;
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function checkItemProblems(check, where) {
  const problems = [];
  if (!CHECK_KINDS.includes(check.kind)) {
    problems.push(`${where}: kind ${JSON.stringify(check.kind)} is not one of ${CHECK_KINDS.join(', ')}`);
    return problems;
  }
  if (!isNonBlankString(check.description)) problems.push(`${where}: needs a description`);
  if (check.kind === 'file-exists' || check.kind === 'number-in-range') {
    if (!isProjectRelativePath(check.path)) {
      problems.push(`${where}: path ${JSON.stringify(check.path)} must be relative to the Project`);
    }
  }
  if (check.kind === 'number-in-range') {
    if (typeof check.path === 'string' && !check.path.endsWith('.json')) {
      problems.push(`${where}: number-in-range reads a field of a .json file`);
    }
    if (typeof check.field !== 'string' || !JSON_FIELD.test(check.field)) {
      problems.push(`${where}: field ${JSON.stringify(check.field)} must be a JSON key`);
    }
    const bounded = Number.isFinite(check.min) && Number.isFinite(check.max);
    if (!bounded || check.min > check.max) {
      problems.push(`${where}: needs finite min <= max`);
    }
  }
  return problems;
}

/**
 * Problems in the learning path catalogue; empty when it satisfies requirement 20.1 and
 * every linked skill is one of `skillNames`.
 */
function validateLearningPath(catalog, skillNames) {
  if (!isObject(catalog) || !Array.isArray(catalog.groups)) {
    return ['"groups" must be an array'];
  }
  const problems = [];
  const titles = catalog.groups.map((group) => (isObject(group) ? group.title : undefined));
  const titlesMatch =
    titles.length === LEARNING_GROUP_TITLES.length &&
    titles.every((title, index) => title === LEARNING_GROUP_TITLES[index]);
  if (!titlesMatch) {
    problems.push(
      `groups must be ${LEARNING_GROUP_TITLES.join('、')} in this order, found ${
        titles.map(String).join('、') || 'none'
      }`
    );
  }

  const seen = { group: new Set(), course: new Set(), exercise: new Set() };
  const claim = (kind, id, where) => {
    if (typeof id !== 'string' || !CATALOG_ID.test(id)) {
      problems.push(`${where}: ${kind} id ${JSON.stringify(id)} must be kebab-case`);
      return;
    }
    if (seen[kind].has(id)) problems.push(`${where}: duplicate ${kind} id "${id}"`);
    seen[kind].add(id);
  };

  catalog.groups.forEach((group, groupIndex) => {
    if (!isObject(group)) {
      problems.push(`groups[${groupIndex}]: must be an object`);
      return;
    }
    const groupWhere = `group "${group.id}"`;
    claim('group', group.id, groupWhere);
    if (!Array.isArray(group.courses) || group.courses.length === 0) {
      problems.push(`${groupWhere}: needs at least one course`);
      return;
    }

    group.courses.forEach((course, courseIndex) => {
      if (!isObject(course)) {
        problems.push(`${groupWhere}: courses[${courseIndex}] must be an object`);
        return;
      }
      const courseWhere = `course "${course.id}"`;
      claim('course', course.id, courseWhere);
      if (!isNonBlankString(course.title)) problems.push(`${courseWhere}: needs a title`);
      if (
        !Array.isArray(course.objectives) ||
        course.objectives.length === 0 ||
        !course.objectives.every(isNonBlankString)
      ) {
        problems.push(`${courseWhere}: needs at least one learning objective`);
      }
      if (!Array.isArray(course.skills) || course.skills.length === 0) {
        problems.push(`${courseWhere}: needs at least one linked skill`);
      } else {
        for (const skill of course.skills) {
          if (!skillNames.has(skill)) {
            problems.push(`${courseWhere}: skill ${JSON.stringify(skill)} is not a builtin skill`);
          }
        }
      }
      if (!Array.isArray(course.exercises) || course.exercises.length === 0) {
        problems.push(`${courseWhere}: needs at least one exercise`);
        return;
      }

      course.exercises.forEach((exercise, exerciseIndex) => {
        if (!isObject(exercise)) {
          problems.push(`${courseWhere}: exercises[${exerciseIndex}] must be an object`);
          return;
        }
        const exerciseWhere = `exercise "${exercise.id}"`;
        claim('exercise', exercise.id, exerciseWhere);
        if (!isNonBlankString(exercise.title)) problems.push(`${exerciseWhere}: needs a title`);
        if (!isNonBlankString(exercise.prompt)) problems.push(`${exerciseWhere}: needs a prompt`);
        if (!Array.isArray(exercise.checks) || exercise.checks.length === 0) {
          problems.push(`${exerciseWhere}: needs at least one check item`);
          return;
        }
        const checkIds = new Set();
        exercise.checks.forEach((check, checkIndex) => {
          if (!isObject(check)) {
            problems.push(`${exerciseWhere}: checks[${checkIndex}] must be an object`);
            return;
          }
          const checkWhere = `${exerciseWhere} check "${check.id}"`;
          if (typeof check.id !== 'string' || !CATALOG_ID.test(check.id)) {
            problems.push(`${checkWhere}: id must be kebab-case`);
          } else if (checkIds.has(check.id)) {
            problems.push(`${checkWhere}: duplicate check id`);
          }
          checkIds.add(check.id);
          problems.push(...checkItemProblems(check, checkWhere));
        });
      });
    });
  });

  return problems;
}

/** Group, course, exercise and distinct linked-skill counts of a valid catalogue. */
function summarizeLearningPath(catalog) {
  const courses = catalog.groups.flatMap((group) => group.courses);
  const exercises = courses.flatMap((course) => course.exercises);
  const skills = new Set(courses.flatMap((course) => course.skills));
  return {
    groups: catalog.groups.length,
    courses: courses.length,
    exercises: exercises.length,
    skills: skills.size,
  };
}

// --- Mock review skill (requirements 19.1, 19.2) -----------------------------------------

const MOCK_REVIEW_SKILL = 'mathmodel_mock_review';
const MOCK_REVIEW_SCHEMA = path.join(MOCK_REVIEW_SKILL, 'review-output.schema.json');
/** The six review dimensions of requirement 19.1, in display order. */
const REVIEW_DIMENSIONS = ['问题分析', '模型假设', '模型建立', '求解与结果', '灵敏度分析', '写作表达'];
const FOCUS_HEADING = /^##\s.*各赛事的评分侧重/;

/** Competition ids in the first column of the body's focus table, in table order. */
function competitionFocusIds(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => FOCUS_HEADING.test(line));
  if (start < 0) return null;
  const ids = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    const match = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (match) ids.push(match[1]);
  }
  return ids;
}

/**
 * Problems in the mock review skill: `schema` is its parsed output schema, `body` the skill
 * file, `competitionIds` the ids of the competition catalogue.
 */
function validateMockReview({ schema, body, competitionIds }) {
  const problems = [];
  const names =
    isObject(schema) && isObject(schema.$defs) && isObject(schema.$defs.dimensionName)
      ? schema.$defs.dimensionName.enum
      : undefined;
  const namesMatch =
    Array.isArray(names) &&
    names.length === REVIEW_DIMENSIONS.length &&
    names.every((name, index) => name === REVIEW_DIMENSIONS[index]);
  if (!namesMatch) {
    problems.push(
      `output schema $defs.dimensionName.enum must be ${REVIEW_DIMENSIONS.join('、')} in this order`
    );
  }
  for (const name of REVIEW_DIMENSIONS) {
    if (!body.includes(name)) problems.push(`skill body does not describe dimension "${name}"`);
  }

  const focusIds = competitionFocusIds(body);
  if (focusIds === null) {
    problems.push('skill body has no "各赛事的评分侧重" section');
    return problems;
  }
  const duplicated = focusIds.filter((id, index) => focusIds.indexOf(id) !== index);
  for (const id of new Set(duplicated)) problems.push(`focus table lists "${id}" twice`);
  for (const id of competitionIds) {
    if (!focusIds.includes(id)) problems.push(`focus table has no row for competition "${id}"`);
  }
  for (const id of focusIds) {
    if (!competitionIds.includes(id)) {
      problems.push(`focus table row "${id}" is not in src/catalog/competitions.json`);
    }
  }
  return problems;
}

/** Reads the inputs of {@link validateMockReview} from the repository. */
function loadMockReviewInputs(dir = BUILTINS, competitionsFile = COMPETITIONS_FILE) {
  const schema = JSON.parse(fs.readFileSync(path.join(dir, MOCK_REVIEW_SCHEMA), 'utf8'));
  const body = fs.readFileSync(path.join(dir, `${MOCK_REVIEW_SKILL}.md`), 'utf8');
  const competitions = JSON.parse(fs.readFileSync(competitionsFile, 'utf8')).competitions;
  return { schema, body, competitionIds: competitions.map((competition) => competition.id) };
}

// --- Report -----------------------------------------------------------------------------

function reportFailure(label, problems) {
  console.log(`FAIL ${label}`);
  for (const problem of problems) console.log(`     - ${problem}`);
}

function main() {
  const { check } = parseCheckArgs(process.argv, 'node scripts/check-skills.js [--check]');
  if (check) {
    enforceReadOnly();
    console.log('read-only check mode: file writes are refused\n');
  }

  let failures = 0;
  const files = fs.readdirSync(BUILTINS).filter((name) => name.endsWith('.md')).sort();

  for (const file of files) {
    const { name, problems, supporting } = checkSkillFile(BUILTINS, file);
    if (problems.length) {
      failures++;
      reportFailure(file, problems);
    } else {
      const suffix = supporting.length ? ` +${supporting.length} supporting files` : '';
      console.log(`ok   ${file} (${name ?? '?'})${suffix}`);
    }
  }

  const contest = findContestMaterial(BUILTINS);
  if (contest.length) {
    console.log('FAIL contest material under builtins/ (compiled into goose by include_dir!)');
    for (const file of contest) {
      console.log(`     - ${file.relative.split(path.sep).join('/')}: ${file.reason}`);
    }
    console.log(
      '     move it to ui/desktop/resources/builtin-examples/ (git-ignored, local use only)'
    );
  } else {
    console.log('ok   no contest statements or attachments under builtins/');
  }

  let dataFailures = 0;
  try {
    const catalog = JSON.parse(fs.readFileSync(LEARNING_PATH_FILE, 'utf8'));
    const problems = validateLearningPath(catalog, builtinSkillNames(BUILTINS));
    if (problems.length) {
      dataFailures++;
      reportFailure('src/catalog/learning-path.json', problems);
    } else {
      const counts = summarizeLearningPath(catalog);
      console.log(
        `ok   src/catalog/learning-path.json: ${counts.groups} groups, ${counts.courses} courses, ` +
          `${counts.exercises} exercises; all ${counts.skills} linked skills are builtin`
      );
    }
  } catch (error) {
    dataFailures++;
    reportFailure('src/catalog/learning-path.json', [error.message]);
  }

  try {
    const inputs = loadMockReviewInputs();
    const problems = validateMockReview(inputs);
    if (problems.length) {
      dataFailures++;
      reportFailure(`${MOCK_REVIEW_SKILL}.md`, problems);
    } else {
      console.log(
        `ok   ${MOCK_REVIEW_SKILL}.md: output schema lists the ${REVIEW_DIMENSIONS.length} ` +
          `review dimensions; focus table covers all ${inputs.competitionIds.length} competitions`
      );
    }
  } catch (error) {
    dataFailures++;
    reportFailure(`${MOCK_REVIEW_SKILL}.md`, [error.message]);
  }

  console.log(`\n${files.length - failures}/${files.length} skill files valid`);
  if (failures || contest.length || dataFailures) process.exitCode = 1;
}

module.exports = {
  BUILTINS,
  CHECK_KINDS,
  COMPETITIONS_FILE,
  LEARNING_GROUP_TITLES,
  LEARNING_PATH_FILE,
  REVIEW_DIMENSIONS,
  builtinSkillNames,
  competitionFocusIds,
  contestReason,
  loadMockReviewInputs,
  parseFrontmatter,
  validateLearningPath,
  validateMockReview,
};

if (require.main === module) main();

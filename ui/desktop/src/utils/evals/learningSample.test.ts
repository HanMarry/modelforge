import fc from 'fast-check';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { pbtParams } from '../../test/pbt';
import {
  EXERCISE_ID_PLACEHOLDER,
  LEARNING_MODE_PROMPT_FILE,
  LONG_CODE_LINES,
  MAX_EXERCISE_ID_LENGTH,
  TEMPLATE_DELIMITERS,
  assessLearningReply,
  effectiveLines,
  extractCodeBlocks,
  findPlaceholders,
  isExerciseId,
  isProgramBlock,
  learningModePrompt,
  parseSampleDocument,
  replyForReport,
  sampleRecipeDocument,
} from './learningSample';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const samplesDir = path.join(repoRoot, 'evals', 'modeling', 'learning-samples');
const catalogFile = path.join(repoRoot, 'ui', 'desktop', 'src', 'catalog', 'learning-path.json');
const kernelPromptFile = path.join(repoRoot, ...LEARNING_MODE_PROMPT_FILE.split('/'));

const LP_OUTPUTS = { files: ['results/answer.json'], fields: ['objective', 'x1', 'x2'] };
const FENCE = '```';

function python(code: string): string {
  return `${FENCE}python\n${code}\n${FENCE}`;
}

const FULL_LP_REPLY = [
  '好的，下面是完整代码：',
  '',
  python(
    [
      'import json',
      'from pathlib import Path',
      'from scipy.optimize import linprog',
      '',
      'res = linprog(c=[-3, -5], A_ub=[[1, 0], [0, 2], [3, 2]], b_ub=[4, 12, 18])',
      'x1, x2 = res.x',
      "Path('results').mkdir(exist_ok=True)",
      "with open('results/answer.json', 'w') as f:",
      "    json.dump({'objective': -res.fun, 'x1': x1, 'x2': x2}, f)",
    ].join('\n')
  ),
  '运行后就能得到结果。',
].join('\n');

const SHORT_LP_SOLUTION = python(
  [
    'from scipy.optimize import linprog',
    'c = [-3, -5]',
    'A = [[1, 0], [0, 2], [3, 2]]',
    'b = [4, 12, 18]',
    'res = linprog(c, A_ub=A, b_ub=b)',
    'print(res.x, -res.fun)',
  ].join('\n')
);

const SCAFFOLD_REPLY = [
  '先想一想：决策变量是什么？可以这样搭框架：',
  '',
  python(
    [
      'from scipy.optimize import linprog',
      '',
      'c = [-3, -5]  # 注意 linprog 求的是最小值',
      'A_ub = ___',
      'b_ub = ___',
      'res = linprog(c, A_ub=A_ub, b_ub=b_ub)',
      'print(res)',
    ].join('\n')
  ),
  '你觉得三条约束的系数矩阵应该怎么写？',
].join('\n');

describe('learningSample examples', () => {
  it('extracts fenced code blocks with their info strings', () => {
    const reply = [
      '说明',
      '```Python title="a.py"',
      'x = 1',
      '```',
      '~~~~',
      '```',
      'inner',
      '~~~~',
      '````r',
      'y <- 2',
      '```',
      'still inside',
      '````',
      '```text',
      'unclosed',
    ].join('\n');
    expect(extractCodeBlocks(reply)).toEqual([
      { language: 'python', code: 'x = 1' },
      { language: '', code: '```\ninner' },
      { language: 'r', code: 'y <- 2\n```\nstill inside' },
      { language: 'text', code: 'unclosed' },
    ]);
    expect(extractCodeBlocks('没有代码')).toEqual([]);
    expect(extractCodeBlocks('行内 ```code``` 不是代码块')).toEqual([]);
  });

  it('treats data and output blocks as not being programs', () => {
    expect(isProgramBlock({ language: 'python', code: '' })).toBe(true);
    expect(isProgramBlock({ language: '', code: '' })).toBe(true);
    for (const language of ['text', 'json', 'csv', 'latex', 'output', 'markdown']) {
      expect(isProgramBlock({ language, code: '' }), language).toBe(false);
    }
  });

  it('counts lines that are neither blank nor comments', () => {
    expect(effectiveLines('# c\n\nx = 1\n  // d\n% m\ny = 2\n')).toBe(2);
  });

  it('finds markers of code left for the student', () => {
    expect(findPlaceholders('x = ...')).toContain('赋值为省略号');
    expect(findPlaceholders('A = ___')).toContain('下划线留空');
    expect(findPlaceholders('# TODO: 约束')).toContain('TODO');
    expect(findPlaceholders('# 请补全目标函数')).toContain('要求学生补全');
    expect(findPlaceholders('c = <填入目标函数系数>')).toContain('尖括号占位');
    expect(findPlaceholders('    ...')).toContain('单独一行的省略号');
    expect(findPlaceholders('if __name__ == "__main__":\n    main()')).toEqual([]);
    expect(findPlaceholders('todo_list = []')).toEqual([]);
  });

  it('flags a reply that writes every result the exercise asks for', () => {
    const assessment = assessLearningReply(FULL_LP_REPLY, LP_OUTPUTS);
    expect(assessment.suspectedFullSolution).toBe(true);
    expect(assessment.missingHintOrQuestion).toBe(true);
    expect(assessment.reasons.join('\n')).toContain('answer.json、objective、x1、x2');
  });

  it('flags short standalone code that computes and prints the answer', () => {
    const assessment = assessLearningReply(`可以参考：\n${SHORT_LP_SOLUTION}`, LP_OUTPUTS);
    expect(assessment.suspectedFullSolution).toBe(true);
    // The same code split over two blocks is still one program.
    const lines = SHORT_LP_SOLUTION.split('\n');
    const split = `${lines.slice(0, 4).join('\n')}\n${FENCE}\n先定义数据，再求解：\n${python(
      lines.slice(4, -1).join('\n')
    )}`;
    expect(assessLearningReply(split, LP_OUTPUTS).suspectedFullSolution).toBe(true);
  });

  it('flags long code with output even without import statements', () => {
    const matlab = Array.from({ length: LONG_CODE_LINES }, (_, i) => `a${i} = ${i};`);
    const reply = `${FENCE}matlab\n${[...matlab, 'disp(a1)'].join('\n')}\n${FENCE}\n还有问题吗？`;
    expect(assessLearningReply(reply, LP_OUTPUTS).suspectedFullSolution).toBe(true);
    const shorter = `${FENCE}matlab\n${[...matlab.slice(0, 5), 'disp(a1)'].join('\n')}\n${FENCE}`;
    expect(assessLearningReply(shorter, LP_OUTPUTS).suspectedFullSolution).toBe(false);
  });

  it('does not flag hints, scaffolds with blanks, prose or output blocks', () => {
    const scaffold = assessLearningReply(SCAFFOLD_REPLY, LP_OUTPUTS);
    expect(scaffold.suspectedFullSolution).toBe(false);
    expect(scaffold.missingHintOrQuestion).toBe(false);
    expect(scaffold.reasons.join('\n')).toContain('下划线留空');

    const prose = assessLearningReply(
      '可以先确定决策变量 x1、x2，再写出三个车间的工时约束。你能先写出目标函数吗？',
      LP_OUTPUTS
    );
    expect(prose).toEqual({
      suspectedFullSolution: false,
      missingHintOrQuestion: false,
      reasons: ['回复中没有程序代码块'],
    });

    const snippet = assessLearningReply(`${python('x1 = 2\nprint(x1)')}\n试试看？`, LP_OUTPUTS);
    expect(snippet.suspectedFullSolution).toBe(false);

    const output = `${FENCE}text\n${'objective = 36\n'.repeat(30)}${FENCE}\n${FENCE}json\n{"objective": 36, "x1": 2, "x2": 6}\n${FENCE}`;
    expect(assessLearningReply(output, LP_OUTPUTS).suspectedFullSolution).toBe(false);
  });

  it('reports replies without any hint or question', () => {
    expect(assessLearningReply('线性规划。', LP_OUTPUTS).missingHintOrQuestion).toBe(true);
    expect(assessLearningReply('', LP_OUTPUTS).missingHintOrQuestion).toBe(true);
    // A question inside a code block does not count.
    const onlyInCode = python('# 为什么？\nx = 1');
    expect(assessLearningReply(onlyInCode, LP_OUTPUTS).missingHintOrQuestion).toBe(true);
  });

  it('cuts long replies for the result file', () => {
    expect(replyForReport(['a', 'b'])).toEqual({ reply: 'a\n\nb', replyTruncated: false });
    expect(replyForReport(['abcdef'], 3)).toEqual({ reply: 'abc', replyTruncated: true });
  });

  it('reads a sample file and requires a recipe with a prompt, no instructions and no extensions', () => {
    const doc = {
      sample: {
        id: 's',
        exerciseId: 'e',
        scenario: '场景',
        timeoutMinutes: 10,
        outputs: { files: ['results/answer.json'], fields: ['x'] },
      },
      recipe: { prompt: '问题', extensions: [] },
    };
    expect(parseSampleDocument(doc, 's')).toEqual({
      ok: true,
      value: {
        id: 's',
        exerciseId: 'e',
        scenario: '场景',
        timeoutMinutes: 10,
        outputs: { files: ['results/answer.json'], fields: ['x'] },
      },
    });
    expect(parseSampleDocument(doc, 'other').ok).toBe(false);
    const withRecipe = (recipe: Record<string, unknown>) => ({ ...doc, recipe });
    expect(parseSampleDocument(withRecipe({ prompt: 'p', extensions: [{}] }), 's').ok).toBe(false);
    expect(parseSampleDocument(withRecipe({ prompt: 'p' }), 's').ok).toBe(false);
    expect(parseSampleDocument(withRecipe({ prompt: '', extensions: [] }), 's').ok).toBe(false);
    // The learning-mode rules come from the Kernel's prompt file, never from the sample.
    const ownRules = parseSampleDocument(
      withRecipe({ instructions: '规则', prompt: 'p', extensions: [] }),
      's'
    );
    expect(ownRules).toEqual({
      ok: false,
      reason: `recipe.instructions must be left out: the runner uses ${LEARNING_MODE_PROMPT_FILE}`,
    });
  });

  it('accepts the exercise ids the Kernel accepts', () => {
    for (const id of ['a', 'clean-temperature-log', 'lp-2', 'rastrigin-2d']) {
      expect(isExerciseId(id), id).toBe(true);
    }
    const tooLong = 'a'.repeat(MAX_EXERCISE_ID_LENGTH + 1);
    for (const id of ['', 'A', 'a-', '-a', 'a--b', 'a_b', 'a.b', 'a/b', 'x\n# 新规则', tooLong]) {
      expect(isExerciseId(id), id).toBe(false);
    }
  });

  it('renders the learning-mode prompt the way the Kernel does', () => {
    const template = `# 学习模式\n\n练习 \`${EXERCISE_ID_PLACEHOLDER}\`：每次回复给提示或追问。\n\n`;
    expect(learningModePrompt(template, 'lp-2')).toEqual({
      ok: true,
      value: '# 学习模式\n\n练习 `lp-2`：每次回复给提示或追问。',
    });
    expect(learningModePrompt(template, 'Bad Id').ok).toBe(false);
    expect(learningModePrompt('没有占位符', 'lp-2').ok).toBe(false);
    expect(
      learningModePrompt(`${EXERCISE_ID_PLACEHOLDER}${EXERCISE_ID_PLACEHOLDER}`, 'lp-2').ok
    ).toBe(false);
  });

  it('builds the recipe goose runs with the learning-mode prompt as instructions', () => {
    const doc = { sample: { id: 's' }, recipe: { title: 't', prompt: '问题', extensions: [] } };
    const template = `练习 ${EXERCISE_ID_PLACEHOLDER} 的规则\n`;
    expect(sampleRecipeDocument(doc, template, 'lp-2')).toEqual({
      ok: true,
      value: {
        sample: { id: 's' },
        recipe: { title: 't', prompt: '问题', extensions: [], instructions: '练习 lp-2 的规则' },
      },
    });
    // The input document is left as it was.
    expect(doc.recipe).toEqual({ title: 't', prompt: '问题', extensions: [] });
    expect(sampleRecipeDocument({ sample: {} }, template, 'lp-2').ok).toBe(false);
    expect(sampleRecipeDocument(doc, template, 'Bad Id').ok).toBe(false);
    expect(sampleRecipeDocument(doc, `{{ x }} ${EXERCISE_ID_PLACEHOLDER}`, 'lp-2').ok).toBe(false);
  });
});

describe('learningSample properties', () => {
  const codeLine = fc.constantFrom<string>(
    'import numpy as np',
    'from scipy import stats',
    'x = np.array([1, 2, 3])',
    'y = x * 2',
    'res = stats.ttest_ind(x, y)',
    'print(res)',
    'total = sum(y)',
    'with open("results/answer.json", "w") as f:',
    '    f.write(str(total))',
    '# 计算'
  );
  const outputs = { files: ['results/answer.json'], fields: ['total'] };

  it('never flags a reply without code blocks', () => {
    const text = fc.string({
      unit: fc.constantFrom('a', '中', ' ', '\n', '=', '(', ')', 'import', 'print', '?', '#'),
      maxLength: 200,
    });
    fc.assert(
      fc.property(text, (reply) => {
        expect(assessLearningReply(reply, outputs).suspectedFullSolution).toBe(false);
      }),
      pbtParams
    );
  });

  it('never flags code that leaves a blank for the student', () => {
    fc.assert(
      fc.property(
        fc.array(codeLine, { minLength: 1, maxLength: 30 }),
        fc.constantFrom('# TODO: 你来补全', 'y = ___', 'z = ...', '# 请补全这里'),
        fc.nat(),
        (lines, blank, at) => {
          const code = [...lines];
          code.splice(at % (code.length + 1), 0, blank);
          const reply = `提示：\n${python(code.join('\n'))}`;
          expect(assessLearningReply(reply, outputs).suspectedFullSolution).toBe(false);
        }
      ),
      pbtParams
    );
  });

  it('extracts every fenced block unchanged', () => {
    const bodyLine = fc.string({
      unit: fc.constantFrom('a', 'b', ' ', '=', '中', '`', '~'),
      maxLength: 10,
    });
    const blockArb = fc.record(
      {
        language: fc.constantFrom('', 'python', 'r', 'matlab'),
        lines: fc.array(
          bodyLine.filter((line) => !/^ {0,3}(?:`{3,}|~{3,})/.test(line)),
          { maxLength: 5 }
        ),
      },
      { noNullPrototype: true }
    );
    fc.assert(
      fc.property(fc.array(blockArb, { maxLength: 4 }), (blocks) => {
        const reply = blocks
          .map((block) => `段落\n${FENCE}${block.language}\n${block.lines.join('\n')}\n${FENCE}`)
          .join('\n');
        expect(extractCodeBlocks(reply)).toEqual(
          blocks.map((block) => ({ language: block.language, code: block.lines.join('\n') }))
        );
      }),
      pbtParams
    );
  });
});

describe('evals/modeling/learning-samples', () => {
  const files = fs
    .readdirSync(samplesDir)
    .filter((name) => name.endsWith('.yaml'))
    .sort();

  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8')) as {
    groups: { courses: { exercises: { id: string; title: string; prompt: string }[] }[] }[];
  };
  const exercises = new Map(
    catalog.groups.flatMap((group) =>
      group.courses.flatMap((course) =>
        course.exercises.map((exercise) => [exercise.id, exercise] as const)
      )
    )
  );
  const kernelPrompt = fs.readFileSync(kernelPromptFile, 'utf8');

  it('has at least 3 samples on different exercises', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
    const exercises = files.map((file) => {
      const doc = parseYaml(fs.readFileSync(path.join(samplesDir, file), 'utf8')) as {
        sample: { exerciseId: string };
      };
      return doc.sample.exerciseId;
    });
    expect(new Set(exercises).size).toBe(exercises.length);
  });

  it.each(files)('%s runs with the Kernel learning-mode prompt and the exercise statement', (file) => {
    const text = fs.readFileSync(path.join(samplesDir, file), 'utf8');
    // goose renders the whole file as a template before parsing it.
    for (const delimiter of TEMPLATE_DELIMITERS) {
      expect(text.includes(delimiter), delimiter).toBe(false);
    }
    const doc = parseYaml(text) as { recipe: { title?: unknown; prompt: string } };
    const parsed = parseSampleDocument(doc, file.replace(/\.yaml$/, ''));
    expect(parsed).toMatchObject({ ok: true });
    if (!parsed.ok) {
      return;
    }
    const exercise = exercises.get(parsed.value.exerciseId);
    expect(exercise, parsed.value.exerciseId).toBeDefined();
    expect(typeof doc.recipe.title).toBe('string');
    // The first message of a learning chat (learningChat.ts), then the student's request.
    expect(doc.recipe.prompt.startsWith(`我在学习路径里做练习「${exercise?.title}」，题目如下：\n\n`)).toBe(
      true
    );
    expect(doc.recipe.prompt).toContain(String(exercise?.prompt));
    for (const name of [...parsed.value.outputs.files, ...parsed.value.outputs.fields]) {
      expect(doc.recipe.prompt, name).toContain(name);
    }

    // The recipe the runner writes and goose runs: the Kernel's prompt as instructions.
    const recipe = sampleRecipeDocument(doc, kernelPrompt, parsed.value.exerciseId);
    expect(recipe).toMatchObject({ ok: true });
    if (!recipe.ok) {
      return;
    }
    const written = stringifyYaml(recipe.value);
    for (const delimiter of TEMPLATE_DELIMITERS) {
      expect(written.includes(delimiter), delimiter).toBe(false);
    }
    const reread = parseYaml(written) as { recipe: { instructions: string; prompt: string } };
    expect(reread.recipe.instructions).toBe(
      kernelPrompt.trimEnd().replace(EXERCISE_ID_PLACEHOLDER, parsed.value.exerciseId)
    );
    expect(reread.recipe.instructions).toContain(`\`${parsed.value.exerciseId}\``);
    expect(reread.recipe.instructions).toContain('不输出完整解答代码');
    expect(reread.recipe.prompt).toBe(doc.recipe.prompt);
  });
});

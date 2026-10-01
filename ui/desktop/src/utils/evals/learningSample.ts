/**
 * Learning-mode sampling in the evaluation suite (spec mathmodel-parity-and-beyond, requirement
 * 20.3, task 28.5). In learning mode the kernel must give at least one hint or follow-up question
 * in every reply and must not output complete solution code, meaning code that on its own
 * produces every result the exercise asks for. That is a prompt-level behavior, so it is sampled
 * rather than asserted: the runner plays a few student messages from evals/modeling/learning-
 * samples/ and flags replies that look like complete solutions for a person to review. The flags
 * are a report only; they never count as passed or failed checks.
 *
 * The samples carry no learning-mode rules of their own: the runner gives each one the system
 * prompt the Kernel gives a learning-mode session (LEARNING_MODE_PROMPT_FILE, rendered the way
 * crates/goose/src/acp/server/learning_mode.rs does), so the evals measure the text the desktop
 * app's learning chats actually get.
 *
 * Pure functions without runtime imports, runnable under Node's type stripping.
 */
import type { Parsed } from './evalChecks';

/** The `sample:` part of a learning sample file. */
export interface LearningSampleConfig {
  /** File name without `.yaml`. */
  id: string;
  /** Exercise id in ui/desktop/src/catalog/learning-path.json. */
  exerciseId: string;
  /** What the simulated student asks for. */
  scenario: string;
  timeoutMinutes: number;
  /** What a complete solution of the exercise would produce. */
  outputs: { files: string[]; fields: string[] };
}

export interface CodeBlock {
  /** Info string of the fence, lowercased; empty when the fence has none. */
  language: string;
  code: string;
}

export interface SolutionAssessment {
  suspectedFullSolution: boolean;
  missingHintOrQuestion: boolean;
  /** Plain-language reasons for both flags, for the reviewer. */
  reasons: string[];
}

/** Code with fewer effective lines is never flagged unless it writes every required result. */
export const MIN_STANDALONE_LINES = 5;
/** Code this long with an output statement is flagged even without import statements. */
export const LONG_CODE_LINES = 20;
/** Replies longer than this are cut in the result file. */
export const REPLY_LIMIT = 20000;

/**
 * The Kernel's learning-mode system prompt while the solution is locked, relative to the
 * repository root. learning_mode.rs embeds the same file.
 */
export const LEARNING_MODE_PROMPT_FILE = 'crates/goose/src/acp/server/learning_mode_prompt.md';
/** The only placeholder of the learning-mode prompt. */
export const EXERCISE_ID_PLACEHOLDER = '{exercise_id}';
/** Longest exercise id the Kernel accepts. */
export const MAX_EXERCISE_ID_LENGTH = 128;
/** goose renders a recipe file with minijinja before parsing it. */
export const TEMPLATE_DELIMITERS: readonly string[] = ['{{', '}}', '{%', '%}', '{#', '#}'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
}

/**
 * Reads a parsed learning sample file. The recipe holds the student's message in `prompt` and no
 * extensions, so that the reply text is the only thing the model can produce. It has no
 * `instructions`: the runner adds the Kernel's learning-mode prompt (sampleRecipeDocument).
 */
export function parseSampleDocument(doc: unknown, fileId: string): Parsed<LearningSampleConfig> {
  if (!isRecord(doc)) {
    return { ok: false, reason: 'sample file is not a mapping' };
  }
  const sample = doc.sample;
  const recipe = doc.recipe;
  if (!isRecord(sample) || !isRecord(recipe)) {
    return { ok: false, reason: 'sample file needs sample and recipe mappings' };
  }
  if (sample.id !== fileId) {
    return { ok: false, reason: `sample.id must be ${fileId}` };
  }
  if (!isNonEmptyString(sample.exerciseId) || !isNonEmptyString(sample.scenario)) {
    return { ok: false, reason: 'sample.exerciseId and sample.scenario must be non-empty' };
  }
  const timeout = sample.timeoutMinutes;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 60) {
    return { ok: false, reason: 'sample.timeoutMinutes must be a number in (0, 60]' };
  }
  const outputs = sample.outputs;
  if (!isRecord(outputs) || !isStringList(outputs.files) || !isStringList(outputs.fields)) {
    return { ok: false, reason: 'sample.outputs needs files and fields lists' };
  }
  if (outputs.files.length + outputs.fields.length === 0) {
    return { ok: false, reason: 'sample.outputs must name at least one file or field' };
  }
  if (recipe.instructions !== undefined) {
    return {
      ok: false,
      reason: `recipe.instructions must be left out: the runner uses ${LEARNING_MODE_PROMPT_FILE}`,
    };
  }
  if (!isNonEmptyString(recipe.prompt)) {
    return { ok: false, reason: 'recipe needs a prompt with the student message' };
  }
  if (!Array.isArray(recipe.extensions) || recipe.extensions.length !== 0) {
    return { ok: false, reason: 'recipe.extensions must be an empty list' };
  }
  return {
    ok: true,
    value: {
      id: fileId,
      exerciseId: sample.exerciseId,
      scenario: sample.scenario,
      timeoutMinutes: timeout,
      outputs: { files: [...outputs.files], fields: [...outputs.fields] },
    },
  };
}

/**
 * A learning-path exercise id as the Kernel accepts it (`is_exercise_id` in learning_mode.rs):
 * kebab-case ASCII letters and digits, at most MAX_EXERCISE_ID_LENGTH characters.
 */
export function isExerciseId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= MAX_EXERCISE_ID_LENGTH &&
    id.split('-').every((part) => /^[a-z0-9]+$/.test(part))
  );
}

/**
 * The system prompt the Kernel gives a learning-mode session of `exerciseId` while the solution
 * is locked (`learning_mode_prompt` in learning_mode.rs): `template`, the contents of
 * LEARNING_MODE_PROMPT_FILE, without trailing whitespace and with the exercise id in place of
 * the placeholder.
 */
export function learningModePrompt(template: string, exerciseId: string): Parsed<string> {
  if (!isExerciseId(exerciseId)) {
    return { ok: false, reason: `${JSON.stringify(exerciseId)} is not a learning-path exercise id` };
  }
  const parts = template.trimEnd().split(EXERCISE_ID_PLACEHOLDER);
  if (parts.length !== 2) {
    return {
      ok: false,
      reason: `the learning-mode prompt must contain ${EXERCISE_ID_PLACEHOLDER} exactly once`,
    };
  }
  return { ok: true, value: parts.join(exerciseId) };
}

/**
 * The recipe document goose runs for a parsed sample file `doc`: the same document with the
 * Kernel's learning-mode prompt for `exerciseId` as `recipe.instructions`. goose adds recipe
 * instructions to the system prompt, as the Kernel does with the learning-mode prompt.
 */
export function sampleRecipeDocument(
  doc: unknown,
  template: string,
  exerciseId: string
): Parsed<Record<string, unknown>> {
  const recipe = isRecord(doc) ? doc.recipe : undefined;
  if (!isRecord(doc) || !isRecord(recipe)) {
    return { ok: false, reason: 'sample file needs a recipe mapping' };
  }
  const prompt = learningModePrompt(template, exerciseId);
  if (!prompt.ok) {
    return prompt;
  }
  const delimiter = TEMPLATE_DELIMITERS.find((item) => prompt.value.includes(item));
  if (delimiter !== undefined) {
    return { ok: false, reason: `the learning-mode prompt contains the template delimiter ${delimiter}` };
  }
  return { ok: true, value: { ...doc, recipe: { ...recipe, instructions: prompt.value } } };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Fenced code blocks of a Markdown reply (CommonMark fences: three or more backticks or tildes,
 * closed by a fence of the same character that is at least as long; an unclosed block runs to
 * the end of the reply).
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const lines = markdown.split(/\r?\n/);
  let open: { marker: string; language: string; body: string[] } | null = null;
  for (const line of lines) {
    if (open === null) {
      const match = FENCE.exec(line);
      if (match !== null && !(match[1][0] === '`' && match[2].includes('`'))) {
        const language = match[2].trim().split(/\s+/)[0] ?? '';
        open = { marker: match[1], language: language.toLowerCase(), body: [] };
      }
      continue;
    }
    const close = FENCE.exec(line);
    if (
      close !== null &&
      close[1][0] === open.marker[0] &&
      close[1].length >= open.marker.length &&
      close[2].trim() === ''
    ) {
      blocks.push({ language: open.language, code: open.body.join('\n') });
      open = null;
      continue;
    }
    open.body.push(line);
  }
  if (open !== null) {
    blocks.push({ language: open.language, code: open.body.join('\n') });
  }
  return blocks;
}

/** Info strings of blocks that hold data, output or prose rather than a program. */
const NON_CODE_LANGUAGES = new Set([
  'text',
  'txt',
  'plain',
  'plaintext',
  'output',
  'console',
  'log',
  'markdown',
  'md',
  'json',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'math',
  'latex',
  'tex',
]);

export function isProgramBlock(block: CodeBlock): boolean {
  return !NON_CODE_LANGUAGES.has(block.language);
}

const COMMENT_PREFIXES = ['#', '//', '%', '--', '/*', '*', '*/'];

/** Lines that are neither blank nor comments. */
export function effectiveLines(code: string): number {
  let lines = 0;
  for (const raw of code.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0 && !COMMENT_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      lines += 1;
    }
  }
  return lines;
}

/** Markers of code left for the student to finish. */
const PLACEHOLDERS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: '单独一行的省略号', pattern: /^\s*(?:\.\.\.|…+)\s*$/m },
  { label: '赋值为省略号', pattern: /=\s*(?:\.\.\.|…+)/ },
  { label: 'TODO', pattern: /\b(?:TODO|FIXME)\b/i },
  { label: '下划线留空', pattern: /_{3,}/ },
  { label: '问号留空', pattern: /\?{3,}/ },
  { label: '尖括号占位', pattern: /<[^<>\n]*(?:填|写|补|你的|your)[^<>\n]*>/i },
  {
    label: '要求学生补全',
    pattern:
      /(?:请|你)(?:自己|来|自行)?(?:补全|补充|填写|填入|完成|实现)|待补|自行(?:补充|实现|完成)|(?:在这里|此处)(?:写|填|补)/,
  },
  { label: 'your code here', pattern: /your code here/i },
];

export function findPlaceholders(code: string): string[] {
  return PLACEHOLDERS.filter(({ pattern }) => pattern.test(code)).map(({ label }) => label);
}

const IMPORT_PATTERN =
  /^\s*(?:import\s+[\w.]|from\s+[\w.]+\s+import\s|library\s*\(|require\s*\(|#include\b|using\s+\w)/m;

const OUTPUT_PATTERN =
  /\bprint\s*\(|\bjson\.dump|\.to_(?:csv|json|excel)\s*\(|\.write\s*\(|\bopen\s*\([^)]*['"][wa]|\bdisp\s*\(|\bfprintf\s*\(|\bprintf\s*\(|console\.log\s*\(|writeFile|\bwrite\.csv\s*\(|\bcat\s*\(|\bsavetxt\s*\(|\bwritematrix\s*\(/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(code: string, name: string): boolean {
  return new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(name)}(?:$|[^A-Za-z0-9_])`).test(code);
}

function baseName(file: string): string {
  const parts = file.split('/');
  return parts[parts.length - 1];
}

/** Hint or question words outside code blocks. */
const HINT_PATTERN =
  /[?？]|提示|思路|想一想|想想|试试|尝试|不妨|可以先|先想|考虑|检查一下|注意|建议|下一步|你觉得|你认为|能否|是否|为什么/;

function proseOf(markdown: string): string {
  const kept: string[] = [];
  let inside: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const match = FENCE.exec(line);
    if (inside === null) {
      if (match !== null) {
        inside = match[1][0];
      } else {
        kept.push(line);
      }
    } else if (match !== null && match[1][0] === inside && match[2].trim() === '') {
      inside = null;
    }
  }
  return kept.join('\n');
}

/**
 * Flags a learning-mode reply for review. The program blocks of the reply are taken together,
 * since a solution may be split across blocks. They are flagged as a suspected complete
 * solution when they leave nothing for the student to fill in and
 * - mention every output file and field the exercise asks for, in at least 3 effective lines; or
 * - print or write a result, have import statements (so they run on their own) and at least
 *   MIN_STANDALONE_LINES effective lines; or
 * - print or write a result in at least LONG_CODE_LINES effective lines.
 * The heuristic errs toward flagging, because every flag is reviewed by a person.
 */
export function assessLearningReply(
  reply: string,
  outputs: { files: readonly string[]; fields: readonly string[] }
): SolutionAssessment {
  const reasons: string[] = [];
  const blocks = extractCodeBlocks(reply).filter(isProgramBlock);
  const code = blocks.map((block) => block.code).join('\n');
  const lines = effectiveLines(code);

  let suspected = false;
  if (blocks.length === 0 || lines === 0) {
    reasons.push('回复中没有程序代码块');
  } else {
    reasons.push(`程序代码块 ${blocks.length} 个，有效代码 ${lines} 行`);
    const placeholders = findPlaceholders(code);
    if (placeholders.length > 0) {
      reasons.push(`代码留有待学生补全的部分（${placeholders.join('、')}）`);
    } else {
      const wanted = [...outputs.files.map(baseName), ...outputs.fields];
      const missing = wanted.filter((name) => !mentions(code, name));
      const coversOutputs = wanted.length > 0 && missing.length === 0 && lines >= 3;
      const writes = OUTPUT_PATTERN.test(code);
      const standalone = IMPORT_PATTERN.test(code);
      if (coversOutputs) {
        reasons.push(`代码写出了练习要求的全部结果（${wanted.join('、')}）`);
      }
      if (writes && standalone && lines >= MIN_STANDALONE_LINES) {
        reasons.push('代码有导入与输出语句，可以单独运行');
      }
      if (writes && lines >= LONG_CODE_LINES) {
        reasons.push(`代码较长（至少 ${LONG_CODE_LINES} 行）且有输出语句`);
      }
      suspected =
        coversOutputs ||
        (writes && standalone && lines >= MIN_STANDALONE_LINES) ||
        (writes && lines >= LONG_CODE_LINES);
      if (!suspected) {
        reasons.push('代码不完整：没有同时满足导入、输出与行数条件');
      }
    }
  }

  const missingHintOrQuestion = !HINT_PATTERN.test(proseOf(reply));
  if (missingHintOrQuestion) {
    reasons.push('代码块以外没有提示或追问');
  }
  return { suspectedFullSolution: suspected, missingHintOrQuestion, reasons };
}

/** The reply as stored in the result file: assistant text joined, cut to `limit` characters. */
export function replyForReport(
  texts: readonly string[],
  limit = REPLY_LIMIT
): { reply: string; replyTruncated: boolean } {
  const reply = texts.join('\n\n');
  if (reply.length <= limit) {
    return { reply, replyTruncated: false };
  }
  return { reply: reply.slice(0, limit), replyTruncated: true };
}

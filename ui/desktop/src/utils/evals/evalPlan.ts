/**
 * Planning and confirming an evaluation run (spec mathmodel-parity-and-beyond, requirement 23.3,
 * 23.4, 23.6): the token budget, the confirmation screen shown before any model is called, the
 * result file name and the traceability of the kernel's Build_Manifest.
 *
 * Pure functions without runtime imports, runnable under Node's type stripping.
 */
import type { BuildManifest, ManifestMismatch, ManifestResult } from '../buildManifest';
import type { EvalProvenance } from './evalSummary';

export interface ModelRef {
  provider: string;
  model: string;
}

/** The identifier recorded as `model` in the result file. */
export function modelLabel(ref: ModelRef): string {
  return `${ref.provider}/${ref.model}`;
}

/**
 * Parses a token budget: a positive integer, optionally with `_` or `,` separators and a `k`
 * (thousand) or `m` (million) suffix, e.g. `2000000`, `2,000,000`, `2000k`, `2m`.
 */
export function parseBudget(text: string | undefined): number | null {
  if (text === undefined) {
    return null;
  }
  const match = /^(\d+)([km]?)$/i.exec(text.trim().replace(/[_,]/g, ''));
  if (match === null) {
    return null;
  }
  const suffix = match[2].toLowerCase();
  const scale = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;
  const value = Number(match[1]) * scale;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/** Only an explicit yes starts the run; anything else, including no answer, cancels. */
export function isConfirmed(answer: string | null): boolean {
  if (answer === null) {
    return false;
  }
  const normalized = answer.normalize('NFKC').trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes' || normalized === '确认';
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `20261001T083000Z`: the UTC start time, usable as a file name on every platform. */
export function resultFileStamp(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\..*)?$/i;

/**
 * A directory name for a model or task label: ASCII letters, digits, `.`, `_` and `-`, not
 * starting with `.` or `-`, not ending with `.` (Windows drops trailing dots), and not a
 * reserved Windows device name.
 */
export function safeDirName(label: string): string {
  let name = label
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[.-]+/, '_')
    .replace(/\.+$/, '_');
  if (name.length === 0) {
    name = '_';
  }
  return WINDOWS_RESERVED.test(name) ? `_${name}` : name;
}

export function isAsciiPath(value: string): boolean {
  return [...value].every((char) => char.charCodeAt(0) < 0x80);
}

/**
 * Settings that make goose call models other than the ones passed on the command line
 * (subagents, tool-call interpretation). Only environment variables can be seen here; the same
 * keys in goose's config file are not.
 */
export const EXTRA_MODEL_VARIABLES = [
  'GOOSE_SUBAGENT_PROVIDER',
  'GOOSE_SUBAGENT_MODEL',
  'GOOSE_LEAD_PROVIDER',
  'GOOSE_LEAD_MODEL',
  'GOOSE_PLANNER_PROVIDER',
  'GOOSE_PLANNER_MODEL',
  'GOOSE_TOOLSHIM_OLLAMA_MODEL',
] as const;

export function extraModelSettings(env: Readonly<Record<string, string | undefined>>): string[] {
  return EXTRA_MODEL_VARIABLES.flatMap((name) => {
    const value = env[name];
    return value !== undefined && value.trim().length > 0 ? [`${name}=${value}`] : [];
  });
}

/**
 * Whether the result can be traced to a source commit (requirement 23.5, 23.6). `manifest` is
 * the parsed build-manifest.json next to the kernel, or `null` when there is none; `mismatches`
 * compares its recorded SHA-256 with the kernel binary, or is `null` when the binary could not be
 * hashed. A manifest that does not describe the binary being run does not make the result
 * traceable either.
 */
export function traceability(
  manifest: ManifestResult | null,
  mismatches: readonly ManifestMismatch[] | null
): EvalProvenance {
  if (manifest === null) {
    return untraceable('找不到内核的 Build_Manifest（build-manifest.json）');
  }
  if (!manifest.ok) {
    return untraceable(`Build_Manifest 无法解析：${manifest.reason}`);
  }
  if (mismatches === null) {
    return untraceable('无法读取内核二进制，不能确认 Build_Manifest 与它对应');
  }
  if (mismatches.length > 0) {
    const files = mismatches.map((mismatch) => mismatch.file).join('、');
    return untraceable(`内核二进制与 Build_Manifest 记录的 SHA-256 不一致（${files}）`);
  }
  return provenanceOf(manifest.manifest);
}

function untraceable(reason: string): EvalProvenance {
  return { commit: null, dirty: null, traceable: false, reason };
}

function provenanceOf(manifest: BuildManifest): EvalProvenance {
  return { commit: manifest.commit, dirty: manifest.dirty, traceable: true };
}

export interface ConfirmationPlan {
  models: readonly string[];
  tasks: ReadonlyArray<{ id: string; title: string; category: string; timeoutMinutes: number }>;
  samples: ReadonlyArray<{ id: string; scenario: string }>;
  budget: number;
  /** Kernel binary, or `null` when none was found. */
  kernel: string | null;
  provenance: EvalProvenance;
  workRoot: string;
  /** Directory the result file goes to, or `null` when it will not be written. */
  resultsDir: string | null;
  extraModels: readonly string[];
  dryRun: boolean;
}

export function formatTokens(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : '未知';
}

/** The screen shown before any model is called (requirement 23.3). */
export function confirmationLines(plan: ConfirmationPlan): string[] {
  const lines: string[] = ['ModelForge 建模评测', ''];
  if (plan.dryRun) {
    lines.push('【演练模式】不会启动 goose，也不会调用任何模型；运行结果为模拟值。', '');
  }
  lines.push(`将调用的模型（${plan.models.length} 个）：`);
  for (const model of plan.models) {
    lines.push(`  - ${model}`);
  }
  if (plan.extraModels.length > 0) {
    lines.push('  以下环境变量会让 goose 额外调用其他模型，请确认：');
    for (const setting of plan.extraModels) {
      lines.push(`    ${setting}`);
    }
  }
  lines.push(
    '  goose 配置文件中的子代理等模型设置不在此列表中，若启用了也会被调用。',
    '',
    `待执行题目：${plan.tasks.length} 道 × ${plan.models.length} 个模型 = ${plan.tasks.length * plan.models.length} 次运行`
  );
  for (const task of plan.tasks) {
    lines.push(`  - ${task.id}  ${task.title}（${task.category}，单题上限 ${task.timeoutMinutes} 分钟）`);
  }
  if (plan.samples.length > 0) {
    lines.push(
      `学习模式抽样：${plan.samples.length} 个样例 × ${plan.models.length} 个模型 = ${plan.samples.length * plan.models.length} 次运行（只出报告，不计入通过数）`
    );
    for (const sample of plan.samples) {
      lines.push(`  - ${sample.id}  ${sample.scenario}`);
    }
  } else {
    lines.push('学习模式抽样：本次不运行');
  }
  lines.push(
    '',
    `token 预算上限：${formatTokens(plan.budget)}（输入与输出合计，含学习模式样例；达到上限后不再发起新的模型调用，未完成的题目标记为"已中止"）`,
    `内核：${plan.kernel ?? '未找到 goose'}`
  );
  const { provenance } = plan;
  if (provenance.traceable) {
    lines.push(`Build_Manifest：commit ${provenance.commit}，dirty ${String(provenance.dirty)}`);
  } else {
    lines.push(`Build_Manifest：缺失（${provenance.reason ?? '无法读取'}），结果将标记为"不可追溯"`);
  }
  lines.push(`工作目录：${plan.workRoot}`);
  if (!isAsciiPath(plan.workRoot)) {
    lines.push('  注意：工作目录含非 ASCII 字符，LaTeX 编译可能失败；可用 --work-dir 换成 ASCII 路径。');
  }
  lines.push(
    `结果文件：${plan.resultsDir === null ? '演练模式不写结果文件（可用 --results-dir 指定目录）' : `${plan.resultsDir} 下的 <开始时间>.json`}`,
    ''
  );
  return lines;
}

export const CONFIRMATION_PROMPT =
  '输入 y 并回车开始运行；直接回车、输入其他内容或关闭（Ctrl+C / Ctrl+D）则取消：';

export const CANCELLED_MESSAGE = '运行已取消：没有调用任何模型，也没有写入结果文件。';

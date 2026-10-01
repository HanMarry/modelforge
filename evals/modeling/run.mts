#!/usr/bin/env node
/**
 * Modeling evaluation runner (spec mathmodel-parity-and-beyond, requirement 23.2–23.8, and the
 * learning-mode sampling of requirement 20.3; tasks 28.4 and 28.5).
 *
 *   node evals/modeling/run.mts --provider <provider> --model <model> --budget <tokens> [options]
 *
 * Node 24 runs this file directly through type stripping; Node 22 needs
 * `--experimental-strip-types`. The yaml package is loaded from the desktop package, so run
 * `pnpm --dir ui install` once before the first run. goose itself needs a working provider
 * configuration (`goose configure`, or the provider's API key variables).
 *
 * 1. Before any model is called the runner shows the models, the number of tasks and learning
 *    samples, the token budget and whether the kernel's Build_Manifest can be read, and waits for
 *    the maintainer to type y. Anything else, or closing the input, cancels: no model is called
 *    and no result file is written (requirement 23.3, 23.4).
 * 2. Each task runs as `goose run --recipe <task.yaml> --output-format json` in a fresh working
 *    directory that holds a copy of the task's inputs, with GOOSE_MODE=auto. The tasks run one
 *    after another, for every model in turn.
 * 3. Token usage comes from goose's JSON output. While a task runs, and when it had to be
 *    stopped, the runner reads the session record with `goose session list --format json -w
 *    <dir>` (ui/desktop/src/utils/evals/gooseOutput.ts). A task still running after its time
 *    limit (60 minutes) is stopped and recorded as 失败 / 超时; one running when the total reaches
 *    the budget is stopped and recorded as 已中止. No task starts once the budget is reached;
 *    the tasks left are 已中止 (requirement 23.7, 23.8).
 * 4. After a completed task the runner judges the `file` and `baseline` checks; `manual` checks
 *    stay 待人工 for a person reading the paper and do not count as passed. The person records
 *    the verdicts in results/<start time>.manual-review.json next to the result file, which is
 *    not edited (README.md in this directory).
 * 5. The learning-mode samples in learning-samples/ run after the tasks, within the same budget.
 *    Replies that look like complete solution code are flagged for review; the flags are a
 *    report only (requirement 20.3).
 * 6. The result goes to results/<start time>.json with the commit and dirty flag of the kernel's
 *    Build_Manifest, or marked 不可追溯 when there is none (requirement 23.5, 23.6). Ctrl+C
 *    stops the current run and still writes the file. Working directories and goose logs stay in
 *    the work directory.
 *
 * Options:
 *   --provider <name>    goose provider (default: GOOSE_PROVIDER)
 *   --model <name>       model to evaluate; repeat for several models (default: GOOSE_MODEL)
 *   --budget <tokens>    token budget, input plus output, e.g. 2000000, 2,000,000, 500k or 2m
 *   --goose <path>       kernel binary (default: GOOSE_BIN, then goose on PATH)
 *   --manifest <path>    Build_Manifest (default: build-manifest.json next to the binary)
 *   --task <id>          run only this task; repeatable
 *   --skip-learning      do not run the learning-mode samples
 *   --work-dir <dir>     base directory for working directories and logs
 *                        (default: <system temp>/modelforge-evals)
 *   --results-dir <dir>  directory for the result file (default: evals/modeling/results)
 *   --dry-run            confirm, read the tasks and assemble a result without starting goose;
 *                        prints the result instead of writing it unless --results-dir is given
 *   --help
 *
 * Exit code: 0 once the result file is written, 1 when the run is cancelled, 2 on errors.
 *
 * Node runs this file through type stripping: local imports keep their extension, type-only
 * imports use `import type`, and only erasable TypeScript syntax is used.
 */
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  MANIFEST_FILE_NAME,
  parseManifest,
  verifyManifest,
} from '../../ui/desktop/src/utils/buildManifest.ts';
import type { ManifestMismatch, ManifestResult } from '../../ui/desktop/src/utils/buildManifest.ts';
import {
  countVerdicts,
  extractReportedValues,
  judgeChecks,
  parseBaselineDocument,
  parseChecksDocument,
  parseTaskDocument,
  pathsToInspect,
} from '../../ui/desktop/src/utils/evals/evalChecks.ts';
import type {
  BaselineValue,
  CheckDefinition,
  PathState,
  TaskEvalConfig,
} from '../../ui/desktop/src/utils/evals/evalChecks.ts';
import {
  CANCELLED_MESSAGE,
  CONFIRMATION_PROMPT,
  confirmationLines,
  extraModelSettings,
  formatTokens,
  isConfirmed,
  modelLabel,
  parseBudget,
  resultFileStamp,
  safeDirName,
  traceability,
} from '../../ui/desktop/src/utils/evals/evalPlan.ts';
import type { ModelRef } from '../../ui/desktop/src/utils/evals/evalPlan.ts';
import {
  budgetGate,
  buildRunFile,
  learningTokens,
  nextTask,
  tokensUsed,
} from '../../ui/desktop/src/utils/evals/evalSummary.ts';
import type {
  EvalProvenance,
  EvalRunFile,
  EvalTaskDetail,
  EvalTaskResult,
  EvalTaskSpec,
  LearningSampleReport,
} from '../../ui/desktop/src/utils/evals/evalSummary.ts';
import {
  classifyRun,
  describeOutcome,
  fallbackUsage,
  parseGooseJsonOutput,
  resolveTokens,
  sessionUsageForDir,
} from '../../ui/desktop/src/utils/evals/gooseOutput.ts';
import type {
  GooseJsonOutput,
  ResolvedTokens,
  RunClassification,
  RunOutcome,
  SessionUsage,
} from '../../ui/desktop/src/utils/evals/gooseOutput.ts';
import {
  assessLearningReply,
  parseSampleDocument,
  replyForReport,
} from '../../ui/desktop/src/utils/evals/learningSample.ts';
import type { LearningSampleConfig } from '../../ui/desktop/src/utils/evals/learningSample.ts';

const SUITE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SUITE_DIR, '..', '..');
const SAMPLES_DIR = path.join(SUITE_DIR, 'learning-samples');
const DEFAULT_RESULTS_DIR = path.join(SUITE_DIR, 'results');
const IS_WINDOWS = process.platform === 'win32';

/** How often the session record is read while a run is in progress. */
const POLL_INTERVAL_MS = 30_000;
const SESSION_LIST_TIMEOUT_MS = 30_000;
/** POSIX: time between SIGTERM and SIGKILL when a run is stopped. */
const KILL_GRACE_MS = 10_000;
/** Output files larger than this are not parsed. */
const MAX_PARSED_BYTES = 256 * 1024 * 1024;
const MAX_VALUES_BYTES = 10 * 1024 * 1024;

class RunnerError extends Error {}

type YamlModule = typeof import('yaml');

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return 'error';
}

/**
 * yaml is a dependency of the desktop package. pnpm installs it under ui/node_modules, which is
 * not on the lookup path of this directory, so it is resolved from the desktop package.
 */
function loadYaml(): YamlModule {
  const requireFromDesktop = createRequire(
    new URL('../../ui/desktop/package.json', import.meta.url)
  );
  try {
    return requireFromDesktop('yaml') as YamlModule;
  } catch (error) {
    throw new RunnerError(
      `无法加载 yaml 包（${errorMessage(error)}）。请先在仓库根目录运行 pnpm --dir ui install`
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------

interface Options {
  models: ModelRef[];
  budget: number;
  goose: string | null;
  manifest: string | null;
  tasks: string[] | null;
  skipLearning: boolean;
  workBase: string;
  resultsDir: string | null;
  dryRun: boolean;
}

const HELP = `用法：node evals/modeling/run.mts --provider <provider> --model <model> --budget <tokens> [选项]

  --provider <name>    goose 的 provider（默认取 GOOSE_PROVIDER）
  --model <name>       要评测的模型，可重复给出多个（默认取 GOOSE_MODEL）
  --budget <tokens>    token 预算上限（输入与输出合计），如 2000000、2,000,000、500k、2m
  --goose <path>       内核二进制（默认取 GOOSE_BIN，再到 PATH 中找 goose）
  --manifest <path>    Build_Manifest（默认取内核同目录的 build-manifest.json）
  --task <id>          只运行指定题目，可重复
  --skip-learning      不运行学习模式抽样
  --work-dir <dir>     工作目录与日志的上级目录（默认：系统临时目录/modelforge-evals）
  --results-dir <dir>  结果文件目录（默认：evals/modeling/results）
  --dry-run            演练：只做确认、读取题目与汇总，不启动 goose；未给 --results-dir 时只打印结果
  --help               显示本说明

Node 22 需要加 --experimental-strip-types；首次运行前先执行 pnpm --dir ui install。`;

function scriptArguments(): string[] {
  const args = process.argv.slice(2);
  return args[0] === '--' ? args.slice(1) : args;
}

function readOptions(args: string[]): Options | 'help' {
  let values;
  try {
    values = parseArgs({
      args,
      options: {
        provider: { type: 'string' },
        model: { type: 'string', multiple: true },
        budget: { type: 'string' },
        goose: { type: 'string' },
        manifest: { type: 'string' },
        task: { type: 'string', multiple: true },
        'skip-learning': { type: 'boolean', default: false },
        'work-dir': { type: 'string' },
        'results-dir': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }).values;
  } catch (error) {
    throw new RunnerError(`参数有误：${errorMessage(error)}\n\n${HELP}`);
  }
  if (values.help) {
    return 'help';
  }

  const provider = (values.provider ?? process.env.GOOSE_PROVIDER ?? '').trim();
  const envModel = (process.env.GOOSE_MODEL ?? '').trim();
  const names = values.model ?? (envModel.length > 0 ? [envModel] : []);
  const models = [...new Set(names.map((name) => name.trim()).filter((name) => name.length > 0))];
  if (provider.length === 0 || models.length === 0) {
    throw new RunnerError(
      '请用 --provider 与 --model 指定要评测的模型（或设置 GOOSE_PROVIDER、GOOSE_MODEL）'
    );
  }
  const budget = parseBudget(values.budget);
  if (budget === null) {
    throw new RunnerError('请用 --budget 指定 token 预算上限：正整数，可写 2000000、2,000,000、500k 或 2m');
  }
  const dryRun = values['dry-run'] === true;
  const resultsDir = values['results-dir'];
  return {
    models: models.map((model) => ({ provider, model })),
    budget,
    goose: values.goose ?? process.env.GOOSE_BIN ?? null,
    manifest: values.manifest ?? null,
    tasks: values.task ?? null,
    skipLearning: values['skip-learning'] === true,
    workBase: path.resolve(values['work-dir'] ?? path.join(os.tmpdir(), 'modelforge-evals')),
    resultsDir:
      resultsDir !== undefined ? path.resolve(resultsDir) : dryRun ? null : DEFAULT_RESULTS_DIR,
    dryRun,
  };
}

// ---------------------------------------------------------------------------------------------
// Tasks, samples, kernel
// ---------------------------------------------------------------------------------------------

interface LoadedTask {
  config: TaskEvalConfig;
  checks: CheckDefinition[];
  baseline: BaselineValue[];
  taskFile: string;
  exampleDir: string;
}

interface LoadedSample {
  config: LearningSampleConfig;
  recipeFile: string;
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; reason: string }): T {
  if (!result.ok) {
    throw new RunnerError(result.reason);
  }
  return result.value;
}

function loadTask(yaml: YamlModule, id: string): LoadedTask {
  const dir = path.join(SUITE_DIR, id);
  const taskFile = path.join(dir, 'task.yaml');
  const config = unwrap(parseTaskDocument(yaml.parse(fs.readFileSync(taskFile, 'utf8')), id));
  const checksText = fs.readFileSync(path.join(dir, ...config.checks.split('/')), 'utf8');
  const checks = unwrap(parseChecksDocument(yaml.parse(checksText), id));
  const baselineText = fs.readFileSync(path.join(dir, ...config.baseline.split('/')), 'utf8');
  const baseline = unwrap(parseBaselineDocument(JSON.parse(baselineText), id));
  const exampleDir = path.join(REPO_ROOT, ...config.example.split('/'));
  for (const input of config.inputs) {
    if (!fs.statSync(path.join(exampleDir, ...input.split('/'))).isFile()) {
      throw new RunnerError(`输入文件 ${input} 不是文件`);
    }
  }
  return { config, checks, baseline, taskFile, exampleDir };
}

function loadTasks(yaml: YamlModule, only: readonly string[] | null): LoadedTask[] {
  let ids = fs
    .readdirSync(SUITE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(SUITE_DIR, entry.name, 'task.yaml')))
    .map((entry) => entry.name)
    .sort();
  if (only !== null) {
    const unknown = only.filter((id) => !ids.includes(id));
    if (unknown.length > 0) {
      throw new RunnerError(`没有这些题目：${unknown.join('、')}（可选：${ids.join('、')}）`);
    }
    ids = ids.filter((id) => only.includes(id));
  }
  const problems: string[] = [];
  const tasks: LoadedTask[] = [];
  for (const id of ids) {
    try {
      tasks.push(loadTask(yaml, id));
    } catch (error) {
      problems.push(`${id}: ${errorMessage(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new RunnerError(`评测题目读取失败：\n  ${problems.join('\n  ')}`);
  }
  if (tasks.length === 0) {
    throw new RunnerError('evals/modeling/ 下没有评测题目');
  }
  return tasks;
}

function loadSamples(yaml: YamlModule): LoadedSample[] {
  if (!fs.existsSync(SAMPLES_DIR)) {
    return [];
  }
  const problems: string[] = [];
  const samples: LoadedSample[] = [];
  const files = fs
    .readdirSync(SAMPLES_DIR)
    .filter((name) => name.endsWith('.yaml'))
    .sort();
  for (const name of files) {
    const recipeFile = path.join(SAMPLES_DIR, name);
    try {
      const doc = yaml.parse(fs.readFileSync(recipeFile, 'utf8'));
      const config = unwrap(parseSampleDocument(doc, name.slice(0, -'.yaml'.length)));
      samples.push({ config, recipeFile });
    } catch (error) {
      problems.push(`${name}: ${errorMessage(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new RunnerError(`学习模式样例读取失败：\n  ${problems.join('\n  ')}`);
  }
  return samples;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The kernel binary: `--goose`, then GOOSE_BIN, then goose on PATH. */
function findKernel(explicit: string | null): { binary: string | null; problem?: string } {
  if (explicit !== null) {
    const binary = path.resolve(explicit);
    return isFile(binary)
      ? { binary: fs.realpathSync.native(binary) }
      : { binary: null, problem: `找不到内核二进制 ${binary}` };
  }
  // Without a shell only an executable can be started, so .cmd wrappers are not considered.
  const name = IS_WINDOWS ? 'goose.exe' : 'goose';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir.length > 0 && isFile(path.join(dir, name))) {
      return { binary: fs.realpathSync.native(path.join(dir, name)) };
    }
  }
  return { binary: null, problem: `PATH 中没有 ${name}，请用 --goose 指定内核二进制` };
}

function sha256File(file: string): string {
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    for (let read = fs.readSync(fd, buffer); read > 0; read = fs.readSync(fd, buffer)) {
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Requirement 23.5, 23.6: the commit and dirty flag of the kernel that runs the tasks. */
function readProvenance(binary: string | null, manifestOverride: string | null): EvalProvenance {
  const file =
    manifestOverride !== null
      ? path.resolve(manifestOverride)
      : binary !== null
        ? path.join(path.dirname(binary), MANIFEST_FILE_NAME)
        : null;
  let manifest: ManifestResult | null = null;
  if (file !== null) {
    try {
      manifest = parseManifest(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      manifest =
        errorCode(error) === 'ENOENT'
          ? null
          : { ok: false, reason: `无法读取 ${file}（${errorCode(error)}）` };
    }
  }
  let mismatches: ManifestMismatch[] | null = null;
  if (manifest !== null && manifest.ok && binary !== null) {
    try {
      mismatches = verifyManifest(manifest.manifest, { [path.basename(binary)]: sha256File(binary) });
    } catch {
      mismatches = null;
    }
  }
  return traceability(manifest, mismatches);
}

// ---------------------------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------------------------

/** Resolves true only for an explicit yes; a closed input or Ctrl+C cancels. */
function askConfirmation(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY === true,
    });
    let settled = false;
    const finish = (answer: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      rl.close();
      if (process.stdin.isTTY !== true) {
        // Piped answers are not echoed; end the prompt line.
        process.stdout.write('\n');
      }
      resolve(isConfirmed(answer));
    };
    rl.on('line', (line) => finish(line));
    rl.on('close', () => finish(null));
    rl.on('SIGINT', () => finish(null));
    rl.setPrompt(prompt);
    rl.prompt();
  });
}

// ---------------------------------------------------------------------------------------------
// Running goose
// ---------------------------------------------------------------------------------------------

interface RunState {
  /** Ctrl+C after the confirmation, or a runner error: start nothing more. */
  stopped: boolean;
  stopCurrent: (() => void) | null;
}

interface ProcessResult {
  spawnError: string | null;
  stoppedBy: RunOutcome['stoppedBy'];
  exitCode: number | null;
  signal: string | null;
  seconds: number;
}

interface GooseInvocation {
  binary: string;
  args: string[];
  cwd: string;
  stdoutFile: string;
  stderrFile: string;
  timeoutMs: number;
  /** Polled while goose runs; true stops it for the budget. */
  overBudget: () => Promise<boolean>;
}

function childEnv(): NodeJS.ProcessEnv {
  // Headless runs refuse to start in the approve modes; the evaluation runs unattended.
  return { ...process.env, GOOSE_MODE: 'auto', NO_COLOR: '1' };
}

function closeQuietly(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // Already closed.
  }
}

/** Stops goose together with the Python, LaTeX and extension processes it started. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }, KILL_GRACE_MS);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

function runGoose(invocation: GooseInvocation, state: RunState): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const stdoutFd = fs.openSync(invocation.stdoutFile, 'w');
    const stderrFd = fs.openSync(invocation.stderrFile, 'w');
    const cleanups: (() => void)[] = [];
    let stoppedBy: RunOutcome['stoppedBy'] = null;
    let spawnError: string | null = null;
    let settled = false;
    const settle = (exitCode: number | null, signal: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      for (const cleanup of cleanups) {
        cleanup();
      }
      closeQuietly(stdoutFd);
      closeQuietly(stderrFd);
      state.stopCurrent = null;
      resolve({ spawnError, stoppedBy, exitCode, signal, seconds: (Date.now() - started) / 1000 });
    };

    let child: ChildProcess;
    try {
      child = spawn(invocation.binary, invocation.args, {
        cwd: invocation.cwd,
        env: childEnv(),
        stdio: ['ignore', stdoutFd, stderrFd],
        // POSIX: its own process group, so that the whole tree can be stopped.
        detached: !IS_WINDOWS,
        windowsHide: true,
      });
    } catch (error) {
      spawnError = errorCode(error);
      settle(null, null);
      return;
    }
    const running = child;
    const stop = (reason: NonNullable<RunOutcome['stoppedBy']>) => {
      if (settled || stoppedBy !== null) {
        return;
      }
      stoppedBy = reason;
      killTree(running);
    };
    running.on('error', (error) => {
      if (running.pid === undefined) {
        spawnError = errorCode(error);
        settle(null, null);
      }
    });
    running.on('close', (code, signal) => settle(code, signal));

    state.stopCurrent = () => stop('interrupted');
    const timer = setTimeout(() => stop('timeout'), invocation.timeoutMs);
    cleanups.push(() => clearTimeout(timer));
    let polling = false;
    const poller = setInterval(() => {
      if (polling || settled || stoppedBy !== null) {
        return;
      }
      polling = true;
      invocation
        .overBudget()
        .then(
          (over) => {
            if (over) {
              stop('budget');
            }
          },
          () => undefined
        )
        .finally(() => {
          polling = false;
        });
    }, POLL_INTERVAL_MS);
    cleanups.push(() => clearInterval(poller));
    if (state.stopped) {
      stop('interrupted');
    }
  });
}

/** `goose session list --format json -w <dir>`: the session record of a working directory. */
function readSessionUsage(binary: string, workDir: string): Promise<SessionUsage | null> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(binary, ['session', 'list', '--format', 'json', '-w', workDir], {
        env: childEnv(),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    const running = child;
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: SessionUsage | null) => {
      if (done) {
        return;
      }
      done = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      resolve(value);
    };
    timer = setTimeout(() => {
      running.kill();
      finish(null);
    }, SESSION_LIST_TIMEOUT_MS);
    running.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PARSED_BYTES) {
        running.kill();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    running.on('error', () => finish(null));
    running.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      finish(code === 0 ? sessionUsageForDir(text, workDir, IS_WINDOWS) : null);
    });
  });
}

function readCapped(file: string, limit: number): string | null {
  try {
    if (fs.statSync(file).size > limit) {
      return null;
    }
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface RunContext {
  kernel: string;
  limit: number;
  stamp: string;
  workRoot: string;
  state: RunState;
}

interface RecipeRun {
  outcome: RunOutcome;
  classification: RunClassification;
  output: GooseJsonOutput | null;
  tokens: ResolvedTokens;
  seconds: number;
}

/** Runs one recipe headless in `workDir` and reads back how it ended and what it cost. */
async function runRecipe(
  ctx: RunContext,
  request: {
    recipeFile: string;
    workDir: string;
    logBase: string;
    sessionName: string;
    model: ModelRef;
    timeoutMinutes: number;
    usedBefore: number;
  }
): Promise<RecipeRun> {
  const { workDir } = request;
  const args = [
    'run',
    '--recipe',
    request.recipeFile,
    '--output-format',
    'json',
    '--quiet',
    '--provider',
    request.model.provider,
    '--model',
    request.model.model,
    '--name',
    request.sessionName,
  ];
  const stdoutFile = `${request.logBase}.stdout.json`;
  const run = await runGoose(
    {
      binary: ctx.kernel,
      args,
      cwd: workDir,
      stdoutFile,
      stderrFile: `${request.logBase}.stderr.log`,
      timeoutMs: request.timeoutMinutes * 60_000,
      overBudget: async () => {
        const usage = await readSessionUsage(ctx.kernel, workDir);
        if (usage === null || usage.sessions === 0) {
          return false;
        }
        const total = request.usedBefore + usage.tokensIn + usage.tokensOut;
        return budgetGate(total, ctx.limit) === 'stop';
      },
    },
    ctx.state
  );

  const stdout = readCapped(stdoutFile, MAX_PARSED_BYTES);
  const output = stdout === null ? null : parseGooseJsonOutput(stdout);
  const outcome: RunOutcome = {
    spawnError: run.spawnError,
    stoppedBy: run.stoppedBy,
    exitCode: run.exitCode,
    signal: run.signal,
    reported: output?.status ?? null,
  };
  let tokens: ResolvedTokens;
  if (run.spawnError !== null) {
    tokens = { tokensIn: 0, tokensOut: 0, tokenSource: 'none' };
  } else if (output !== null && output.usage !== null) {
    tokens = resolveTokens(output.usage, null);
  } else {
    const session = await readSessionUsage(ctx.kernel, workDir);
    tokens = resolveTokens(null, fallbackUsage(session, run.stoppedBy !== null));
  }
  return { outcome, classification: classifyRun(outcome), output, tokens, seconds: run.seconds };
}

function pathState(file: string): PathState {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return 'missing';
  }
  if (stat.isFile()) {
    return stat.size > 0 ? 'present' : 'empty';
  }
  if (!stat.isDirectory()) {
    return 'missing';
  }
  const pending = [file];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) {
        return 'present';
      }
      if (entry.isDirectory()) {
        pending.push(path.join(dir, entry.name));
      }
    }
  }
  return 'empty';
}

function inspectOutputs(task: LoadedTask, workDir: string): Record<string, PathState> {
  const states: Record<string, PathState> = {};
  for (const relative of pathsToInspect(task.checks, task.config.outputs.paper)) {
    states[relative] = pathState(path.join(workDir, ...relative.split('/')));
  }
  return states;
}

function readReportedValues(file: string): Record<string, unknown> | null {
  const text = readCapped(file, MAX_VALUES_BYTES);
  if (text === null) {
    return null;
  }
  try {
    return extractReportedValues(JSON.parse(text.replace(/^\uFEFF/, '')));
  } catch {
    return null;
  }
}

/** A fresh, empty working directory holding a copy of the task's inputs. */
function prepareWorkDir(dir: string, inputs: readonly string[], fromDir: string | null): string {
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).length > 0) {
    throw new RunnerError(`工作目录不是空目录：${dir}`);
  }
  if (fromDir !== null) {
    for (const input of inputs) {
      const target = path.join(dir, ...input.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(fromDir, ...input.split('/')), target);
    }
  }
  // goose records the directory it was started in; compare against the same resolved path.
  return fs.realpathSync.native(dir);
}

interface PlannedTask {
  task: LoadedTask;
  model: ModelRef;
  label: string;
}

interface TaskRun {
  result: EvalTaskResult;
  detail: EvalTaskDetail;
}

async function runTask(ctx: RunContext, item: PlannedTask, usedBefore: number): Promise<TaskRun> {
  const { task, model, label } = item;
  const id = task.config.id;
  const modelDir = path.join(ctx.workRoot, safeDirName(label));
  const logDir = path.join(modelDir, '_logs');
  fs.mkdirSync(logDir, { recursive: true });
  const workDir = prepareWorkDir(path.join(modelDir, id), task.config.inputs, task.exampleDir);

  const run = await runRecipe(ctx, {
    recipeFile: task.taskFile,
    workDir,
    logBase: path.join(logDir, id),
    sessionName: `modelforge-eval-${ctx.stamp}-${safeDirName(label)}-${id}`,
    model,
    timeoutMinutes: task.config.timeoutMinutes,
    usedBefore,
  });
  const states = inspectOutputs(task, workDir);
  const { status, failure } = run.classification;
  const checks =
    status === '完成'
      ? judgeChecks(task.checks, task.baseline, {
          paths: states,
          values: readReportedValues(path.join(workDir, ...task.config.outputs.values.split('/'))),
          valuesFile: task.config.outputs.values,
        })
      : [];
  const result: EvalTaskResult = {
    id,
    passed: countVerdicts(checks, '通过'),
    total: task.checks.length,
    compiled: states[task.config.outputs.paper] === 'present',
    seconds: run.seconds,
    tokensIn: run.tokens.tokensIn,
    tokensOut: run.tokens.tokensOut,
    model: label,
    status,
    ...(failure === undefined ? {} : { failure }),
  };
  const description = describeOutcome(run.outcome, task.config.timeoutMinutes);
  const detail: EvalTaskDetail = {
    checks,
    tokenSource: run.tokens.tokenSource,
    ...(description === undefined ? {} : { detail: description }),
  };
  return { result, detail };
}

/** A stand-in for a task in a dry run: nothing was produced, no tokens were spent. */
function rehearseTask(item: PlannedTask): TaskRun {
  const { task, label } = item;
  const checks = judgeChecks(task.checks, task.baseline, {
    paths: {},
    values: null,
    valuesFile: task.config.outputs.values,
  });
  return {
    result: {
      id: task.config.id,
      passed: countVerdicts(checks, '通过'),
      total: task.checks.length,
      compiled: false,
      seconds: 0,
      tokensIn: 0,
      tokensOut: 0,
      model: label,
      status: '完成',
    },
    detail: { checks, tokenSource: 'none', detail: '演练：没有启动 goose，检查项按空输出判定' },
  };
}

interface PlannedSample {
  sample: LoadedSample;
  model: ModelRef;
  label: string;
}

function sampleReport(
  item: PlannedSample,
  fields: {
    status: LearningSampleReport['status'];
    failure?: LearningSampleReport['failure'];
    seconds: number;
    tokens: ResolvedTokens | null;
    texts: string[];
    detail?: string;
    /** False in a dry run, where there is no reply to assess. */
    assess?: boolean;
  }
): LearningSampleReport {
  const { config } = item.sample;
  const assessed = fields.status === '完成' && fields.assess !== false;
  const assessment = assessed
    ? assessLearningReply(fields.texts.join('\n\n'), config.outputs)
    : { suspectedFullSolution: false, missingHintOrQuestion: false, reasons: [] };
  const { reply, replyTruncated } = replyForReport(fields.texts);
  return {
    id: config.id,
    exerciseId: config.exerciseId,
    scenario: config.scenario,
    model: item.label,
    status: fields.status,
    ...(fields.failure === undefined ? {} : { failure: fields.failure }),
    seconds: fields.seconds,
    tokensIn: fields.tokens?.tokensIn ?? 0,
    tokensOut: fields.tokens?.tokensOut ?? 0,
    tokenSource: fields.tokens?.tokenSource ?? 'none',
    suspectedFullSolution: assessment.suspectedFullSolution,
    missingHintOrQuestion: assessment.missingHintOrQuestion,
    reasons: assessment.reasons,
    reply,
    replyTruncated,
    ...(fields.detail === undefined ? {} : { detail: fields.detail }),
  };
}

async function runSample(
  ctx: RunContext,
  item: PlannedSample,
  usedBefore: number
): Promise<LearningSampleReport> {
  const { config, recipeFile } = item.sample;
  const modelDir = path.join(ctx.workRoot, safeDirName(item.label));
  const logDir = path.join(modelDir, '_logs');
  fs.mkdirSync(logDir, { recursive: true });
  const workDir = prepareWorkDir(path.join(modelDir, 'learning', config.id), [], null);
  const run = await runRecipe(ctx, {
    recipeFile,
    workDir,
    logBase: path.join(logDir, `learning-${config.id}`),
    sessionName: `modelforge-eval-${ctx.stamp}-${safeDirName(item.label)}-learning-${config.id}`,
    model: item.model,
    timeoutMinutes: config.timeoutMinutes,
    usedBefore,
  });
  return sampleReport(item, {
    status: run.classification.status,
    failure: run.classification.failure,
    seconds: run.seconds,
    tokens: run.tokens,
    texts: run.output?.assistantText ?? [],
    detail: describeOutcome(run.outcome, config.timeoutMinutes),
  });
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

function writeResultFile(dir: string, stamp: string, file: EvalRunFile): string {
  fs.mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(file, null, 2)}\n`;
  for (let attempt = 1; ; attempt += 1) {
    const target = path.join(dir, attempt === 1 ? `${stamp}.json` : `${stamp}-${attempt}.json`);
    if (fs.existsSync(target)) {
      continue;
    }
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { flag: 'wx' });
    fs.renameSync(temporary, target);
    return target;
  }
}

function printSummary(file: EvalRunFile): void {
  console.log('\n评测结果：');
  for (const task of file.tasks) {
    const failure = task.failure === undefined ? '' : `（${task.failure}）`;
    const pending = task.pendingReview > 0 ? `，待人工 ${task.pendingReview}` : '';
    console.log(
      `  ${task.id} [${task.model}] ${task.status}${failure}：检查项 ${task.passed}/${task.total}${pending}，` +
        `论文编译${task.compiled ? '成功' : '失败'}，用时 ${task.seconds.toFixed(1)} 秒，` +
        `token 输入 ${formatTokens(task.tokensIn)} / 输出 ${formatTokens(task.tokensOut)}` +
        (task.detail === undefined ? '' : `；${task.detail}`)
    );
  }
  const { summary, budget } = file;
  console.log(
    `  合计：检查项通过 ${summary.passed}，用时 ${summary.seconds.toFixed(1)} 秒，题目 token ${formatTokens(summary.tokens)}；` +
      `含学习模式样例共 ${formatTokens(budget.used)} / 预算 ${formatTokens(budget.limit)}`
  );
  if (file.tasks.some((task) => task.pendingReview > 0)) {
    console.log('  "待人工"的检查项需要对照论文人工判定，判定前不计入通过数。');
  }

  if (file.learningSamples.length > 0) {
    const flagged = file.learningSamples.filter(
      (sample) => sample.suspectedFullSolution || sample.missingHintOrQuestion
    );
    console.log(
      `\n学习模式抽样（只出报告，不作为通过条件）：${file.learningSamples.length} 个样例，${flagged.length} 个需要人工复核`
    );
    for (const sample of file.learningSamples) {
      const flags = [
        sample.suspectedFullSolution ? '疑似给出完整解答代码' : '',
        sample.missingHintOrQuestion ? '没有提示或追问' : '',
      ].filter((flag) => flag.length > 0);
      const state =
        sample.status === '完成' ? (flags.length > 0 ? flags.join('，') : '未发现问题') : sample.status;
      const detail = sample.detail === undefined ? '' : `；${sample.detail}`;
      console.log(`  ${sample.id} [${sample.model}]：${state}${detail}`);
    }
  }

  if (!Number.isFinite(budget.used)) {
    console.log('\n无法读取 token 用量：为避免超出预算，已停止发起新的模型调用，未完成的题目标记为"已中止"。');
  } else if (budget.exhausted) {
    console.log(
      `\n预算已耗尽：累计 token 用量 ${formatTokens(budget.used)} 已达到上限 ${formatTokens(budget.limit)}，` +
        '已停止发起新的模型调用，未完成的题目标记为"已中止"。'
    );
  }
  if (!file.traceable) {
    console.log(`\n缺少 Build_Manifest：${file.untraceableReason ?? '无法读取'}。本次结果已标记为"不可追溯"。`);
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main(): Promise<number> {
  const options = readOptions(scriptArguments());
  if (options === 'help') {
    console.log(HELP);
    return 0;
  }
  const yaml = loadYaml();
  const tasks = loadTasks(yaml, options.tasks);
  const samples = options.skipLearning ? [] : loadSamples(yaml);
  const kernel = findKernel(options.goose);
  if (kernel.binary === null && !options.dryRun) {
    throw new RunnerError(kernel.problem ?? '找不到内核二进制');
  }
  const provenance = readProvenance(kernel.binary, options.manifest);
  const stamp = resultFileStamp(new Date());
  const workRoot = path.join(options.workBase, stamp);
  const labels = options.models.map(modelLabel);

  const plannedTasks: PlannedTask[] = options.models.flatMap((model) =>
    tasks.map((task) => ({ task, model, label: modelLabel(model) }))
  );
  const plannedSamples: PlannedSample[] = options.models.flatMap((model) =>
    samples.map((sample) => ({ sample, model, label: modelLabel(model) }))
  );
  const specs: EvalTaskSpec[] = plannedTasks.map((item) => ({
    id: item.task.config.id,
    total: item.task.checks.length,
    model: item.label,
  }));

  for (const line of confirmationLines({
    models: labels,
    tasks: tasks.map(({ config }) => ({
      id: config.id,
      title: config.title,
      category: config.category,
      timeoutMinutes: config.timeoutMinutes,
    })),
    samples: samples.map(({ config }) => ({ id: config.id, scenario: config.scenario })),
    budget: options.budget,
    kernel: kernel.binary,
    provenance,
    workRoot,
    resultsDir: options.resultsDir,
    extraModels: extraModelSettings(process.env),
    dryRun: options.dryRun,
  })) {
    console.log(line);
  }
  if (!(await askConfirmation(CONFIRMATION_PROMPT))) {
    console.log(CANCELLED_MESSAGE);
    return 1;
  }

  const startedAt = new Date();
  const state: RunState = { stopped: false, stopCurrent: null };
  process.on('SIGINT', () => {
    if (state.stopped) {
      console.log('\n再次中断：立即退出，不写结果文件。');
      process.exit(130);
    }
    state.stopped = true;
    console.log('\n收到中断：正在停止当前运行，随后写入结果文件（再按一次 Ctrl+C 立即退出）。');
    state.stopCurrent?.();
  });

  const ctx: RunContext = {
    kernel: kernel.binary ?? '',
    limit: options.budget,
    stamp,
    workRoot,
    state,
  };
  const results: EvalTaskResult[] = [];
  const details: EvalTaskDetail[] = [];
  const learning: LearningSampleReport[] = [];
  let failure: unknown = null;

  try {
    for (
      let spec = nextTask(specs, results, options.budget);
      spec !== null && !state.stopped;
      spec = nextTask(specs, results, options.budget)
    ) {
      const item = plannedTasks[results.length];
      console.log(`\n▶ ${spec.id} [${spec.model}]（第 ${results.length + 1}/${specs.length} 次运行）`);
      const run = options.dryRun ? rehearseTask(item) : await runTask(ctx, item, tokensUsed(results));
      results.push(run.result);
      details.push(run.detail);
      console.log(
        `  ${run.result.status}${run.result.failure === undefined ? '' : `（${run.result.failure}）`}，` +
          `用时 ${run.result.seconds.toFixed(1)} 秒，累计 token ${formatTokens(tokensUsed(results))}`
      );
    }

    for (const item of plannedSamples) {
      const used = tokensUsed(results) + learningTokens(learning);
      if (state.stopped || budgetGate(used, options.budget) === 'stop') {
        learning.push(sampleReport(item, { status: '已中止', seconds: 0, tokens: null, texts: [] }));
        continue;
      }
      console.log(`\n▶ 学习模式样例 ${item.sample.config.id} [${item.label}]`);
      learning.push(
        options.dryRun
          ? sampleReport(item, {
              status: '完成',
              seconds: 0,
              tokens: { tokensIn: 0, tokensOut: 0, tokenSource: 'none' },
              texts: [],
              detail: '演练：没有启动 goose，回复未评估',
              assess: false,
            })
          : await runSample(ctx, item, used)
      );
    }
  } catch (error) {
    // Keep what has run so far: stop, mark the rest 已中止 and still write the result file.
    failure = error;
    state.stopped = true;
    console.error(`\n运行出错，已停止：${errorMessage(error)}`);
    for (const item of plannedSamples.slice(learning.length)) {
      learning.push(sampleReport(item, { status: '已中止', seconds: 0, tokens: null, texts: [] }));
    }
  }

  const file = buildRunFile({
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    dryRun: options.dryRun,
    models: labels,
    limit: options.budget,
    interrupted: state.stopped,
    provenance,
    specs,
    results,
    details,
    learningSamples: learning,
  });
  printSummary(file);

  const fileStamp = resultFileStamp(startedAt);
  if (options.resultsDir === null) {
    console.log('\n演练模式：结果文件未写入，内容如下。');
    console.log(JSON.stringify(file, null, 2));
  } else {
    const written = writeResultFile(options.resultsDir, fileStamp, file);
    console.log(`\n结果文件：${path.relative(process.cwd(), written) || written}`);
  }
  if (!options.dryRun) {
    console.log(`工作目录与 goose 日志：${workRoot}`);
  }
  return failure === null ? 0 : 2;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof RunnerError ? error.message : error);
    process.exitCode = 2;
  }
);

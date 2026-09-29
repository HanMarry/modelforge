/**
 * Main-process IPC for the paper delivery check (requirement 18, tasks 23.8, 23.10).
 *
 * `paper-check-run` validates the request, confirms that the Project root is a real directory and
 * that the paper, once symbolic links are resolved, lies inside it (the `realpath` prefix check of
 * `datasetIpc.ts`), then runs the checks in the `utilityProcess` entry `paperCheckRunnerMain.ts`
 * so parsing large sources and PDFs never blocks the main process. The process is killed after
 * the report arrives or after 60 s (10 min with online reference lookups, whose own limit is
 * 10 s per entry). Error messages and report text leave the main process only after every known
 * key value is masked (requirement 1.10).
 *
 * A paper path that does not exist yet is passed on as written (it cannot escape the root: `..`
 * above the root is rejected); the checks then report the missing source as `无法执行` (18.7).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { utilityProcess, type IpcMain } from 'electron';
import type {
  AnonymityTerms,
  PaperCheckIssue,
  PaperCheckReport,
  PaperCheckRequest,
} from '../../types/paperCheckApi';
import type { FeatureIpcDeps } from '../featureIpc';
import { toIpcError, type IpcResult } from '../ipcResult';
import { redactText } from '../secretMask';
import { normalizeProjectPath } from './common';
import type { PaperCheckRunMessage } from './paperCheckRunner';

export const PAPER_CHECK_RUN_CHANNEL = 'paper-check-run';
/** Requirement 18.8: the report is shown within 60 s without online lookups. */
export const OFFLINE_TIMEOUT_MS = 60_000;
export const ONLINE_TIMEOUT_MS = 10 * 60_000;

const MAX_PATH_LENGTH = 4096;
const MAX_TERMS = 20;
const MAX_TERM_LENGTH = 200;

/** Runs one check in a separate process; replaced in tests. */
export type PaperCheckLauncher = (
  message: PaperCheckRunMessage,
  timeoutMs: number
) => Promise<IpcResult<PaperCheckReport>>;

function isIpcResult(value: unknown): value is IpcResult<PaperCheckReport> {
  if (typeof value !== 'object' || value === null || !('ok' in value)) {
    return false;
  }
  const result = value as { ok: unknown; data?: unknown; error?: unknown };
  if (result.ok === true) {
    const data = result.data as { items?: unknown } | undefined;
    return typeof data === 'object' && data !== null && Array.isArray(data.items);
  }
  const error = result.error as { code?: unknown; message?: unknown } | undefined;
  return (
    result.ok === false &&
    typeof error === 'object' &&
    error !== null &&
    typeof error.code === 'string' &&
    typeof error.message === 'string'
  );
}

/** Forks `paperCheckRunnerMain.js`, like `datasetIpc.ts` does for the dataset parser. */
export const forkPaperCheckRunner: PaperCheckLauncher = (message, timeoutMs) =>
  new Promise((resolve) => {
    const child = utilityProcess.fork(path.join(__dirname, 'paperCheckRunnerMain.js'), [], {
      serviceName: 'ModelForge Paper Check',
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: IpcResult<PaperCheckReport>): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      child.kill();
      resolve(result);
    };
    timer = setTimeout(() => {
      const seconds = Math.round(timeoutMs / 1000);
      finish({
        ok: false,
        error: { code: 'TIMEOUT', message: `The paper check did not finish within ${seconds} s` },
      });
    }, timeoutMs);
    child.on('message', (response: unknown) => {
      finish(
        isIpcResult(response)
          ? response
          : {
              ok: false,
              error: { code: 'RUNNER_FAILED', message: 'The paper check sent an invalid reply' },
            }
      );
    });
    child.on('exit', (code: number) => {
      finish({
        ok: false,
        error: { code: 'RUNNER_FAILED', message: `The paper check process exited with ${code}` },
      });
    });
    child.postMessage(message);
  });

function isShortString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0');
}

function parseAnonymity(value: unknown): AnonymityTerms | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { names, school, team } = value as Record<string, unknown>;
  if (
    !Array.isArray(names) ||
    names.length > MAX_TERMS ||
    !names.every((name) => isShortString(name, MAX_TERM_LENGTH)) ||
    !isShortString(school, MAX_TERM_LENGTH) ||
    !isShortString(team, MAX_TERM_LENGTH)
  ) {
    return null;
  }
  return { names: [...(names as string[])], school, team };
}

interface ParsedRequest {
  projectDir: string;
  /** Normalised project-relative path. */
  paperPath: string;
  online: boolean;
  anonymity?: AnonymityTerms;
}

/** The request if it is well-formed; the renderer's input is not trusted. */
export function parsePaperCheckRequest(value: unknown): ParsedRequest | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const request = value as Partial<Record<keyof PaperCheckRequest, unknown>>;
  const { projectDir, paperPath, online } = request;
  if (
    !isShortString(projectDir, MAX_PATH_LENGTH) ||
    projectDir.trim() === '' ||
    !path.isAbsolute(projectDir) ||
    !isShortString(paperPath, MAX_PATH_LENGTH) ||
    path.isAbsolute(paperPath) ||
    /^[A-Za-z]:/.test(paperPath) ||
    typeof online !== 'boolean'
  ) {
    return null;
  }
  const normalized = normalizeProjectPath(paperPath);
  const anonymity = parseAnonymity(request.anonymity);
  if (normalized === null || normalized === '' || anonymity === null) {
    return null;
  }
  return {
    projectDir,
    paperPath: normalized,
    online,
    ...(anonymity === undefined ? {} : { anonymity }),
  };
}

type Resolved = { root: string; paperPath: string } | { error: string; message: string };

/** The real root and the paper path inside it, or why the request is refused. */
async function resolveTarget(projectDir: string, paperPath: string): Promise<Resolved> {
  let root: string;
  try {
    root = await fs.realpath(projectDir);
    if (!(await fs.stat(root)).isDirectory()) {
      return { error: 'PROJECT_NOT_FOUND', message: 'The project is not a directory' };
    }
  } catch {
    return { error: 'PROJECT_NOT_FOUND', message: 'The project directory does not exist' };
  }
  const candidate = path.join(root, ...paperPath.split('/'));
  let real: string;
  try {
    real = await fs.realpath(candidate);
  } catch {
    // Not there (yet): the normalised path cannot leave the root, and the checks say it is missing.
    return { root, paperPath };
  }
  if (!real.startsWith(root + path.sep)) {
    return { error: 'OUTSIDE_PROJECT', message: 'The paper must be inside the project' };
  }
  return { root, paperPath: path.relative(root, real).split(path.sep).join('/') };
}

function redactIssue(issue: PaperCheckIssue, secrets: readonly string[]): PaperCheckIssue {
  const params: PaperCheckIssue['params'] = {};
  for (const [key, value] of Object.entries(issue.params)) {
    params[key] = typeof value === 'string' ? redactText(value, secrets) : value;
  }
  return { ...issue, params, message: redactText(issue.message, secrets) };
}

/** Masks key values in every text of the report before it reaches the renderer. */
function redactReport(report: PaperCheckReport, secrets: readonly string[]): PaperCheckReport {
  if (secrets.length === 0) {
    return report;
  }
  return {
    ...report,
    items: report.items.map((item) => ({
      ...item,
      issues: item.issues.map((issue) => redactIssue(issue, secrets)),
      ...(item.reasonDetail === undefined
        ? {}
        : { reasonDetail: redactText(item.reasonDetail, secrets) }),
    })),
  };
}

export function registerPaperCheckIpc(
  ipc: Pick<IpcMain, 'handle'>,
  deps: FeatureIpcDeps,
  launch: PaperCheckLauncher = forkPaperCheckRunner
): void {
  ipc.handle(
    PAPER_CHECK_RUN_CHANNEL,
    async (_event, request: unknown): Promise<IpcResult<PaperCheckReport>> => {
      const secrets = deps.sensitiveValues();
      const parsed = parsePaperCheckRequest(request);
      if (parsed === null) {
        return {
          ok: false,
          error: toIpcError('INVALID_REQUEST', 'The paper check request is malformed', secrets),
        };
      }
      try {
        const target = await resolveTarget(parsed.projectDir, parsed.paperPath);
        if ('error' in target) {
          return { ok: false, error: toIpcError(target.error, target.message, secrets) };
        }
        const message: PaperCheckRunMessage = {
          root: target.root,
          paperPath: target.paperPath,
          online: parsed.online,
          ...(parsed.anonymity === undefined ? {} : { anonymity: parsed.anonymity }),
        };
        const result = await launch(
          message,
          parsed.online ? ONLINE_TIMEOUT_MS : OFFLINE_TIMEOUT_MS
        );
        if (!result.ok) {
          return { ok: false, error: toIpcError(result.error.code, result.error.message, secrets) };
        }
        return { ok: true, data: redactReport(result.data, secrets) };
      } catch (error) {
        return { ok: false, error: toIpcError('CHECK_FAILED', error, secrets) };
      }
    }
  );
}

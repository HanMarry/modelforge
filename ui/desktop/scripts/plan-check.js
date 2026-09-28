#!/usr/bin/env node
/**
 * Checks `docs/plan/OPTIMIZATION_PLAN.md`, the project's only execution plan
 * (spec mathmodel-parity-and-beyond, requirement 24).
 *
 * Plan items: every Markdown table in the plan whose header has an `编号` (or `#`)
 * column lists plan items, one per row. Each item must fill in owner, 状态, 源码 commit,
 * 验证时间, 验证命令, 证据路径 and 剩余风险 (a lone `-`, `—`, `TBD`, `待定` … counts as
 * empty), and 状态 must be one of 未开始 / 进行中 / 已完成 / 已验证 / 已阻塞.
 *
 * An item marked 已验证 additionally needs
 *   - a commit (full SHA or a prefix of at least 7 hex digits) reachable from
 *     `origin/modelforge` (`git merge-base --is-ancestor <sha> origin/modelforge`),
 *   - a verification command in backticks, so it can be copied and run as written,
 *   - an 执行环境 naming the operating system and the architecture (e.g. Windows x64),
 *   - an ISO 8601 verification time (`2026-09-28` or `2026-09-28T08:28:42Z`).
 *
 * Evidence paths are backticked paths relative to the repository root (a `:<line>`
 * suffix is allowed) or Markdown links relative to the plan file; each must exist.
 *
 * Conflicting plans: a tracked Markdown file with a line calling itself the current or
 * only execution plan (当前执行计划, 唯一执行计划, 唯一计划源, "current execution plan")
 * conflicts with the plan, unless that line points at OPTIMIZATION_PLAN.md.
 *
 * The script only reads: it never writes to the working tree.
 *
 * Usage: node scripts/plan-check.js [--base <ref>]     (default: origin/modelforge)
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..', '..', '..');
const PLAN_PATH = 'docs/plan/OPTIMIZATION_PLAN.md';
const PLAN_FILE_NAME = 'OPTIMIZATION_PLAN.md';
const DEFAULT_BASE = 'origin/modelforge';

const STATUSES = ['未开始', '进行中', '已完成', '已验证', '已阻塞'];
const VERIFIED = '已验证';

/** Normalised header text → field key. Unknown columns are ignored. */
const COLUMNS = new Map([
  ['编号', 'id'],
  ['#', 'id'],
  ['项', 'title'],
  ['owner', 'owner'],
  ['状态', 'status'],
  ['源码commit', 'commit'],
  ['验证时间', 'verifiedAt'],
  ['验证命令', 'command'],
  ['执行环境', 'environment'],
  ['证据路径', 'evidence'],
  ['剩余风险', 'risk'],
]);

/** Fields every item must fill in (requirement 24.1). */
const REQUIRED_FIELDS = ['owner', 'status', 'commit', 'verifiedAt', 'command', 'evidence', 'risk'];

const FIELD_LABELS = {
  owner: 'owner',
  status: '状态',
  commit: '源码 commit',
  verifiedAt: '验证时间',
  command: '验证命令',
  environment: '执行环境',
  evidence: '证据路径',
  risk: '剩余风险',
};

/** Cell values that only stand in for "nothing written yet". */
const PLACEHOLDERS = new Set([
  '',
  '-',
  '--',
  '—',
  '——',
  '–',
  '/',
  'n/a',
  'na',
  'tbd',
  'todo',
  '?',
  '？',
  '待定',
  '待补',
  '待填',
]);

const SHA_PATTERN = /\b[0-9a-f]{7,40}\b/gi;
const OS_PATTERN = /windows|linux|ubuntu|debian|macos|mac os|os x|darwin/i;
const ARCH_PATTERN = /x64|x86[-_]64|amd64|arm64|aarch64|x86|ia32|armv7/i;
const ISO_8601 =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))?)?$/;
const PLAN_DECLARATION =
  /当前(?:的)?执行计划|唯一(?:的)?(?:执行)?计划(?:源)?|current execution plan|single source of truth for (?:the )?(?:execution )?plan/i;

// --- Parsing -----------------------------------------------------------------

function isTableRow(line) {
  return line.trim().startsWith('|');
}

function isSeparatorRow(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line) && line.includes('-');
}

/** Splits a table row on unescaped pipes (GFM: `\|` is a literal pipe inside a cell). */
function splitRow(line) {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells = [];
  let current = '';
  for (let index = 0; index < body.length; index++) {
    const char = body[index];
    if (char === '\\' && body[index + 1] === '|') {
      current += '|';
      index++;
    } else if (char === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function normaliseHeader(cell) {
  return cell.replace(/[`*]/g, '').replace(/\s+/g, '').toLowerCase();
}

/**
 * Reads the plan items out of the plan's Markdown.
 *
 * Returns `{ items }`, each item `{ id, line, fields }`: `line` is the 1-based line of
 * the row, `fields` maps the recognised columns (see `COLUMNS`) to the trimmed cell text.
 * A column missing from a table leaves the field `undefined`.
 */
function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !isTableRow(line) || !isSeparatorRow(lines[index + 1] ?? '')) continue;

    const header = splitRow(line).map((cell) => COLUMNS.get(normaliseHeader(cell)) ?? null);
    const isPlanTable = header.includes('id');
    let row = index + 2;
    for (; row < lines.length && isTableRow(lines[row]); row++) {
      if (!isPlanTable) continue;
      const cells = splitRow(lines[row]);
      const fields = {};
      header.forEach((key, column) => {
        if (key && fields[key] === undefined) fields[key] = cells[column] ?? '';
      });
      items.push({ id: (fields.id ?? '').trim(), line: row + 1, fields });
    }
    index = row - 1;
  }
  return { items };
}

// --- Validation --------------------------------------------------------------

function isBlank(value) {
  if (value === undefined || value === null) return true;
  return PLACEHOLDERS.has(value.replace(/[`*]/g, '').trim().toLowerCase());
}

/** 状态 cell without Markdown emphasis, so `**已验证**` reads as 已验证. */
function normaliseStatus(value) {
  return (value ?? '').replace(/[`*]/g, '').trim();
}

function extractShas(value) {
  return [...new Set((value.match(SHA_PATTERN) ?? []).map((sha) => sha.toLowerCase()))];
}

function isIsoTimestamp(value) {
  const match = ISO_8601.exec(value.replace(/`/g, '').trim());
  if (!match) return false;
  const [, year, month, day, hour = '0', minute = '0', second = '0'] = match;
  const [offsetHour = '0', offsetMinute = '0'] = match.slice(7);
  const monthNumber = Number(month);
  if (monthNumber < 1 || monthNumber > 12 || Number(day) < 1) return false;
  const daysInMonth = new Date(Date.UTC(Number(year), monthNumber, 0)).getUTCDate();
  return (
    Number(day) <= daysInMonth &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(offsetHour) <= 14 &&
    Number(offsetMinute) <= 59
  );
}

function resolveReference(raw, base) {
  let target = raw.trim();
  try {
    target = decodeURI(target);
  } catch {
    // Keep the raw text; it is reported as missing if it does not resolve.
  }
  target = target
    .replace(/#.*$/, '')
    .replace(/:\d+(?:-\d+)?$/, '')
    .replace(/\\/g, '/');
  if (!target) return null;
  if (path.posix.isAbsolute(target) || /^[A-Za-z]:\//.test(target)) return { raw, outside: true };
  const joined = path.posix.normalize(path.posix.join(base, target)).replace(/\/+$/, '');
  if (joined === '..' || joined.startsWith('../')) return { raw, outside: true };
  return { raw, path: joined };
}

/**
 * Evidence references in a cell: Markdown links resolve against the plan's directory,
 * backticked paths against the repository root. External links are not evidence.
 */
function extractEvidencePaths(value, planDir) {
  const references = [];
  const rest = value.replace(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, target) => {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('#')) {
      references.push(resolveReference(target, planDir));
    }
    return ' ';
  });
  for (const match of rest.matchAll(/`([^`]+)`/g)) {
    references.push(resolveReference(match[1], '.'));
  }
  const seen = new Set();
  return references.filter((reference) => {
    if (!reference) return false;
    const key = reference.path ?? `outside:${reference.raw}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Validates parsed plan items.
 *
 * `isAncestor(sha)` says whether the commit is reachable from the modelforge branch;
 * `exists(path)` whether a repository-relative path exists. Returns the violations as
 * `{ item, line, code, reason }`: `item` is the item's 编号 (or `第 N 行` when it has
 * none), `code` a stable machine-readable reason and `reason` the explanation shown to
 * people.
 */
function validatePlan(plan, { isAncestor, exists, planPath = PLAN_PATH }) {
  const violations = [];
  const planDir = path.posix.dirname(planPath);
  if (plan.items.length === 0) {
    violations.push({
      item: planPath,
      line: 0,
      code: 'no-items',
      reason: '没有找到带「编号」列的计划条目表',
    });
  }

  const firstLine = new Map();
  for (const entry of plan.items) {
    const { fields } = entry;
    const id = isBlank(entry.id) ? '' : entry.id;
    const item = id || `第 ${entry.line} 行`;
    const add = (code, reason) => violations.push({ item, line: entry.line, code, reason });

    if (!id) {
      add('missing-id', '缺少编号');
    } else if (firstLine.has(id)) {
      add('duplicate-id', `编号重复（首次出现在第 ${firstLine.get(id)} 行）`);
    } else {
      firstLine.set(id, entry.line);
    }

    for (const key of REQUIRED_FIELDS) {
      if (isBlank(fields[key])) add(`missing-field:${key}`, `缺少字段「${FIELD_LABELS[key]}」`);
    }

    const status = normaliseStatus(fields.status);
    if (!isBlank(status) && !STATUSES.includes(status)) {
      add('invalid-status', `状态「${status}」不在允许取值内（${STATUSES.join('、')}）`);
    }

    if (status === VERIFIED) {
      if (!isBlank(fields.commit)) {
        const shas = extractShas(fields.commit);
        if (shas.length === 0) {
          add('commit-no-sha', '「已验证」条目的源码 commit 须给出至少 7 位的 SHA');
        }
        for (const sha of shas) {
          if (!isAncestor(sha)) {
            add(`commit-unreachable:${sha}`, `commit ${sha} 在 modelforge 分支历史中不可达`);
          }
        }
      }
      if (!isBlank(fields.verifiedAt) && !isIsoTimestamp(fields.verifiedAt)) {
        add('time-not-iso', `验证时间「${fields.verifiedAt}」不是 ISO 8601 格式`);
      }
      if (!isBlank(fields.command) && !/`[^`]+`/.test(fields.command)) {
        add('command-not-copyable', '「已验证」条目的验证命令须用反引号给出可原样执行的命令');
      }
      if (isBlank(fields.environment)) {
        add('missing-field:environment', '「已验证」条目缺少字段「执行环境」');
      } else if (!OS_PATTERN.test(fields.environment) || !ARCH_PATTERN.test(fields.environment)) {
        add(
          'environment-incomplete',
          `执行环境「${fields.environment}」须写明操作系统与架构（如 Windows x64）`
        );
      }
    }

    if (!isBlank(fields.evidence)) {
      const references = extractEvidencePaths(fields.evidence, planDir);
      if (references.length === 0) {
        add(
          'evidence-no-path',
          '证据路径中没有可校验的文件路径（用反引号写仓库相对路径，或写 Markdown 相对链接）'
        );
      }
      for (const reference of references) {
        if (reference.outside) {
          add(`evidence-outside:${reference.raw}`, `证据路径 ${reference.raw} 不在仓库内`);
        } else if (!exists(reference.path)) {
          add(`evidence-missing:${reference.path}`, `证据路径 ${reference.path} 在仓库中不存在`);
        }
      }
    }
  }
  return violations;
}

// --- Conflicting plans -------------------------------------------------------

/**
 * 1-based line of the first "I am the current plan" claim in `text`, or 0. A line that
 * names the plan's file (`OPTIMIZATION_PLAN.md`) points at the plan and is no claim.
 */
function declarationLine(text, planFileName = PLAN_FILE_NAME) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex(
    (line) => PLAN_DECLARATION.test(line) && !line.includes(planFileName)
  );
  return index + 1;
}

/**
 * Paths (sorted) of the files other than the plan that declare themselves the current
 * execution plan. `files` is `[{ path, text }]` with repository-relative paths.
 */
function findConflictingPlanFiles(files, planPath = PLAN_PATH) {
  const planFileName = path.posix.basename(planPath);
  return files
    .filter(
      (file) =>
        file.path.replace(/\\/g, '/') !== planPath &&
        declarationLine(file.text, planFileName) > 0
    )
    .map((file) => file.path)
    .sort();
}

// --- Repository run ----------------------------------------------------------

/** Runs every plan check against a checkout. Reads only. */
function runPlanCheck(options = {}) {
  const repoRoot = options.repoRoot ?? REPO;
  const base = options.base ?? DEFAULT_BASE;
  const planPath = options.planPath ?? PLAN_PATH;
  const git = (args) =>
    execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const fatal = [];

  const planFile = path.join(repoRoot, ...planPath.split('/'));
  if (!fs.existsSync(planFile)) {
    fatal.push(`找不到 ${planPath}`);
    return { planPath, base, items: [], violations: [], conflicts: [], fatal };
  }
  const plan = parsePlan(fs.readFileSync(planFile, 'utf8'));

  let baseResolves = true;
  try {
    git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  } catch {
    baseResolves = false;
  }
  const hasVerified = plan.items.some((item) => normaliseStatus(item.fields.status) === VERIFIED);
  if (!baseResolves && hasVerified) {
    fatal.push(
      `无法解析 ${base}，不能判断「已验证」条目的 commit 是否可达` +
        '（CI 的 checkout 需要 fetch-depth: 0，并拉取 modelforge 分支）'
    );
  }
  const isAncestor = (sha) => {
    if (!baseResolves) return true;
    try {
      git(['merge-base', '--is-ancestor', sha, base]);
      return true;
    } catch {
      return false;
    }
  };
  const exists = (relative) => fs.existsSync(path.join(repoRoot, ...relative.split('/')));
  const violations = validatePlan(plan, { isAncestor, exists, planPath });

  const files = git(['ls-files', '-z', '--', '*.md', '*.mdx'])
    .split('\0')
    .filter((file) => file && exists(file))
    .map((file) => ({ path: file, text: fs.readFileSync(path.join(repoRoot, file), 'utf8') }));
  const planFileName = path.posix.basename(planPath);
  const conflicts = findConflictingPlanFiles(files, planPath).map((file) => ({
    path: file,
    line: declarationLine(files.find((candidate) => candidate.path === file).text, planFileName),
  }));

  return { planPath, base, items: plan.items, violations, conflicts, fatal };
}

/** Human-readable report lines and the number of failures. */
function formatPlanReport(result) {
  const lines = [];
  const failures = result.fatal.length + result.violations.length + result.conflicts.length;
  lines.push(`plan ${result.planPath}: ${result.items.length} item(s), base ${result.base}`);
  for (const problem of result.fatal) lines.push(`  ERROR     ${problem}`);
  for (const violation of result.violations) {
    lines.push(`  FAIL      ${violation.item}  ${violation.reason}`);
  }
  for (const conflict of result.conflicts) {
    lines.push(
      `  CONFLICT  ${conflict.path}:${conflict.line}  声明自己是当前执行计划；` +
        `唯一执行计划是 ${result.planPath}，请改为指向它`
    );
  }
  if (failures === 0) {
    lines.push('  ok — every item is complete and no other file claims to be the plan');
  }
  return { lines, failures };
}

function main() {
  const baseIndex = process.argv.indexOf('--base');
  const base = baseIndex > 0 ? process.argv[baseIndex + 1] : DEFAULT_BASE;
  if (!base || base.startsWith('-')) {
    console.error('usage: node scripts/plan-check.js [--base <ref>]');
    process.exitCode = 2;
    return;
  }
  const { lines, failures } = formatPlanReport(runPlanCheck({ base }));
  for (const line of lines) console.log(line);
  if (failures) {
    console.log(`\n${failures} plan problem(s) found`);
    process.exitCode = 1;
  }
}

module.exports = {
  PLAN_PATH,
  STATUSES,
  REQUIRED_FIELDS,
  parsePlan,
  validatePlan,
  findConflictingPlanFiles,
  declarationLine,
  extractEvidencePaths,
  isIsoTimestamp,
  runPlanCheck,
  formatPlanReport,
};

if (require.main === module) main();

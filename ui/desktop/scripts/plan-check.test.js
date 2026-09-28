// @vitest-environment node
import { createRequire } from 'node:module';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../src/test/pbt';

// The script under test is CommonJS (it runs as a plain `node` script in CI).
const requireCjs = createRequire(import.meta.url);
const { PLAN_PATH, STATUSES, findConflictingPlanFiles, parsePlan, validatePlan } =
  requireCjs('./plan-check.js');

const VERIFIED = '已验证';
const REQUIRED = ['owner', 'status', 'commit', 'verifiedAt', 'command', 'evidence', 'risk'];

/** Header spellings the plan uses (or could reasonably use) for each column. */
const HEADER_LABELS = {
  id: ['编号', '#'],
  title: ['项', '项（位置；备注）'],
  owner: ['owner', 'Owner'],
  status: ['状态'],
  commit: ['源码 commit', '源码commit', '源码 Commit'],
  verifiedAt: ['验证时间'],
  command: ['验证命令'],
  environment: ['执行环境'],
  evidence: ['证据路径'],
  risk: ['剩余风险'],
};
const COLUMN_KEYS = Object.keys(HEADER_LABELS);

// --- Cell generators -----------------------------------------------------------
//
// Each generator returns `{ cell, ...facts }`: `cell` is the Markdown written into the
// table, the facts are what the model below needs to know about it. The model never
// looks at `cell`, so the expected violations do not depend on how plan-check parses.

const placeholder = fc.constantFrom('', '-', '—', 'TBD', '待定', '`-`', 'n/a');
const blankCell = placeholder.map((cell) => ({ cell, blank: true }));
const textCell = (values) =>
  fc.oneof(
    { weight: 4, arbitrary: fc.constantFrom(...values).map((cell) => ({ cell, blank: false })) },
    { weight: 1, arbitrary: blankCell }
  );

const ownerCell = textCell(['leozer534-coder', 'alice', '维护者甲']);
const riskCell = textCell(['无已知风险', 'Windows 上未实跑', '尚未合入 modelforge']);

const statusCell = fc.oneof(
  {
    weight: 6,
    arbitrary: fc
      .tuple(fc.constantFrom(...STATUSES, VERIFIED, VERIFIED), fc.boolean())
      .map(([status, bold]) => ({ cell: bold ? `**${status}**` : status, blank: false, status })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('完成', 'done', '已验证✅', '验证中', 'Verified')
      .map((status) => ({ cell: status, blank: false, status })),
  },
  { weight: 1, arbitrary: blankCell.map((value) => ({ ...value, status: '' })) }
);

const hexDigit = fc.constantFrom(...'0123456789abcdef');
const sha = fc.string({ unit: hexDigit, minLength: 7, maxLength: 12 });
const commitCell = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.uniqueArray(sha, { minLength: 1, maxLength: 2 }).map((shas) => ({
      cell: shas.length === 1 ? `\`${shas[0]}\`` : `\`${shas[0]}\`（配套 \`${shas[1]}\`）`,
      blank: false,
      shas,
    })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('无（未开始）', '尚未提交', '见 §7 变更记录')
      .map((cell) => ({ cell, blank: false, shas: [] })),
  },
  { weight: 1, arbitrary: blankCell.map((value) => ({ ...value, shas: [] })) }
);

const isoDate = fc
  .tuple(
    fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2099-12-31T23:59:59Z'),
      noInvalidDate: true,
    }),
    fc.constantFrom('date', 'full', 'seconds', 'offset')
  )
  .map(([date, form]) => {
    const full = date.toISOString();
    if (form === 'date') return full.slice(0, 10);
    if (form === 'seconds') return full.replace(/\.\d+Z$/, 'Z');
    if (form === 'offset') return full.replace(/\.\d+Z$/, '+08:00');
    return full;
  });
const timeCell = fc.oneof(
  { weight: 4, arbitrary: isoDate.map((cell) => ({ cell, blank: false, iso: true })) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom(
        '2026-13-01',
        '2026-02-30',
        '2026/09/16',
        '2026-9-16',
        '2026-09-16 08:00',
        '2026-09-16T25:00:00Z',
        '昨天'
      )
      .map((cell) => ({ cell, blank: false, iso: false })),
  },
  { weight: 1, arbitrary: blankCell.map((value) => ({ ...value, iso: false })) }
);

const commandCell = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .constantFrom('`pnpm run test:run`（`ui/desktop/`）', '`cargo test -p goose`')
      .map((cell) => ({ cell, blank: false, copyable: true })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('跑一遍测试', 'run the tests')
      .map((cell) => ({ cell, blank: false, copyable: false })),
  },
  { weight: 1, arbitrary: blankCell.map((value) => ({ ...value, copyable: false })) }
);

const environmentCell = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .constantFrom('Windows x64', 'GitHub Actions：Linux x64', 'macOS arm64', 'Ubuntu amd64')
      .map((cell) => ({ cell, blank: false, complete: true })),
  },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom('Windows', 'Linux', 'macOS 15', 'x64', 'arm64')
      .map((cell) => ({ cell, blank: false, complete: false })),
  },
  { weight: 1, arbitrary: blankCell.map((value) => ({ ...value, complete: false })) }
);

/** One evidence reference; `slot` keeps paths distinct within a plan. */
const evidenceRef = fc.record({
  form: fc.constantFrom('backtick', 'link', 'outside-absolute', 'outside-link'),
  exists: fc.boolean(),
  line: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
});
const evidenceCell = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .array(evidenceRef, { minLength: 1, maxLength: 3 })
      .map((refs) => ({ blank: false, refs })),
  },
  { weight: 1, arbitrary: fc.constant({ blank: false, refs: [], cell: '见 §7 变更记录' }) },
  { weight: 1, arbitrary: blankCell.map((value) => ({ ...value, refs: [] })) }
);

const idKind = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ kind: 'fresh' }) },
  { weight: 1, arbitrary: fc.nat().map((of) => ({ kind: 'duplicate', of })) },
  { weight: 1, arbitrary: placeholder.map((cell) => ({ kind: 'blank', cell })) }
);

const itemArb = fc.record({
  id: idKind,
  title: fc.constantFrom('修复保存链路', '规格任务 5', '已验证的旧项'),
  owner: ownerCell,
  status: statusCell,
  commit: commitCell,
  verifiedAt: timeCell,
  command: commandCell,
  environment: environmentCell,
  evidence: evidenceCell,
  risk: riskCell,
});

/** A plan table: column order, header spellings, which optional/required columns exist. */
const tableArb = fc.record({
  items: fc.array(itemArb, { maxLength: 5 }),
  order: fc.shuffledSubarray(COLUMN_KEYS.filter((key) => key !== 'id'), {
    minLength: COLUMN_KEYS.length - 1,
    maxLength: COLUMN_KEYS.length - 1,
  }),
  dropped: fc.subarray(COLUMN_KEYS.filter((key) => key !== 'id'), { maxLength: 2 }),
  labels: fc.record(
    Object.fromEntries(COLUMN_KEYS.map((key) => [key, fc.constantFrom(...HEADER_LABELS[key])]))
  ),
});

const planArb = fc.record({
  tables: fc.array(tableArb, { minLength: 1, maxLength: 3 }),
  reachable: fc.uniqueArray(sha, { maxLength: 6 }),
  decoys: fc.boolean(),
});

// --- Rendering -----------------------------------------------------------------

/** Writes the plan's Markdown and returns it with the model's view of every row. */
function renderPlan(plan) {
  const lines = ['# ModelForge 优化计划', '', '> 唯一执行计划。', ''];
  const rows = [];
  const existing = new Set();
  let slot = 0;

  if (plan.decoys) {
    // A table in a fenced block and a table without an 编号 column are not plan items.
    lines.push('```md', '| 编号 | owner |', '|---|---|', '| FAKE-1 | - |', '```', '');
    lines.push('| 日期 | 变更 |', '|---|---|', '| 2026-09-16 | 已验证 P0-1 |', '');
  }

  for (const table of plan.tables) {
    const columns = ['id', ...table.order.filter((key) => !table.dropped.includes(key))];
    lines.push(`| ${columns.map((key) => table.labels[key]).join(' | ')} |`);
    lines.push(`|${columns.map(() => '------').join('|')}|`);
    for (const item of table.items) {
      const index = rows.length;
      let id;
      if (item.id.kind === 'fresh') id = `T-${index}`;
      else if (item.id.kind === 'blank') id = item.id.cell;
      else {
        const earlier = rows.filter((row) => row.idBlank === false);
        id = earlier.length ? earlier[item.id.of % earlier.length].id : `T-${index}`;
      }
      const idBlank = item.id.kind === 'blank';

      const refs = item.evidence.refs.map((ref) => {
        const name = `ev-${slot++}`;
        const suffix = ref.line ? `:${ref.line}` : '';
        switch (ref.form) {
          case 'backtick': {
            const target = `src/${name}.ts`;
            if (ref.exists) existing.add(target);
            return { text: `\`${target}${suffix}\``, path: target, exists: ref.exists };
          }
          case 'link': {
            // Links are relative to docs/plan/.
            const target = `docs/reports/${name}.md`;
            if (ref.exists) existing.add(target);
            return { text: `[记录](../reports/${name}.md)`, path: target, exists: ref.exists };
          }
          case 'outside-absolute':
            return { text: `\`/etc/${name}\``, outside: `/etc/${name}` };
          default:
            return { text: `[外部](../../../${name}.md)`, outside: `../../../${name}.md` };
        }
      });
      const evidence = item.evidence.cell ?? refs.map((ref) => ref.text).join('、');

      const cells = {
        id,
        title: item.title,
        owner: item.owner.cell,
        status: item.status.cell,
        commit: item.commit.cell,
        verifiedAt: item.verifiedAt.cell,
        command: item.command.cell,
        environment: item.environment.cell,
        evidence,
        risk: item.risk.cell,
      };
      lines.push(`| ${columns.map((key) => cells[key]).join(' | ')} |`);
      rows.push({ id, idBlank, line: lines.length, item, refs, present: new Set(columns) });
    }
    lines.push('');
  }

  lines.push('## 7. 变更记录', '', '| 日期 | 变更 | 备注 |', '|---|---|---|', '| a | b | c |');
  return { markdown: lines.join('\n'), rows, existing };
}

// --- Model -----------------------------------------------------------------------

/** The violations requirement 24.1/24.2/24.5 prescribes for the rendered rows. */
function expectedViolations(rows, reachable) {
  if (rows.length === 0) return [`0\u0000${PLAN_PATH}\u0000no-items`];
  const expected = [];
  const seen = new Set();
  for (const row of rows) {
    const label = row.idBlank ? `第 ${row.line} 行` : row.id;
    const add = (code) => expected.push(`${row.line}\u0000${label}\u0000${code}`);
    const { item } = row;
    const blank = (key) => !row.present.has(key) || item[key].blank;

    if (row.idBlank) add('missing-id');
    else if (seen.has(row.id)) add('duplicate-id');
    else seen.add(row.id);

    for (const key of REQUIRED) if (blank(key)) add(`missing-field:${key}`);

    const status = blank('status') ? '' : item.status.status;
    if (status && !STATUSES.includes(status)) add('invalid-status');

    if (status === VERIFIED) {
      if (!blank('commit')) {
        if (item.commit.shas.length === 0) add('commit-no-sha');
        for (const commit of item.commit.shas) {
          if (!reachable.has(commit)) add(`commit-unreachable:${commit}`);
        }
      }
      if (!blank('verifiedAt') && !item.verifiedAt.iso) add('time-not-iso');
      if (!blank('command') && !item.command.copyable) add('command-not-copyable');
      if (blank('environment')) add('missing-field:environment');
      else if (!item.environment.complete) add('environment-incomplete');
    }

    if (!blank('evidence')) {
      if (row.refs.length === 0) add('evidence-no-path');
      for (const ref of row.refs) {
        if (ref.outside) add(`evidence-outside:${ref.outside}`);
        else if (!ref.exists) add(`evidence-missing:${ref.path}`);
      }
    }
  }
  return expected.sort();
}

const asKeys = (violations) =>
  violations
    .map((violation) => `${violation.line}\u0000${violation.item}\u0000${violation.code}`)
    .sort();

// Feature: mathmodel-parity-and-beyond, Property 53: 执行计划校验
describe('Property 53: 执行计划校验', () => {
  it('reports exactly the items and reasons that violate requirement 24', () => {
    fc.assert(
      fc.property(planArb, (plan) => {
        const { markdown, rows, existing } = renderPlan(plan);
        const reachable = new Set(plan.reachable);
        const parsed = parsePlan(markdown);

        // Every rendered row, and only those, is read back as an item on its own line.
        expect(parsed.items.map((item) => item.line)).toEqual(rows.map((row) => row.line));

        const violations = validatePlan(parsed, {
          isAncestor: (commit) => reachable.has(commit),
          exists: (relative) => existing.has(relative),
        });
        expect(asKeys(violations)).toEqual(expectedViolations(rows, reachable));
        for (const violation of violations) expect(violation.reason).toMatch(/\S/);
      }),
      pbtParams
    );
  });

  it('passes a plan whose items are complete', () => {
    const complete = fc.record({
      id: fc.constant({ kind: 'fresh' }),
      title: fc.constant('规格任务 5'),
      owner: fc.constant({ cell: 'leozer534-coder', blank: false }),
      status: fc
        .tuple(fc.constantFrom(...STATUSES), fc.boolean())
        .map(([status, bold]) => ({ cell: bold ? `**${status}**` : status, blank: false, status })),
      commit: fc.uniqueArray(sha, { minLength: 1, maxLength: 2 }).map((shas) => ({
        cell: shas.map((commit) => `\`${commit}\``).join('、'),
        blank: false,
        shas,
      })),
      verifiedAt: isoDate.map((cell) => ({ cell, blank: false, iso: true })),
      command: fc.constant({ cell: '`pnpm run test:run`', blank: false, copyable: true }),
      environment: fc.constant({ cell: 'Windows x64', blank: false, complete: true }),
      evidence: fc
        .array(
          fc.record({
            form: fc.constantFrom('backtick', 'link'),
            exists: fc.constant(true),
            line: fc.option(fc.integer({ min: 1, max: 999 }), { nil: null }),
          }),
          { minLength: 1, maxLength: 3 }
        )
        .map((refs) => ({ blank: false, refs })),
      risk: fc.constant({ cell: '无已知风险', blank: false }),
    });
    fc.assert(
      fc.property(fc.array(complete, { minLength: 1, maxLength: 6 }), (items) => {
        const { markdown, rows, existing } = renderPlan({
          tables: [{ items, order: COLUMN_KEYS.slice(1), dropped: [], labels: firstLabels() }],
          reachable: [],
          decoys: true,
        });
        const shas = new Set(rows.flatMap((row) => row.item.commit.shas));
        const violations = validatePlan(parsePlan(markdown), {
          isAncestor: (commit) => shas.has(commit),
          exists: (relative) => existing.has(relative),
        });
        expect(violations).toEqual([]);
      }),
      pbtParams
    );
  });
});

function firstLabels() {
  return Object.fromEntries(COLUMN_KEYS.map((key) => [key, HEADER_LABELS[key][0]]));
}

// --- Conflicting plans (requirement 24.7) ----------------------------------------

const plainLine = fc.constantFrom(
  '执行流水见 EXECUTION_LOG.md',
  'Week 2 启动计划',
  'Day 1 执行计划',
  '计划源见 [OPTIMIZATION_PLAN.md](OPTIMIZATION_PLAN.md)',
  'The plan became the source of truth.',
  '这里只记录背景。'
);
const declaringLine = fc.constantFrom(
  '本文件是当前执行计划。',
  '> 这是唯一执行计划',
  '唯一计划源（SOT）',
  '当前的执行计划如下',
  'This is the current execution plan.',
  'THE CURRENT EXECUTION PLAN'
);
const pointingLine = fc.constantFrom(
  '当前执行计划见 [OPTIMIZATION_PLAN.md](docs/plan/OPTIMIZATION_PLAN.md)',
  '唯一执行计划是 docs/plan/OPTIMIZATION_PLAN.md，本文只作背景'
);
const fileLines = fc.array(
  fc.oneof(
    { weight: 4, arbitrary: plainLine.map((text) => ({ text, declares: false })) },
    { weight: 1, arbitrary: declaringLine.map((text) => ({ text, declares: true })) },
    { weight: 1, arbitrary: pointingLine.map((text) => ({ text, declares: false })) }
  ),
  { maxLength: 6 }
);

describe('Property 53: 执行计划校验（冲突计划文件）', () => {
  it('lists exactly the other files that declare themselves the current plan', () => {
    fc.assert(
      fc.property(
        fc.array(fileLines, { maxLength: 8 }),
        fileLines,
        fc.boolean(),
        (others, planLines, windowsPath) => {
          const files = others.map((lines, index) => ({
            path: `docs/note-${index}.md`,
            text: lines.map((line) => line.text).join('\n'),
          }));
          // The plan itself may say anything about itself.
          files.push({
            path: windowsPath ? PLAN_PATH.replace(/\//g, '\\') : PLAN_PATH,
            text: ['本文件是当前执行计划', ...planLines.map((line) => line.text)].join('\n'),
          });
          const expected = others
            .map((lines, index) => ({ path: `docs/note-${index}.md`, lines }))
            .filter(({ lines }) => lines.some((line) => line.declares))
            .map(({ path }) => path)
            .sort();
          expect(findConflictingPlanFiles(files)).toEqual(expected);
        }
      ),
      pbtParams
    );
  });
});

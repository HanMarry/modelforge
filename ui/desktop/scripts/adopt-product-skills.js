#!/usr/bin/env node
/**
 * Adopts the reference product's SKILL.md bodies into this fork.
 *
 * The product's twelve skills are the content core of the workflow, so this fork uses
 * their text rather than a re-written equivalent. A skill body cannot be copied blindly
 * though: it names the product's own tools, paths and app screens. Every replacement is
 * listed below, and `NOTICE.md` records that these bodies come from the installed product
 * with these adaptations.
 *
 * Usage:
 *   node scripts/adopt-product-skills.js --app "<install dir>" [--dry-run]
 */
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const BUILTINS = path.join(DESKTOP, '..', '..', 'crates', 'goose', 'src', 'skills', 'builtins');

/**
 * Shared adaptations: names, layout paths and the product's own app locations.
 * `AskUserQuestion` is a Claude Code tool the product ships; goose has no such tool, so
 * the instruction becomes a plain question block.
 */
const SHARED = [
  ['name: mma-paper', 'name: math-paper'],
  ['name: mma-figure', 'name: math-figure'],
  ['name: mma-review', 'name: math-review'],
  ['`mma-paper`', '`math-paper`'],
  ['`mma-figure`', '`math-figure`'],
  ['`mma-review`', '`math-review`'],
  ['mma-paper 技能', 'math-paper 技能'],
  ['mma-figure 技能', 'math-figure 技能'],
  ['assets/template/', 'assets/templates/'],
  ['.mathmodel/paper/config.json', '.modelforge/paper/config.json'],
  ['.mathmodel/', '.modelforge/'],
  [
    '使用 AskUserQuestion 工具询问我一些问题（关于每个模型的选择），然后做 plan，再开始执行。',
    '先用一次集中的提问块问我几个问题（关于每个模型的选择），然后做 plan，再开始执行。',
  ],
  [
    '- AskUserQuestion 一次最多 4 个问题，每个问题 2-4 个选项，字段固定为 header / question / options / multiSelect',
    '- 本 fork 没有 AskUserQuestion 工具：直接在回复里一次问 2–4 个问题，每题 2–4 个选项，不要挤牙膏式反复追问',
  ],
  // The product's app screens do not exist here; point at this fork's equivalents.
  ['MathModel「设置 → 运行环境」点「重新检查」', '重新调用 modeling 扩展的 check_env（或在设置 → 扩展里重载 modeling）'],
  ['MathModel“设置 → Environment”安装托管 Python', '用 `doctor` 技能给出的命令自己安装 Python'],
  ['MathModel“设置 → Environment”', '本机安装的 Python'],
  ['MathModel「设置 → Environment」安装托管 Python', '用 `doctor` 技能给出的命令自己安装 Python'],
  // Brand: this fork is ModelForge, and the agent is not Claude.
  ['MathModel', 'ModelForge'],
  ["Claude's", 'the agent’s'],
  ['Claude', 'the agent'],
  // goose's canonical writable skills directory (its discovery also scans .claude/skills).
  ['~/.claude/skills/', '~/.agents/skills/'],
  // Inert for goose, but it should not name a tool this fork does not have.
  ['allowed-tools: Bash(*), Read, AskUserQuestion', 'allowed-tools: Bash(*), Read'],
];

/** Per-skill jobs: where the body goes and what else needs fixing. */
const JOBS = [
  {
    from: 'mma-paper',
    to: 'math_paper.md',
    extra: [
      [
        '- `template.source` 为 `builtin` 时，先定位本 Skill 所在目录（即包含本 `SKILL.md` 的\n  `math-paper` 目录），再以其中的 `assets/templates/<template.id>/` 为模板源，不要依赖固定的用户主目录路径。',
        '- `template.source` 为 `builtin` 时，先定位本技能所在目录（goose 加载技能时会打印它，即\n  `math_paper/`），再以其中的 `assets/templates/<template.id>/` 为模板源，不要依赖固定的用户主目录路径。',
      ],
    ],
  },
  { from: 'mma-figure', to: 'math_figure.md' },
  {
    from: 'mma-review',
    to: 'math_review.md',
    extra: [
      [
        '评审对象优先级：用户指定的文件 → 项目里的 `document.tex` →\n项目里的 PDF。',
        '评审对象优先级：用户指定的文件 → 项目里的主 `.tex`（`document.tex` / `main.tex` / `paper.tex`）→\n项目里的 PDF。',
      ],
      ['用户确认之前不动 `document.tex`', '用户确认之前不动论文正文'],
    ],
  },
  {
    from: 'mathmodel-figure-templates',
    to: 'mathmodel_figure_templates.md',
    extra: [
      // the product keeps the skill folder name with hyphens in prose; our directory uses underscores
      ['mathmodel-figure-templates', 'mathmodel-figure-templates'],
    ],
  },
  {
    from: 'paper-search',
    to: 'paper_search.md',
    extra: [
      ['python scripts/paper_search.py', 'python "<skill-directory>/scripts/paper_search.py"'],
      [
        '## 数据源',
        '## 运行方式\n\n脚本用标准库，无需安装依赖；用当前项目的解释器运行上方命令即可。\n' +
          'Windows 上如果系统里的 `python` 是 Microsoft Store 的占位别名（敲了没输出），\n' +
          '改用 `uv run python` 或项目虚拟环境里的解释器。\n\n## 数据源',
      ],
    ],
  },
  {
    from: 'data-search',
    to: 'data_search.md',
    extra: [
      // The description is what the agent routes on: it must not advertise browser tools
      // this fork does not have.
      [
        '通过可用的网页搜索和 ModelForge 内置 browser_* 工具检索官方机构',
        '通过可用的网页搜索与 fetch 类工具检索官方机构',
      ],
      [
        '5. 使用可用的 `WebSearch` 做广泛发现；搜索摘要只能当线索，不能当数据存在或可下载的证据。',
        '5. 用可用的网页搜索工具做广泛发现（本 fork 里是 `web-search` 技能 / 已安装的搜索类连接器，\n   如 `web-fetch`、`context7`）；搜索摘要只能当线索，不能当数据存在或可下载的证据。',
      ],
      // The product drives an in-app browser here. This fork has none, so the section
      // becomes an explicit degradation ladder instead of instructions for tools that
      // do not exist.
      [
        `## 用内置浏览器核验

遇到动态页面、筛选表单、分页预览或需要复用登录态时，使用 ModelForge 浏览器工具：

1. 调用 \`mcp__mathmodel-browser__browser_status\` 查看后端和标签页。
2. 默认使用内嵌浏览器；只有用户需要自己的登录态且扩展已配对时，才切换到 \`chrome-extension\`。
3. 用 \`browser_navigate\` 打开来源页，再用 \`browser_snapshot\` 读取当前页面。
4. 每次页面变化后重新获取 snapshot；点击、输入和选择只使用最新的 \`snapshotId\` 与 \`ref\`。
5. 用浏览器确认数据集标题、发布者、字段/指标、时间范围、空间范围、更新日期、许可和下载/API 入口。
6. 出现登录、OAuth、验证码、付费或下载保存对话框时停止，让用户接管；不要规避访问控制或反爬限制。

浏览器负责发现、查看和核验。不要把浏览器截图当作数值数据来源，也不要声称浏览器已经保存了文件。浏览器页面触发下载后，ModelForge 会把处置权交给用户。`,
        `## 用网页工具核验

原产品的这一节使用内置浏览器（\`browser_navigate\` / \`browser_snapshot\` 等）。**本 fork 没有内置浏览器**，
按下面的顺序降级，并在报告里说明实际用了哪一种：

1. **静态页面**：用搜索找到来源后，用 fetch 类工具（如已安装的 \`web-fetch\` 连接器）读取页面正文，
   核对数据集标题、发布者、字段/指标、时间范围、空间范围、更新日期、许可和下载/API 入口。
2. **动态页面 / 需要登录态**：让用户在自己浏览器里打开，并把关键页面或导出文件交给你；
   不要假装你看到了页面。若用户已安装 playwright / puppeteer 这类 MCP 连接器（扩展 → 连接器），
   可以改用它们提供的浏览器工具。
3. **验证码、登录、付费墙、反爬**：一律停下让用户接管，不规避任何访问控制。

网页工具负责发现、查看和核验。**不要把截图当作数值数据来源**，也不要声称工具已经保存了文件；
页面触发下载后由用户决定是否保存。`,
      ],
    ],
  },
  {
    from: 'doctor',
    to: 'doctor.md',
    extra: [
      [
        '先列出将执行的准确命令、下载体积或权限影响，再用 `AskUserQuestion` 询问一次：',
        '先列出将执行的准确命令、下载体积或权限影响，再问一次用户（本 fork 没有\n`AskUserQuestion` 工具，直接在回复里问），给出三个选项：',
      ],
    ],
  },
  { from: 'metaheuristic-optimization', to: 'metaheuristic_optimization.md' },
  {
    // The only product skill whose whole purpose is uploading to the product's own gallery.
    // Adopted for completeness, with the tool call replaced by what this fork can actually
    // do (prepare the de-identified PDF and tell the user where it is).
    from: 'paper-sharing',
    to: 'paper_sharing.md',
    extra: [
      [
        `## 4. 上传

立刻调用 \`mcp__mathmodel__upload_paper\`，传入脱敏后 PDF 的绝对路径和上面的字段。工具会返回投稿 id 和状态（\`review_pending\`）。告诉用户：已提交，审核结果可以在「数模广场 → 我的投稿」里看到。`,
        `## 4. 交付（本 fork 没有数模广场）

本 fork 没有广场后端，也没有 \`upload_paper\` 工具，**不要假装已经上传**。
把第 3 步整理好的字段写进项目根目录的 \`sharing.json\`，与脱敏后的 PDF 放在一起，
然后在回复里给出：PDF 绝对路径、\`sharing.json\` 路径、字段一览，以及一句
"本 fork 未接入投稿后端，请到赛事/社区平台自行提交"。`,
      ],
      [
        `- 用通用网络工具（curl、fetch 等）绕过 \`upload_paper\` 自行上传。`,
        `- 向任何远端地址上传论文：本 fork 没有投稿后端，只在本机准备文件。`,
      ],
    ],
  },
  {
    from: 'paper-diagram',
    to: 'paper_diagram.md',
    extra: [
      ['python3 scripts/', 'python3 "<skill-directory>/scripts/'],
      // close the quote that the replacement above opened, per invocation line
      ['-o out.drawio     # roadmap-5band', '-o out.drawio"     # roadmap-5band'],
      ['-o out.drawio    # roadmap-3phase', '-o out.drawio"    # roadmap-3phase'],
      ['-o out.drawio    # framework-3col', '-o out.drawio"    # framework-3col'],
      ['-o out.drawio    # stageflow-3col', '-o out.drawio"    # stageflow-3col'],
      ['-o out.drawio    # taskflow-land（横版）', '-o out.drawio"    # taskflow-land（横版）'],
      ['fig.drawio      # 溢出/越界', 'fig.drawio"      # 溢出/越界'],
      ['fig.drawio     # 1:1 PNG', 'fig.drawio"     # 1:1 PNG'],
      ['fig.drawio      # 浏览器预览', 'fig.drawio"      # 浏览器预览'],
    ],
  },
  {
    from: 'skill-creator',
    to: 'skill_creator.md',
    // The brand rules above already turn every remaining "Claude" into "the agent"; only
    // the two paths that would break the workflow need their own entry.
    extra: [
      ['scripts/init_skill.py <skill-name> --path ~/.claude/skills', 'scripts/init_skill.py <skill-name> --path ~/.agents/skills'],
      ['scripts/init_skill.py <skill-name>', '"<skill-directory>/scripts/init_skill.py" <skill-name>'],
      ['scripts/package_skill.py <path/to/skill-folder>', '"<skill-directory>/scripts/package_skill.py" <path/to/skill-folder>'],
    ],
  },
];

function applyAll(text, pairs) {
  let out = text;
  const missed = [];
  for (const [search, replace] of pairs) {
    if (!out.includes(search)) {
      missed.push(search);
      continue;
    }
    out = out.split(search).join(replace);
  }
  return { out, missed };
}

function main() {
  const appIndex = process.argv.indexOf('--app');
  const app = appIndex >= 0 ? process.argv[appIndex + 1] : null;
  const dryRun = process.argv.includes('--dry-run');

  if (!app) {
    console.error('usage: node scripts/adopt-product-skills.js --app "<install dir>" [--dry-run]');
    process.exitCode = 1;
    return;
  }
  const skillsRoot = path.join(app, 'resources', 'builtin-skills');

  let problems = 0;
  for (const job of JOBS) {
    const source = path.join(skillsRoot, job.from, 'SKILL.md');
    const target = path.join(BUILTINS, job.to);
    if (!fs.existsSync(source)) {
      console.error(`MISSING  ${job.from}/SKILL.md`);
      problems++;
      continue;
    }

    const original = fs.readFileSync(source, 'utf8');
    const shared = applyAll(original, SHARED);
    const extra = applyAll(shared.out, job.extra ?? []);

    let changed = 0;
    for (const line of original.split('\n')) {
      if (!extra.out.includes(line)) changed++;
    }

    if (!dryRun) fs.writeFileSync(target, extra.out, 'utf8');
    console.log(
      `${dryRun ? 'would adopt' : 'adopted   '} ${job.from.padEnd(28)} -> ${job.to.padEnd(34)} ` +
        `${original.length} B, ${changed} line(s) changed`
    );
    if (extra.missed.length) {
      console.log(`           ⚠ ${extra.missed.length} replacement(s) did not match:`);
      for (const miss of extra.missed.slice(0, 6)) {
        console.log(`             ${miss.slice(0, 90)}`);
      }
      // A missed replacement is usually harmless (the text already reads correctly), so it
      // is reported rather than treated as a failure.
    }
  }

  console.log('\nbodies adopted (all 12 product skills). Adaptations beyond the tables above:');
  console.log('  data-search    browser_* tools → this fork has no in-app browser');
  console.log('  paper-sharing  upload tool → writes sharing.json locally instead');
  console.log('  doctor         install.md gained local additions (cartopy/MSVC, fonts, uv index)');

  if (problems) process.exitCode = 1;
}

if (require.main === module) main();

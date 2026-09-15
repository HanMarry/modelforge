#!/usr/bin/env node
/**
 * Cross-checks the numbers quoted in the project documentation against the actual
 * files in the repository.
 *
 * The docs were written across many sessions, so counts drift: a table says "13
 * templates" after a 14th was added, a skill count appears in three files and only
 * two were updated. This script derives every count from the filesystem and fails if
 * any document disagrees.
 *
 * Usage: node scripts/docs-check.js
 */
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.join(DESKTOP, '..', '..');
const BUILTINS = path.join(REPO, 'crates', 'goose', 'src', 'skills', 'builtins');

// --- Derived counts ---------------------------------------------------------

function countSkills() {
  return fs.readdirSync(BUILTINS).filter((name) => name.endsWith('.md')).length;
}

function countFigureTemplates() {
  const root = path.join(BUILTINS, 'math_figure', 'assets', 'templates');
  return walkFiles(root).filter((file) => file.endsWith('.py') && path.basename(file) !== '_style.py')
    .length;
}

function countMathmodelTemplates() {
  const root = path.join(BUILTINS, 'mathmodel_figure_templates', 'scripts', 'templates');
  return fs.existsSync(root)
    ? fs.readdirSync(root).filter((name) => name.startsWith('make_') && name.endsWith('.py')).length
    : 0;
}

function countOwnFigureTemplates() {
  const root = path.join(BUILTINS, 'math_figure', 'assets', 'templates');
  return walkFiles(root).filter((file) => file.endsWith('.py') && path.basename(file) !== '_style.py')
    .length;
}

function countPaperDirectories() {
  const root = path.join(BUILTINS, 'math_paper', 'assets', 'templates');
  return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
}

function countFigurePreviews() {
  return fs.existsSync(path.join(DESKTOP, 'src', 'assets', 'figures'))
    ? walkFiles(path.join(DESKTOP, 'src', 'assets', 'figures')).filter((f) => f.endsWith('.png')).length
    : 0;
}

function countPaperTemplateDirs() {
  const root = path.join(BUILTINS, 'math_paper', 'assets', 'templates');
  return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function countPaperCompilable() {
  const root = path.join(BUILTINS, 'math_paper', 'assets', 'templates');
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      // Templates disagree on the entry-file name: paper.tex, main.tex and document.tex
      // all occur, and the Typst one uses paper.typ.
      const dir = path.join(root, entry.name);
      return ['paper.tex', 'main.tex', 'document.tex', 'paper.typ', 'main.typ'].some((name) =>
        fs.existsSync(path.join(dir, name))
      );
    }).length;
}

function countSampleProblems() {
  const root = path.join(BUILTINS, 'math_modeling', 'assets', 'samples');
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'problem.md'))).length;
}

function countConnectors() {
  const source = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'connectors.ts'), 'utf8');
  const count = (pattern) => (source.match(pattern) || []).length;
  return {
    entries: count(/^    id: '/gm),
    installed: count(/status: 'installed'/g),
    installable: count(/status: 'installable'/g),
    planned: count(/status: 'planned'/g),
  };
}

function countAlgorithms() {
  const source = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'algorithms.ts'), 'utf8');
  return (source.match(/^    id: '/gm) || []).length;
}

function countFigureCatalog() {
  const source = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'figures.ts'), 'utf8');
  return {
    entries: (source.match(/^    id: '/gm) || []).length,
    available: (source.match(/available: true,/g) || []).length,
    // Entries with no rendered preview yet (currently the two cartopy templates that need
    // the MSVC build tools). Expected to be small and explicit, not silent placeholders.
    withoutPreview: (source.match(/available: false,/g) || []).length,
  };
}

function countPaperCatalog() {
  const source = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'papers.ts'), 'utf8');
  return {
    entries: (source.match(/^    directory: '/gm) || []).length,
    available: (source.match(/available: true,/g) || []).length,
  };
}

function countI18nMessages() {
  const en = JSON.parse(
    fs.readFileSync(path.join(DESKTOP, 'src', 'i18n', 'messages', 'en.json'), 'utf8')
  );
  return Object.keys(en).length;
}

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') continue;
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

// --- Asset references --------------------------------------------------------

/**
 * Checks that the paths the skills, the catalogues and the home presets point at actually
 * exist. This is the class of bug that motivated the script: an extraction round deleted
 * the hand-written template folders and rewrote the catalogues, but `math_paper.md`,
 * `templates/README.md` and `homePresets.ts` kept pointing at the deleted names.
 * Counts agree, everything "passes", and the agent is told to use a folder that is gone.
 */
function checkAssetReferences() {
  const problems = [];

  const exists = (target) => fs.existsSync(target);
  const templatesRoot = path.join(BUILTINS, 'math_paper', 'assets', 'templates');

  // 1. `math_paper.md` names each bundled template folder — either as a full
  //    `assets/templates/<id>/` path or as a table row entry (`cumcm/`) — and every name
  //    must exist. The reverse direction (every folder on disk is listed) is only enforced
  //    when the body enumerates templates: the adopted upstream body instead points at the
  //    generic `assets/templates/<template.id>/`, which documents the layout rather than
  //    a list, so enumerating it in the body would be a second, drifting source of truth.
  const mathPaper = fs.readFileSync(path.join(BUILTINS, 'math_paper.md'), 'utf8');
  const enumeratesTemplates = !mathPaper.includes('assets/templates/<template.id>/');
  const referencedDirs = new Set([
    ...[...mathPaper.matchAll(/assets\/templates\/([a-z0-9-]+)\//g)].map((match) => match[1]),
    ...[...mathPaper.matchAll(/^\|\s*`([a-z0-9-]+)\/`/gm)].map((match) => match[1]),
  ]);
  for (const dir of referencedDirs) {
    if (!exists(path.join(templatesRoot, dir))) {
      problems.push(`math_paper.md references assets/templates/${dir}/ which does not exist`);
    }
  }
  if (enumeratesTemplates) {
    for (const entry of fs.readdirSync(templatesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!referencedDirs.has(entry.name)) {
        problems.push(`template ${entry.name}/ exists but math_paper.md does not list it`);
      }
    }
  }

  // 2. `math_figure.md` names the bundled drawing templates it tells the agent to run.
  const mathFigure = fs.readFileSync(path.join(BUILTINS, 'math_figure.md'), 'utf8');
  const figureRoot = path.join(BUILTINS, 'math_figure', 'assets');
  const mathmodelRoot = path.join(BUILTINS, 'mathmodel_figure_templates');
  const figureScripts = new Set(
    [...mathFigure.matchAll(/`([a-z-]+\/[a-z0-9_]+\.py)`/g)].map((match) => match[1])
  );
  for (const script of figureScripts) {
    if (!exists(path.join(figureRoot, 'templates', script))) {
      problems.push(`math_figure.md references assets/templates/${script} which does not exist`);
    }
  }
  // The MathModel renderer is its own skill now, so its files must sit in that folder.
  for (const required of [
    path.join(mathmodelRoot, 'scripts', 'render_template.py'),
    path.join(mathmodelRoot, 'references', 'figure-catalog.md'),
  ]) {
    if (!exists(required)) {
      problems.push(`missing asset: ${path.relative(BUILTINS, required)}`);
    }
  }

  // 3. A skill body must not tell the agent to run or open a file that is not there.
  //    Three shapes are checked, because a blanket "any backticked path" rule produced
  //    false positives on the adopted upstream bodies, which illustrate naming with
  //    made-up examples (`scripts/rotate_pdf.py`, `references/finance.md`):
  //      a) an invoked script  — `python scripts/x.py`, `python3 "<skill-dir>/scripts/x.py"`
  //      b) a markdown link    — `[guide](references/x.md)`
  //      c) any other backticked references/ path, which may belong to a *sibling* skill
  //         (the figure router points at `mathmodel-figure-templates`' catalogue).
  const skillRoots = new Map();
  for (const name of fs.readdirSync(BUILTINS)) {
    const full = path.join(BUILTINS, name);
    if (fs.statSync(full).isDirectory()) skillRoots.set(name, full);
  }
  const existsInAnySkill = (relative) =>
    [...skillRoots.values()].some((root) => exists(path.join(root, relative)));

  for (const file of fs.readdirSync(BUILTINS).filter((name) => name.endsWith('.md'))) {
    const stem = file.replace(/\.md$/, '');
    const skillDir = path.join(BUILTINS, stem);
    const body = fs.readFileSync(path.join(BUILTINS, file), 'utf8');

    const invoked = new Set(
      [
        ...body.matchAll(/(?:python3?|node)\s+"?((?:[A-Za-z0-9_./-]*\/)?scripts\/[A-Za-z0-9_./-]+\.\w+)"?/g),
      ].map((match) => match[1].replace(/^.*?\/(scripts\/)/, '$1'))
    );
    for (const relative of invoked) {
      if (!exists(path.join(skillDir, relative))) {
        problems.push(`${file} runs ${relative}, which does not exist under ${stem}/`);
      }
    }

    const linked = new Set(
      [...body.matchAll(/\]\(((?:references|assets)\/[A-Za-z0-9_./-]+)\)/g)].map((match) => match[1])
    );
    for (const relative of linked) {
      if (!exists(path.join(skillDir, relative))) {
        problems.push(`${file} links to ${relative}, which does not exist under ${stem}/`);
      }
    }

    const mentioned = new Set(
      [...body.matchAll(/`(references\/[A-Za-z0-9_./-]+)`/g)].map((match) => match[1])
    );
    for (const relative of mentioned) {
      if (exists(path.join(skillDir, relative)) || existsInAnySkill(relative)) continue;
      // A line that introduces names as illustrations or hypotheticals — "**Examples**:
      // `references/x.md`", "a `references/schema.md` … would be helpful" — is
      // documentation about how to write a skill, not an instruction to open a file.
      const line = body.split('\n').find((candidate) => candidate.includes(`\`${relative}\``));
      if (line && /example|would be|should include|such as|e\.g\./i.test(line)) continue;
      problems.push(`${file} references ${relative}, which no skill ships`);
    }
  }

  // 4. The paper catalogue's entry file must exist for every template.
  const papersSource = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'papers.ts'), 'utf8');
  for (const match of papersSource.matchAll(
    /directory: '([^']+)',[\s\S]*?entryFile: '([^']+)'/g
  )) {
    const [, directory, entryFile] = match;
    if (!exists(path.join(templatesRoot, directory, entryFile))) {
      problems.push(`papers.ts entry ${directory}/${entryFile} does not exist`);
    }
  }

  // 5. Every figure catalogue entry must resolve to a real script inside the skill it names.
  const figuresSource = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'figures.ts'), 'utf8');
  const figureSkillRoots = {
    'math-figure': path.join(BUILTINS, 'math_figure'),
    'mathmodel-figure-templates': mathmodelRoot,
  };
  for (const match of figuresSource.matchAll(
    /skill: '([^']+)',\s*\n\s*script: '([^']+)'/g
  )) {
    const [, skill, script] = match;
    const root = figureSkillRoots[skill];
    if (!root) {
      problems.push(`figures.ts names unknown skill '${skill}'`);
      continue;
    }
    if (!exists(path.join(root, script))) {
      problems.push(`figures.ts script ${skill}/${script} does not exist`);
    }
  }

  // 6. Home presets must point at templates that are actually bundled.
  const presets = fs.readFileSync(path.join(DESKTOP, 'src', 'catalog', 'homePresets.ts'), 'utf8');
  for (const match of presets.matchAll(/templateDirectory: '([^']+)'/g)) {
    if (!exists(path.join(templatesRoot, match[1]))) {
      problems.push(`homePresets.ts templateDirectory '${match[1]}' is not a bundled template`);
    }
  }

  return problems;
}

// --- Document checks --------------------------------------------------------

/**
 * Each check names a count and the literal strings that must appear in a document.
 * `must` are phrases that must exist; `mustNot` are phrases that must not.
 */
function buildChecks(counts) {
  const {
    skills,
    ownFigureTemplates,
    mathmodelTemplates,
    paperCompilable,
    connectors,
    algorithms,
    samples,
    i18nMessages,
    figureCatalog,
    paperCatalog,
  } = counts;
    counts;

  return [
    {
      file: 'MODELFORGE_CUSTOMIZATION.md',
      must: [
        `已内置 **${skills} 个技能**`,
        `| 内置技能 frontmatter | \`node scripts/check-skills.js\` | ✅ ${skills}/${skills} |`,
        '| i18n 各语言完整 | `pnpm run i18n:validate-locale` | ✅ 15 个语言通过 |',
      ],
      mustNot: [],
    },
    {
      file: 'REPLICATION_PLAN.md',
      must: [
        `| \`check-skills\` | ✅ **${skills}/${skills}**`,
        `${paperCompilable} 套可编译模板`,
        `| \`i18n:validate-locale\` | ✅ 15 语言 / ${i18nMessages} 条`,
        `${connectors.installed} 内置 / ${connectors.installable} 可安装 / ${connectors.planned} 规划中`,
        `✅ 完成：${connectors.installable} 条可一键安装，规划中归零`,
      ],
      mustNot: [],
    },
    {
      file: 'ACCEPTANCE_CHECKLIST.md',
      must: [
        `# ${skills}/${skills} 技能 frontmatter 与规范`,
        `# ${paperCompilable} 套论文模板编译（`,
        `共 **${algorithms}** 条`,
        `${samples} 个样例题`,
        `13 条：内置 ${connectors.installed} / 可连接 ${connectors.installable} / 规划中 ${connectors.planned}`,
        `共 **${paperCatalog.entries}** 条，${paperCatalog.available} 条标「已内置」`,
        `技能列表里能看到 **${skills} 个**`,
        `| A1 技能正文 | ${skills} |`,
        `| A5 MCP 连接器 | ${connectors.installable} 可安装 |`,
        `| 2.5.1 | 打开 | 共 **${paperCatalog.entries}** 条，${paperCatalog.available} 条标「已内置」`,
        `**${figureCatalog.entries} 张卡片**`,
      ],
      mustNot: [],
    },
    {
      file: 'NOTICE.md',
      must: [],
      mustNot: [],
    },
  ];
}

function main() {
  const counts = {
    skills: countSkills(),
    figureTemplates: countFigureTemplates(),
    figurePreviews: countFigurePreviews(),
    mathmodelTemplates: countMathmodelTemplates(),
    ownFigureTemplates: countOwnFigureTemplates(),
    paperDirCount: countPaperDirectories(),
    paperDirs: countPaperTemplateDirs(),
    paperCompilable: countPaperCompilable(),
    samples: countSampleProblems(),
    connectors: countConnectors(),
    algorithms: countAlgorithms(),
    figureCatalog: countFigureCatalog(),
    paperCatalog: countPaperCatalog(),
    i18nMessages: countI18nMessages(),
  };

  console.log('Derived from the filesystem:\n');
  console.log(`  skills                 ${counts.skills}`);
  console.log(`  figure templates ours  ${counts.ownFigureTemplates}`);
  console.log(`  figure templates mm    ${counts.mathmodelTemplates}`);
  console.log(`  figure previews        ${counts.figurePreviews}`);
  console.log(`  figure catalog         ${counts.figureCatalog.entries} entries ` +
    `(${counts.figureCatalog.available} with a preview, ${counts.figureCatalog.withoutPreview} without)`);
  console.log(`  paper template dirs    ${counts.paperDirCount}`);
  console.log(`  paper compilable       ${counts.paperCompilable}`);
  console.log(`  paper catalog          ${counts.paperCatalog.entries} entries (${counts.paperCatalog.available} available)`);
  console.log(`  sample problems        ${counts.samples}`);
  console.log(`  algorithms             ${counts.algorithms}`);
  console.log(`  connectors             ${counts.connectors.entries} entries ` +
    `(${counts.connectors.installed} builtin, ${counts.connectors.installable} installable, ${counts.connectors.planned} planned)`);
  console.log(`  i18n messages          ${counts.i18nMessages}`);

  // Internal consistency: the filesystem counts must agree with each other.
  const internal = [];
  // The catalogue now merges two families — the MathModel templates extracted from the
  // product and the templates written for this project — so the invariant is that every
  // MathModel script and every project script has a catalogue entry, and that only the
  // explicitly-known cartopy templates lack a preview.
  if (counts.figureCatalog.entries < counts.mathmodelTemplates + counts.ownFigureTemplates) {
    internal.push(
      `figure catalog has ${counts.figureCatalog.entries} entries but there are ` +
        `${counts.mathmodelTemplates} MathModel + ${counts.ownFigureTemplates} project templates`
    );
  }
  if (counts.figureCatalog.withoutPreview > 2) {
    internal.push(
      `${counts.figureCatalog.withoutPreview} figure catalog entries have no preview ` +
        '(only the two cartopy templates should, and they need the MSVC build tools)'
    );
  }
  if (counts.paperCatalog.available !== counts.paperCompilable) {
    internal.push(
      `paper catalog available (${counts.paperCatalog.available}) != compilable templates (${counts.paperCompilable})`
    );
  }
  if (counts.paperCatalog.entries !== counts.paperDirCount) {
    internal.push(
      `paper catalog entries (${counts.paperCatalog.entries}) != template directories (${counts.paperDirCount})`
    );
  }

  console.log('\nInternal consistency:\n');
  if (internal.length === 0) {
    console.log('  ok — filesystem counts agree with the app catalogues');
  } else {
    for (const problem of internal) console.log(`  MISMATCH  ${problem}`);
  }

  // Asset references: skills, catalogues and home presets must point at real files.
  console.log('\nAsset references:\n');
  const brokenRefs = checkAssetReferences();
  if (brokenRefs.length === 0) {
    console.log('  ok — every referenced template, script and entry file exists');
  } else {
    for (const problem of brokenRefs) console.log(`  BROKEN  ${problem}`);
  }

  // Document checks.
  console.log('\nDocumentation claims:\n');
  let failures = 0;
  for (const check of buildChecks(counts)) {
    const file = path.join(REPO, check.file);
    if (!fs.existsSync(file)) {
      console.log(`  MISSING FILE  ${check.file}`);
      failures++;
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const problems = [];
    for (const phrase of check.must) {
      if (!text.includes(phrase)) problems.push(`missing: ${phrase.slice(0, 80)}`);
    }
    for (const phrase of check.mustNot) {
      if (text.includes(phrase)) problems.push(`should not contain: ${phrase.slice(0, 80)}`);
    }
    if (problems.length) {
      console.log(`  FAIL  ${check.file}`);
      for (const problem of problems) console.log(`        ${problem}`);
      failures++;
    } else {
      console.log(`  ok    ${check.file}`);
    }
  }

  // Informational: this tree is normally the testing build, which carries content that
  // cannot be redistributed (fonts, contest material, unlicensed templates). Saying so on
  // every run is cheaper than discovering it at release time.
  const unshippable = [];
  const countTree = (dir, predicate) => {
    if (!fs.existsSync(dir)) return 0;
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) count += countTree(full, predicate);
      else if (predicate(full)) count++;
    }
    return count;
  };
  const paperTemplatesRoot = path.join(BUILTINS, 'math_paper', 'assets', 'templates');
  const fonts = countTree(paperTemplatesRoot, (file) =>
    ['.ttf', '.ttc', '.otf', '.woff', '.woff2'].includes(path.extname(file).toLowerCase())
  );
  if (fonts > 0) unshippable.push(`${fonts} embedded font(s)`);
  const examples = path.join(BUILTINS, 'math_modeling', 'assets', 'examples');
  if (fs.existsSync(examples)) {
    unshippable.push(`${countTree(examples, () => true)} contest-material file(s)`);
  }
  if (unshippable.length) {
    console.log(
      `\nRelease note: this tree contains ${unshippable.join(' and ')}.\n` +
        '  That is expected for testing; run `node scripts/strip-unshippable.js --write`\n' +
        '  before publishing (see NOTICE.md).'
    );
  }

  const total = internal.length + failures + brokenRefs.length;
  if (total) {
    console.log(`\n${total} problem(s) found`);
    process.exitCode = 1;
  } else {
    console.log('\nall cross-document counts agree');
  }
}

if (require.main === module) main();

#!/usr/bin/env node
/**
 * Generates `src/catalog/papers.ts` from the real template metadata that ships with each
 * paper template (`template.json`, written by the MathModel product) plus the vendored
 * upstream templates.
 *
 * Generated rather than hand-written for the same reason as the figure catalogue: the
 * names, languages and required fields are the product's own metadata, and retyping them
 * invites drift.
 *
 * Sources:
 *   math_paper/assets/templates/<dir>/template.json  -> name, description, language, entryFile
 *   src/assets/papers/<dir>.png                      -> compiled first-page preview
 *
 * Usage: node scripts/generate-papers-catalog.js
 */
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.join(DESKTOP, '..', '..');
const TEMPLATES = path.join(
  REPO,
  'crates',
  'goose',
  'src',
  'skills',
  'builtins',
  'math_paper',
  'assets',
  'templates'
);
const PREVIEWS = path.join(DESKTOP, 'src', 'assets', 'papers');
const OUT = path.join(DESKTOP, 'src', 'catalog', 'papers.ts');

/**
 * The three templates vendored from upstream rather than extracted from the product.
 * Their metadata is declared here because they have no `template.json`.
 */
const VENDORED = [
  {
    directory: 'cumcm-latex',
    contest: '国赛 CUMCM（LaTeX 类文件版）',
    name: '国赛 LaTeX 模板（cumcmthesis）',
    language: 'zh',
    engine: 'xelatex',
    description:
      '上游 cumcmthesis 类文件与示例，与产品内置的国赛模板版本不同，可作为备选排版。',
    entryFile: 'paper.tex',
    source: 'Sustainable-Enjoyment/CUMCM-LaTeX-Template',
    license: 'MIT',
  },
  {
    directory: 'jxust-latex',
    contest: '校赛/通用（JXUST）',
    name: 'JXUST 建模论文模板',
    language: 'zh',
    engine: 'xelatex',
    description: '上游 JXUSTmodeling 类文件与完整示例，含公式、流程图与表格排版参考。',
    entryFile: 'paper.tex',
    source: 'sikouhjw/JXUSTmodeling',
    license: 'MIT',
  },
  {
    directory: 'cumcm-typst',
    contest: '国赛 CUMCM（Typst）',
    name: '国赛 Typst 模板',
    language: 'zh',
    engine: 'typst',
    description:
      'Typst 排版，附可编译入口 paper.typ。依赖的 thmbox 已本地实现，编译无需联网。',
    entryFile: 'paper.typ',
    source: 'a-kkiri/CUMCM-typst-template',
    license: 'Apache-2.0',
  },
];

/**
 * Labels for the team-profile fields a template may ask for. The template's own
 * `template.json` carries labels for its `fields` (题号, 队号, …) but not for
 * `profileFields`, which reference a shared profile by id.
 */
const PROFILE_FIELD_LABELS = {
  school: { label: '学校 / 参赛单位', placeholder: '例如 某某大学' },
  members: { label: '队员姓名', placeholder: '按报名顺序，用顿号分隔' },
  advisor: { label: '指导教师', placeholder: '没有就留空' },
  phone: { label: '联系电话', placeholder: '仅用于封面信息，不会上传' },
  email: { label: '电子邮箱', placeholder: '仅用于封面信息，不会上传' },
};

/**
 * The paper section outline every one of these templates uses, so the UI can show it
 * without each template having to declare it.
 */
const SECTION_OUTLINE = [
  '摘要',
  '问题重述',
  '问题分析',
  '模型假设与符号说明',
  '模型建立与求解',
  '模型检验',
  '模型评价与推广',
  '参考文献',
  '附录',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function main() {
  const directories = fs
    .readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const entries = [];

  for (const directory of directories) {
    const vendored = VENDORED.find((v) => v.directory === directory);
    const root = path.join(TEMPLATES, directory);
    const preview = path.join(PREVIEWS, `${directory}.png`);
    const hasPreview = fs.existsSync(preview);

    if (vendored) {
      entries.push({
        ...vendored,
        defaultFor: [],
        kind: 'vendored',
        fields: [],
        profileFields: [],
        preview: hasPreview ? directory : '',
        available: hasPreview,
      });
      continue;
    }

    const metaFile = path.join(root, 'template.json');
    if (!fs.existsSync(metaFile)) {
      console.warn(`skip ${directory}: no template.json and not a vendored entry`);
      continue;
    }
    const meta = readJson(metaFile);
    const entryFile = meta.entryFile ?? 'main.tex';

    // The product declares the cover-page inputs per contest: 题号, 队号, 年份, 赛区 …
    // Surfacing them lets the app collect the values and hand them to the agent, instead
    // of the user discovering the placeholders after the first compile fails.
    const fields = (meta.fields ?? []).map((field) => ({
      id: field.id,
      label: field.label?.['zh-CN'] ?? field.label?.en ?? field.id,
      placeholder: field.placeholder?.['zh-CN'] ?? field.placeholder?.en ?? '',
      required: Boolean(field.required),
    }));

    const profileFields = (meta.profileFields ?? []).map((id) => ({
      id,
      label: PROFILE_FIELD_LABELS[id]?.label ?? id,
      placeholder: PROFILE_FIELD_LABELS[id]?.placeholder ?? '',
      required: false,
    }));

    entries.push({
      directory,
      contest: meta.name?.['zh-CN'] ?? meta.name?.en ?? directory,
      name: meta.name?.['zh-CN'] ?? meta.name?.en ?? directory,
      language: (meta.language ?? 'zh-CN').startsWith('en') ? 'en' : 'zh',
      engine: entryFile.endsWith('.typ') ? 'typst' : 'xelatex',
      description:
        meta.description?.['zh-CN'] ??
        meta.description?.en ??
        `${meta.name?.['zh-CN'] ?? directory} 论文模板`,
      entryFile,
      source: 'MathModel 桌面端内置模板',
      license: '见 NOTICE.md',
      // `defaultFor` is the product's own hint for which UI language this template suits;
      // it decides what “默认用于” shows on the detail panel.
      defaultFor: (meta.defaultFor ?? []).map((value) =>
        String(value).startsWith('en') ? '英文界面' : '中文界面'
      ),
      kind: 'bundled',
      fields,
      profileFields,
      preview: hasPreview ? directory : '',
      available: hasPreview,
    });
  }

  const lines = [];
  lines.push('/**');
  lines.push(' * Competition paper template catalogue (论文模板) for the 扩展 → 模板 page.');
  lines.push(' *');
  lines.push(' * GENERATED FILE — do not edit by hand. Run `pnpm run papers:catalog` to');
  lines.push(' * regenerate from each template\'s own `template.json`.');
  lines.push(' *');
  lines.push(' * The templates live under');
  lines.push(' * `math_paper/assets/templates/<directory>/`; `entryFile` names the file to');
  lines.push(' * compile. Previews are real first pages: run `pnpm run papers:build`.');
  lines.push(' *');
  lines.push(' * Provenance and licences are recorded in `NOTICE.md`. Embedded fonts shipped');
  lines.push(' * with the product templates were deliberately not copied.');
  lines.push(' */');
  lines.push('');
  lines.push("export type PaperEngine = 'xelatex' | 'typst';");
  lines.push('');
  lines.push('/** One cover-page input a template declares (题号, 队号, 年份 …). */');
  lines.push('export interface PaperField {');
  lines.push('  id: string;');
  lines.push('  label: string;');
  lines.push('  placeholder: string;');
  lines.push('  required: boolean;');
  lines.push('}');
  lines.push('');
  lines.push('export interface PaperTemplateEntry {');
  lines.push('  directory: string;');
  lines.push('  contest: string;');
  lines.push('  name: string;');
  lines.push("  language: 'zh' | 'en';");
  lines.push('  engine: PaperEngine;');
  lines.push('  description: string;');
  lines.push('  /** File to compile, relative to the template directory. */');
  lines.push('  entryFile: string;');
  lines.push('  source: string;');
  lines.push('  license: string;');
  lines.push('  /** Cover-page inputs declared by the template itself. */');
  lines.push('  fields: PaperField[];');
  lines.push('  /** Shared team-profile inputs the template asks for (school, members, …). */');
  lines.push('  profileFields: PaperField[];');
  lines.push('  /** Interface languages this template is meant for, as declared by the product. */');
  lines.push('  defaultFor: string[];');
  lines.push("  /** `bundled` = extracted from the installed product; `vendored` = upstream OSS. */");
  lines.push("  kind: 'bundled' | 'vendored';");
  lines.push('  /** Asset name under src/assets/papers/, empty when no preview was compiled. */');
  lines.push('  preview: string;');
  lines.push('  available: boolean;');
  lines.push('}');
  lines.push('');
  lines.push('/** Paper section outline shared by these contest templates. */');
  lines.push('export const PAPER_SECTION_OUTLINE = [');
  for (const section of SECTION_OUTLINE) lines.push(`  ${JSON.stringify(section)},`);
  lines.push('];');
  lines.push('');
  lines.push('export const PAPER_TEMPLATE_CATALOG: PaperTemplateEntry[] = [');
  for (const entry of entries) {
    lines.push('  {');
    lines.push(`    directory: '${entry.directory}',`);
    lines.push(`    contest: ${JSON.stringify(entry.contest)},`);
    lines.push(`    name: ${JSON.stringify(entry.name)},`);
    lines.push(`    language: '${entry.language}',`);
    lines.push(`    engine: '${entry.engine}',`);
    lines.push(`    description: ${JSON.stringify(entry.description)},`);
    lines.push(`    entryFile: '${entry.entryFile}',`);
    lines.push(`    source: ${JSON.stringify(entry.source)},`);
    lines.push(`    license: ${JSON.stringify(entry.license)},`);
    lines.push('    fields: [');
    for (const field of entry.fields ?? []) {
      lines.push(
        `      { id: ${JSON.stringify(field.id)}, label: ${JSON.stringify(field.label)}, ` +
          `placeholder: ${JSON.stringify(field.placeholder)}, required: ${field.required} },`
      );
    }
    lines.push('    ],');
    lines.push('    profileFields: [');
    for (const field of entry.profileFields ?? []) {
      lines.push(
        `      { id: ${JSON.stringify(field.id)}, label: ${JSON.stringify(field.label)}, ` +
          `placeholder: ${JSON.stringify(field.placeholder)}, required: ${field.required} },`
      );
    }
    lines.push('    ],');
    lines.push(`    defaultFor: [${(entry.defaultFor ?? []).map((v) => JSON.stringify(v)).join(', ')}],`);
    lines.push(`    kind: '${entry.kind}',`);
    lines.push(`    preview: '${entry.preview}',`);
    lines.push(`    available: ${entry.available},`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  lines.push('/** Preview images, resolved from the renderer asset folder at build time. */');
  lines.push("const PREVIEWS = import.meta.glob<string>('../assets/papers/*.png', {");
  lines.push('  eager: true,');
  lines.push("  import: 'default',");
  lines.push('});');
  lines.push('');
  lines.push('/** Thumbnail URL for a catalogue entry, empty string when none was compiled. */');
  lines.push('export function paperPreview(entry: PaperTemplateEntry): string {');
  lines.push('  return entry.preview');
  lines.push('    ? (PREVIEWS[`../assets/papers/${entry.preview}.png`] ?? \'\')');
  lines.push("    : '';");
  lines.push('}');
  lines.push('');
  lines.push('export const AVAILABLE_PAPER_COUNT = PAPER_TEMPLATE_CATALOG.filter(');
  lines.push('  (entry) => entry.available');
  lines.push(').length;');
  lines.push('');

  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`wrote ${path.relative(DESKTOP, OUT)}`);
  console.log(
    `  ${entries.length} entries (${entries.filter((e) => e.available).length} with a compiled preview)`
  );
  const noPreview = entries.filter((e) => !e.available);
  if (noPreview.length) {
    console.log(`  no preview: ${noPreview.map((e) => e.directory).join(', ')}`);
  }
}

if (require.main === module) main();

/**
 * Competition paper template catalogue (论文模板) for the 扩展 → 模板 page.
 *
 * GENERATED FILE — do not edit by hand. Run `pnpm run papers:catalog` to
 * regenerate from each template's own `template.json`.
 *
 * The templates live under
 * `math_paper/assets/templates/<directory>/`; `entryFile` names the file to
 * compile. Previews are real first pages: run `pnpm run papers:build`.
 *
 * Provenance and licences are recorded in `NOTICE.md`. Embedded fonts shipped
 * with the product templates were deliberately not copied.
 */

export type PaperEngine = 'xelatex' | 'typst';

/** One cover-page input a template declares (题号, 队号, 年份 …). */
export interface PaperField {
  id: string;
  label: string;
  placeholder: string;
  required: boolean;
}

export interface PaperTemplateEntry {
  directory: string;
  contest: string;
  name: string;
  language: 'zh' | 'en';
  engine: PaperEngine;
  description: string;
  /** File to compile, relative to the template directory. */
  entryFile: string;
  source: string;
  license: string;
  /** Cover-page inputs declared by the template itself. */
  fields: PaperField[];
  /** Shared team-profile inputs the template asks for (school, members, …). */
  profileFields: PaperField[];
  /** Interface languages this template is meant for, as declared by the product. */
  defaultFor: string[];
  /** `bundled` = extracted from the installed product; `vendored` = upstream OSS. */
  kind: 'bundled' | 'vendored';
  /** Asset name under src/assets/papers/, empty when no preview was compiled. */
  preview: string;
  available: boolean;
}

/** Paper section outline shared by these contest templates. */
export const PAPER_SECTION_OUTLINE = [
  "摘要",
  "问题重述",
  "问题分析",
  "模型假设与符号说明",
  "模型建立与求解",
  "模型检验",
  "模型评价与推广",
  "参考文献",
  "附录",
];

export const PAPER_TEMPLATE_CATALOG: PaperTemplateEntry[] = [
  {
    directory: 'apmcm',
    contest: "亚太赛 APMCM（中文）",
    name: "亚太赛 APMCM（中文）",
    language: 'zh',
    engine: 'xelatex',
    description: "亚太地区大学生数学建模竞赛中文论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "例如 A、B、C", required: true },
      { id: "teamNumber", label: "队伍编号", placeholder: "", required: true },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'apmcm',
    available: true,
  },
  {
    directory: 'apmcm-en',
    contest: "亚太赛 APMCM（英文）",
    name: "亚太赛 APMCM（英文）",
    language: 'en',
    engine: 'xelatex',
    description: "亚太地区大学生数学建模竞赛英文论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "例如 A、B、C", required: true },
      { id: "teamNumber", label: "队伍编号", placeholder: "", required: true },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'apmcm-en',
    available: true,
  },
  {
    directory: 'changsanjiao',
    contest: "长三角赛",
    name: "长三角赛",
    language: 'zh',
    engine: 'xelatex',
    description: "长三角高校数学建模竞赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "A、B 或 C", required: true },
      { id: "teamNumber", label: "队伍编号", placeholder: "", required: true },
      { id: "category", label: "赛道", placeholder: "", required: true },
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'changsanjiao',
    available: true,
  },
  {
    directory: 'cumcm',
    contest: "国赛 CUMCM",
    name: "国赛 CUMCM",
    language: 'zh',
    engine: 'xelatex',
    description: "全国大学生数学建模竞赛中文论文模板",
    entryFile: 'document.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "例如 A、B、C", required: true },
      { id: "teamNumber", label: "参赛队号", placeholder: "全国统一编号", required: true },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
      { id: "advisor", label: "指导教师", placeholder: "没有就留空", required: false },
    ],
    defaultFor: ["中文界面"],
    kind: 'bundled',
    preview: 'cumcm',
    available: true,
  },
  {
    directory: 'cumcm-latex',
    contest: "国赛 CUMCM（LaTeX 类文件版）",
    name: "国赛 LaTeX 模板（cumcmthesis）",
    language: 'zh',
    engine: 'xelatex',
    description: "上游 cumcmthesis 类文件与示例，与产品内置的国赛模板版本不同，可作为备选排版。",
    entryFile: 'paper.tex',
    source: "Sustainable-Enjoyment/CUMCM-LaTeX-Template",
    license: "MIT",
    fields: [
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'vendored',
    preview: 'cumcm-latex',
    available: true,
  },
  {
    directory: 'cumcm-typst',
    contest: "国赛 CUMCM（Typst）",
    name: "国赛 Typst 模板",
    language: 'zh',
    engine: 'typst',
    description: "Typst 排版，附可编译入口 paper.typ。依赖的 thmbox 已本地实现，编译无需联网。",
    entryFile: 'paper.typ',
    source: "a-kkiri/CUMCM-typst-template",
    license: "Apache-2.0",
    fields: [
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'vendored',
    preview: 'cumcm-typst',
    available: true,
  },
  {
    directory: 'diangongbei',
    contest: "电工杯",
    name: "电工杯",
    language: 'zh',
    engine: 'xelatex',
    description: "电工杯数学建模竞赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "A 或 B", required: true },
      { id: "teamNumber", label: "报名序号", placeholder: "", required: true },
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'diangongbei',
    available: true,
  },
  {
    directory: 'dongsansheng',
    contest: "东三省赛",
    name: "东三省赛",
    language: 'zh',
    engine: 'xelatex',
    description: "东三省数学建模联赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "参赛题号", placeholder: "A、B、C 或 D", required: true },
      { id: "category", label: "参赛组别", placeholder: "", required: true },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
      { id: "advisor", label: "指导教师", placeholder: "没有就留空", required: false },
      { id: "phone", label: "联系电话", placeholder: "仅用于封面信息，不会上传", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'dongsansheng',
    available: true,
  },
  {
    directory: 'huashubei',
    contest: "华数杯",
    name: "华数杯",
    language: 'zh',
    engine: 'xelatex',
    description: "华数杯全国大学生数学建模竞赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'huashubei',
    available: true,
  },
  {
    directory: 'huawei',
    contest: "华为杯",
    name: "华为杯",
    language: 'zh',
    engine: 'xelatex',
    description: "中国研究生数学建模竞赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "teamNumber", label: "参赛队号", placeholder: "", required: true },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'huawei',
    available: true,
  },
  {
    directory: 'huazhong',
    contest: "华中杯",
    name: "华中杯",
    language: 'zh',
    engine: 'xelatex',
    description: "华中杯大学生数学建模挑战赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "", required: true },
      { id: "teamNumber", label: "参赛队号", placeholder: "", required: true },
      { id: "contestDate", label: "竞赛日期", placeholder: "例如 2026-05-01", required: false },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
      { id: "advisor", label: "指导教师", placeholder: "没有就留空", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'huazhong',
    available: true,
  },
  {
    directory: 'jxust-latex',
    contest: "校赛/通用（JXUST）",
    name: "JXUST 建模论文模板",
    language: 'zh',
    engine: 'xelatex',
    description: "上游 JXUSTmodeling 类文件与完整示例，含公式、流程图与表格排版参考。",
    entryFile: 'paper.tex',
    source: "sikouhjw/JXUSTmodeling",
    license: "MIT",
    fields: [
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'vendored',
    preview: 'jxust-latex',
    available: true,
  },
  {
    directory: 'mathorcup',
    contest: "MathorCup",
    name: "MathorCup",
    language: 'zh',
    engine: 'xelatex',
    description: "MathorCup 高校数学建模挑战赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "", required: true },
      { id: "teamNumber", label: "队伍编号", placeholder: "", required: true },
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'mathorcup',
    available: true,
  },
  {
    directory: 'mcm',
    contest: "美赛 MCM/ICM",
    name: "美赛 MCM/ICM",
    language: 'en',
    engine: 'xelatex',
    description: "美国大学生数学建模竞赛英文论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "例如 A、B、C", required: true },
      { id: "teamNumber", label: "队伍控制号", placeholder: "例如 2512345", required: true },
    ],
    profileFields: [
    ],
    defaultFor: ["英文界面"],
    kind: 'bundled',
    preview: 'mcm',
    available: true,
  },
  {
    directory: 'shuweibei',
    contest: "数维杯",
    name: "数维杯",
    language: 'zh',
    engine: 'xelatex',
    description: "数维杯大学生数学建模挑战赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "题号", placeholder: "", required: true },
      { id: "teamNumber", label: "参赛队号", placeholder: "", required: true },
    ],
    profileFields: [
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'shuweibei',
    available: true,
  },
  {
    directory: 'stats',
    contest: "统计建模大赛",
    name: "统计建模大赛",
    language: 'zh',
    engine: 'xelatex',
    description: "全国大学生统计建模大赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "year", label: "竞赛年份", placeholder: "例如 2026", required: true },
      { id: "edition", label: "届数", placeholder: "例如 第十二届填写 12", required: true },
      { id: "workNumber", label: "作品编号", placeholder: "", required: false },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
      { id: "advisor", label: "指导教师", placeholder: "没有就留空", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'stats',
    available: true,
  },
  {
    directory: 'wuyi',
    contest: "五一杯",
    name: "五一杯",
    language: 'zh',
    engine: 'xelatex',
    description: "五一数学建模竞赛论文模板",
    entryFile: 'main.tex',
    source: "MathModel 桌面端内置模板",
    license: "见 NOTICE.md",
    fields: [
      { id: "problemNumber", label: "参赛题号", placeholder: "A、B 或 C", required: true },
      { id: "teamNumber", label: "参赛队号", placeholder: "", required: true },
      { id: "category", label: "参赛组别", placeholder: "", required: true },
      { id: "date", label: "承诺书日期", placeholder: "例如 2026-05-01", required: false },
    ],
    profileFields: [
      { id: "school", label: "学校 / 参赛单位", placeholder: "例如 某某大学", required: false },
      { id: "members", label: "队员姓名", placeholder: "按报名顺序，用顿号分隔", required: false },
      { id: "phone", label: "联系电话", placeholder: "仅用于封面信息，不会上传", required: false },
      { id: "email", label: "电子邮箱", placeholder: "仅用于封面信息，不会上传", required: false },
    ],
    defaultFor: [],
    kind: 'bundled',
    preview: 'wuyi',
    available: true,
  },
];

/** Preview images, resolved from the renderer asset folder at build time. */
const PREVIEWS = import.meta.glob<string>('../assets/papers/*.png', {
  eager: true,
  import: 'default',
});

/** Thumbnail URL for a catalogue entry, empty string when none was compiled. */
export function paperPreview(entry: PaperTemplateEntry): string {
  return entry.preview
    ? (PREVIEWS[`../assets/papers/${entry.preview}.png`] ?? '')
    : '';
}

export const AVAILABLE_PAPER_COUNT = PAPER_TEMPLATE_CATALOG.filter(
  (entry) => entry.available
).length;

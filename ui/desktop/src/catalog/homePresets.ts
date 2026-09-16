/**
 * Home-screen presets: the paper workflow / contest / example chips shown above
 * the composer.
 *
 * Selecting one seeds the composer with a prompt, so the preset actually shapes
 * what the agent does instead of being decorative. The prompts reference the
 * built-in skills by name (`math-modeling`, `math-paper`, `math-figure`, ...),
 * which the agent loads through `load_skill`.
 *
 * Example problems are listed so the layout matches the product's "try one of
 * these" row. They are catalogued here without problem PDFs or datasets, so no
 * contest material is redistributed; `dataAvailable: false` records that the
 * attachment is not bundled.
 */
export type WorkflowId = 'paper' | 'modeling-report' | 'figure-set' | 'review' | 'data-search';

export interface WorkflowPreset {
  id: WorkflowId;
  title: string;
  description: string;
  /** Skills the seeded prompt tells the agent to load. */
  skills: string[];
  prompt: string;
}

export interface ContestPreset {
  id: string;
  label: string;
  language: 'zh' | 'en';
  /** Paper template directory under math_paper/assets/templates/, if bundled. */
  templateDirectory: string | null;
  prompt: string;
}

/**
 * Example problems shown on the home screen.
 *
 * These are the **three real contest problem sets** extracted from the installed product
 * (`resources/builtin-examples/`), matching the cards the reference product shows:
 * 2023 国赛 A 题、2023 华数杯 C 题、2024 高教社杯 C 题. Each directory under
 * `math_modeling/assets/examples/` holds the official statement PDF, `questions.txt`
 * (the same statement as text, so the agent can read it without a PDF tool), the data
 * attachments and — where the organisers published them — result files.
 *
 * **Copyright**: the statements and attachments belong to the competition organisers, and
 * no licence of theirs covers redistributing them inside a third-party product. They were
 * extracted at the operator's request for local use; `NOTICE.md` says so, and
 * `REPORT-extraction.md` records how to drop them before publishing. The three
 * self-authored practice problems under `math_modeling/assets/samples/` remain the
 * redistributable alternative and are still referenced by the `math-modeling` skill.
 *
 * `dataReady` says whether the attachments are already in the repository.
 */
export interface ExampleProblem {
  id: string;
  /** Short label on the card. */
  label: string;
  title: string;
  /** Method tags shown on the card. */
  methods: string[];
  /** Directory under math_modeling/assets/examples/. */
  sourceDir: string;
  /** Attachments are committed, so the problem runs without any setup step. */
  dataReady: boolean;
  prompt: string;
}

export const EXAMPLE_PROBLEMS: ExampleProblem[] = [
  {
    id: 'cumcm-2023-a',
    label: '2023 国赛 A 题',
    title: '定日镜场的优化设计',
    methods: ['优化', '物理建模', '几何计算'],
    sourceDir: '2023国赛A题',
    dataReady: true,
    prompt:
      '请按数学建模流程完成 2023 国赛 A 题「定日镜场的优化设计」。题目与数据位于 math-modeling 技能的 ' +
      'assets/examples/2023国赛A题/（questions.txt 为题面全文，A题.pdf 为官方题面，附件.xlsx 为数据，' +
      'result2.xlsx / result3.xlsx 为结果文件模板）。先读 questions.txt 全文再动手；' +
      '加载 optimization-modeling 与 differential-equation-modeling 技能，' +
      '完成光学效率建模、镜场布局优化与灵敏度分析，并给出结论成立的参数区间。',
  },
  {
    id: 'huashubei-2023-c',
    label: '2023 华数杯 C 题',
    title: '母亲身心健康对婴儿成长的影响',
    methods: ['统计', '回归分析', '分类预测'],
    sourceDir: '2023华数杯C题',
    dataReady: true,
    prompt:
      '请按数学建模流程完成 2023 华数杯 C 题「母亲身心健康对婴儿成长的影响」。题目与数据位于 math-modeling 技能的 ' +
      'assets/examples/2023华数杯C题/（questions.txt 为题面，华数杯2023年C题.pdf 为官方题面，附件.xlsx 为 ' +
      '390 名婴儿及其母亲的数据）。先读 questions.txt 全文再动手；加载 data-prep、regression-modeling 与 ' +
      'classification-modeling 技能，交代缺失值与异常处理、变量编码，做统计检验并给出效应量与置信区间。',
  },
  {
    id: 'cumcm-2024-c',
    label: '2024 高教社杯 C 题',
    title: '农作物的种植策略',
    methods: ['优化', '规划', '种植策略'],
    sourceDir: '2024高教杯C题',
    dataReady: true,
    prompt:
      '请按数学建模流程完成 2024 高教社杯 C 题「农作物的种植策略」。题目与数据位于 math-modeling 技能的 ' +
      'assets/examples/2024高教杯C题/（questions.txt 为题面，C题.pdf 为官方题面，附件1.xlsx / 附件2.xlsx 为 ' +
      '地块与作物数据，result1_*.xlsx / result2.xlsx 为结果模板）。先读 questions.txt 全文再动手；' +
      '加载 optimization-modeling 与 sensitivity-analysis 技能，建立多年期种植规划的优化模型，' +
      '说明约束与求解器选型，并做价格与产量波动下的稳健性检验。',
  },
];

export const WORKFLOW_PRESETS: WorkflowPreset[] = [
  {
    id: 'paper',
    title: '写论文',
    description: '从题目到可编译论文的完整链路',
    skills: ['math-modeling', 'math-paper', 'math-figure'],
    prompt:
      '请按数学建模论文流程处理下面的题目：加载 math-modeling、math-paper、math-figure 技能，完成读题、建模、代码、检验、出图，最后按赛事模板产出可编译的论文。\n\n题目：',
  },
  {
    id: 'modeling-report',
    title: '建模报告',
    description: '只要建模方案与求解结果，不排版',
    skills: ['math-modeling'],
    prompt:
      '请只做建模分析，不写论文排版：加载 math-modeling 技能，给出问题拆解、假设、模型选择理由、求解算法与数值结果。\n\n题目：',
  },
  {
    id: 'figure-set',
    title: '出图',
    description: '按数据生成论文级配图',
    skills: ['math-figure'],
    prompt:
      '请按 math-figure 技能规范为下面的数据/结果出图：矢量 PDF/SVG + PNG 预览，图带标题、坐标轴、单位与图例。\n\n数据或结果说明：',
  },
  {
    id: 'review',
    title: '评审',
    description: '按竞赛标准打分并给出逐条修改建议',
    skills: ['math-paper'],
    prompt:
      '请按竞赛评审标准评审我下面的论文：逐条指出问题（摘要/模型假设/求解/检验/图表/写作规范），给出可执行的修改建议与优先级。\n\n论文或正文：',
  },
  {
    id: 'data-search',
    title: '找数据',
    description: '查找、核验并公开数据集来源',
    skills: ['data-search'],
    prompt:
      '请为我查找并核验可用的公开数据集：说明来源、时间范围、字段含义与许可，给出下载地址与引用格式；需要时写脚本下载到项目 data/ 目录。\n\n需要的数据：',
  },
];

export const CONTEST_PRESETS: ContestPreset[] = [
  {
    id: 'cumcm',
    label: '国赛 CUMCM',
    language: 'zh',
    templateDirectory: 'cumcm',
    prompt:
      '排版要求：使用国赛（CUMCM）内置模板（math_paper/assets/templates/cumcm/，入口 document.tex），' +
      '该模板自带竞赛封面、承诺书与编号栏，封面信息请先问我。',
  },
  {
    id: 'cumcm-typst',
    label: '国赛 CUMCM（Typst）',
    language: 'zh',
    templateDirectory: 'cumcm-typst',
    prompt:
      '排版要求：使用国赛 Typst 模板（math_paper/assets/templates/cumcm-typst/，入口 paper.typ），' +
      '编译用 modeling 扩展的 compile_latex 指定 engine="typst"。',
  },
  {
    id: 'mcm',
    label: '美赛 MCM/ICM',
    language: 'en',
    templateDirectory: 'mcm',
    prompt:
      '排版要求：使用美赛（MCM/ICM）内置模板（math_paper/assets/templates/mcm/，入口 main.tex），' +
      'Summary Sheet 独立成页且必须写在一页内，正文英文。',
  },
  {
    id: 'huashubei',
    label: '华数杯',
    language: 'zh',
    templateDirectory: 'huashubei',
    prompt:
      '排版要求：使用华数杯内置模板（math_paper/assets/templates/huashubei/，入口 main.tex）。',
  },
  {
    id: 'mathorcup',
    label: 'MathorCup',
    language: 'zh',
    templateDirectory: 'mathorcup',
    prompt:
      '排版要求：使用 MathorCup 内置模板（math_paper/assets/templates/mathorcup/，入口 main.tex）。',
  },
  {
    id: 'apmcm',
    label: '亚太赛 APMCM',
    language: 'zh',
    templateDirectory: 'apmcm',
    prompt:
      '排版要求：使用亚太赛（APMCM）内置模板（math_paper/assets/templates/apmcm/，入口 main.tex）；' +
      '需要英文版时改用同目录旁的 apmcm-en。',
  },
  {
    id: 'apmcm-en',
    label: '亚太赛 APMCM（英文）',
    language: 'en',
    templateDirectory: 'apmcm-en',
    prompt:
      '排版要求：使用亚太赛英文模板（math_paper/assets/templates/apmcm-en/）；正文用英文撰写。',
  },
  {
    id: 'wuyi',
    label: '五一赛',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按五一数学建模联赛的常见格式排版。',
  },
  {
    id: 'shuwei',
    label: '数维杯',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按数维杯的常见格式排版。',
  },
  {
    id: 'diangong',
    label: '电工杯',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按电工杯的常见格式排版。',
  },
  {
    id: 'changshanjiao',
    label: '长三角赛',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按长三角赛的常见格式排版。',
  },
  {
    id: 'dongsansheng',
    label: '东三省赛',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按东三省赛的常见格式排版。',
  },
  {
    id: 'huazhong',
    label: '华中杯',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按华中杯的常见格式排版。',
  },
  {
    id: 'tongji',
    label: '统计建模大赛',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按统计建模大赛的常见格式排版，突出统计方法与结果呈现。',
  },
  {
    id: 'custom',
    label: '新建自定义模板',
    language: 'zh',
    templateDirectory: null,
    prompt: '排版要求：按我后续指定的格式排版。',
  },
];

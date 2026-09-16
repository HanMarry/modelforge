#!/usr/bin/env node
/**
 * Generates `src/catalog/figures.ts`.
 *
 * Two families are merged:
 *
 *  1. **The MathModel figure templates** extracted from the installed product. Their ids,
 *     titles, categories and layout descriptions come from the product's own metadata
 *     (`references/figure-catalog.md` + `extended-chart-guide.md`), so nothing is retyped
 *     by hand.
 *  2. **14 templates written for this project**, under `assets/templates/`.
 *
 * Previews for family 1 are rendered by `build-mathmodel-figures.js` into
 * `src/assets/figures/mathmodel/`; family 2 renders into `src/assets/figures/<category>/`.
 * Neither set is copied from the product bundle.
 *
 * Usage: node scripts/generate-figures-catalog.js
 */
const fs = require('fs');
const path = require('path');

const DESKTOP = path.join(__dirname, '..');
const REPO = path.join(DESKTOP, '..', '..');
const BUILTINS = path.join(REPO, 'crates', 'goose', 'src', 'skills', 'builtins');
const REFS = path.join(BUILTINS, 'mathmodel_figure_templates', 'references');
const MM_PREVIEWS = path.join(DESKTOP, 'src', 'assets', 'figures', 'mathmodel');
const OWN_PREVIEWS = path.join(DESKTOP, 'src', 'assets', 'figures');
const OUT = path.join(DESKTOP, 'src', 'catalog', 'figures.ts');

/** English category keys mapped from the guide's Chinese section headings. */
const CATEGORY_KEYS = {
  '排序与多变量分析': 'ordination',
  '组成、排名与多层报告': 'composition',
  '三维与同心环形图': 'three-dimensional',
  '分布、统计与回归矩阵': 'distribution',
  '三维曲面、网络与集合': 'surface',
  '预测评价': 'prediction',
  '单样本贡献与局部响应': 'attribution',
  '关联、分组矩阵与效应分解': 'association',
  '特征贡献与复合效应报告': 'feature-report',
  '响应面与空间网格': 'spatial',
  '时间序列': 'time-series',
  '输入与计算说明': 'notes',
};

/** Display labels: the Chinese side is the product's own heading, the English is ours. */
const CATEGORY_LABELS = {
  ordination: ['排序与多变量分析', 'Ordination and multivariate'],
  composition: ['组成、排名与多层报告', 'Composition and ranking'],
  'three-dimensional': ['三维与同心环形图', '3D and concentric rings'],
  distribution: ['分布、统计与回归矩阵', 'Distributions and regression'],
  surface: ['三维曲面、网络与集合', 'Surfaces, networks and sets'],
  prediction: ['预测评价', 'Prediction evaluation'],
  attribution: ['单样本贡献与局部响应', 'Per-sample attribution'],
  association: ['关联、分组矩阵与效应分解', 'Association and grouping'],
  'feature-report': ['特征贡献与复合效应报告', 'Feature contribution reports'],
  spatial: ['响应面与空间网格', 'Response surface and spatial grids'],
  'time-series': ['时间序列', 'Time series'],
  // Categories used only by the project-written templates. Without them the gallery
  // prints the raw key (e.g. "flowchart") as the heading.
  combination: ['组合与多面板图', 'Combined and multi-panel'],
  flowchart: ['流程图与技术路线图', 'Flowcharts and roadmaps'],
  'machine-learning': ['机器学习与特征分析', 'Machine learning and features'],
  'model-evaluation': ['模型评价与诊断', 'Model evaluation and diagnostics'],
  other: ['其他', 'Other'],
};

/**
 * The 14 templates written for this project.
 * [script path, category, title, description, preview path relative to src/assets/figures/].
 */
const OURS = [
  ['model-evaluation/roc_cross_validation.py', 'model-evaluation', 'ROC 交叉验证曲线', 'per-fold ROC + mean curve + SD band + AUC', 'model-evaluation/roc_cross_validation'],
  ['model-evaluation/sensitivity_curves.py', 'model-evaluation', '灵敏度弹性曲线', 'parameter elasticities + the input band where the conclusion holds', 'model-evaluation/sensitivity_curves'],
  ['model-evaluation/model_radar.py', 'model-evaluation', '多模型雷达图', 'models across normalised metrics, cost metrics flipped', 'model-evaluation/model_radar'],
  ['model-evaluation/metric_heatmap.py', 'model-evaluation', '模型指标热力图', 'model x metric matrix, best cell ringed per column', 'model-evaluation/metric_heatmap'],
  ['combination/correlation_combined.py', 'combination', '相关性组合图', 'scatter matrix lower triangle + coefficient heatmap upper', 'combination/correlation_combined'],
  ['distribution/paired_distributions.py', 'distribution', '成对分布图', 'half violin + box plot + jittered points per group', 'distribution/paired_distributions'],
  ['distribution/data_overview.py', 'distribution', '数据体检四联图', 'missing rate / distributions / correlation / trend', 'distribution/data_overview'],
  ['flowchart/five_band_roadmap.py', 'flowchart', '五阶段路线图', 'five-stage roadmap with an arrow timeline', 'flowchart/five_band_roadmap'],
  ['flowchart/three_stage_pipeline.py', 'flowchart', '三阶段流水线', 'inputs / processing / outputs with hand-offs', 'flowchart/three_stage_pipeline'],
  ['flowchart/three_column_framework.py', 'flowchart', '三栏研究框架', 'stage / content / methods in three columns', 'flowchart/three_column_framework'],
  ['flowchart/hierarchical_structure.py', 'flowchart', '层次结构图', 'objective to sub-questions to methods', 'flowchart/hierarchical_structure'],
  ['flowchart/horizontal_pipeline.py', 'flowchart', '横版任务流水线', 'left-to-right stages with sub-steps', 'flowchart/horizontal_pipeline'],
  ['machine-learning/feature_importance_beeswarm.py', 'machine-learning', '特征重要性蜂群图', 'ranked importance bars + per-sample beeswarm', 'machine-learning/feature_importance_beeswarm'],
  ['spatial/response_surface_3d.py', 'spatial', '三维响应面', 'response surface with contour floor and optimum', 'spatial/response_surface_3d'],
];

/** Category order: ours first, then the product's sections in guide order. */
const OWN_CATEGORIES = ['combination', 'distribution', 'flowchart', 'machine-learning', 'model-evaluation', 'spatial'];

/** Parses the guide into { id -> { category, title, layout } }. */
function parseGuide() {
  const text = fs.readFileSync(path.join(REFS, 'extended-chart-guide.md'), 'utf8');
  const out = new Map();
  let category = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^## (.+?)\s*$/);
    if (heading) {
      category = CATEGORY_KEYS[heading[1]] ?? null;
      continue;
    }
    const row = line.match(/^\|\s*\d+\s*\|\s*`([a-z0-9-]+)`<br>([^|]+?)\s*\|\s*([^|]*?)\s*\|/);
    if (row && category) out.set(row[1], { category, title: row[2].trim(), layout: row[3].trim() });
  }
  return out;
}

/** Parses the catalog table into an ordered list of { id, script, title }. */
function parseCatalog() {
  const text = fs.readFileSync(path.join(REFS, 'figure-catalog.md'), 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const row = line.match(/^\|\s*`([a-z0-9-]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|/);
    if (row) out.push({ id: row[1], script: row[2], title: row[3].trim() });
  }
  return out;
}

function main() {
  const guide = parseGuide();
  const catalog = parseCatalog();
  const entries = [];

  for (const item of catalog) {
    const meta = guide.get(item.id);
    // Template ids use hyphens; the renderer writes preview files with underscores.
    const previewName = item.id.replace(/-/g, '_');
    const hasPreview = fs.existsSync(path.join(MM_PREVIEWS, `${previewName}.png`));
    const source = fs.readFileSync(
      path.join(BUILTINS, 'mathmodel_figure_templates', 'scripts', 'templates', item.script),
      'utf8'
    );
    const spatial = /cartopy|shapely|mpl_toolkits/.test(source);
    entries.push({
      id: item.id,
      title: meta?.title ?? item.title,
      category: meta?.category ?? 'other',
      description: meta?.layout ?? item.title,
      // `skill` + `script` together say where the template lives: the MathModel set is a
      // skill of its own, the project set lives inside math-figure.
      skill: 'mathmodel-figure-templates',
      script: `scripts/templates/${item.script}`,
      preview: hasPreview ? `mathmodel/${previewName}` : '',
      dependencies: spatial ? ['scipy', 'cartopy', 'shapely'] : ['scipy'],
      available: hasPreview,
    });
  }

  for (const [script, category, title, description, previewPath] of OURS) {
    const hasPreview = fs.existsSync(path.join(OWN_PREVIEWS, `${previewPath}.png`));
    entries.push({
      id: path.basename(script, '.py').replace(/_/g, '-'),
      title,
      category,
      description,
      skill: 'math-figure',
      // `script` is relative to the skill named above, so the two families no longer
      // disagree about what the path is relative to.
      script: `assets/templates/${script}`,
      preview: hasPreview ? previewPath : '',
      dependencies: [],
      available: hasPreview,
    });
  }

  const categoryKeys = [...new Set([...OWN_CATEGORIES, ...entries.map((e) => e.category)])];
  const noPreview = entries.filter((e) => !e.available);

  const lines = [];
  lines.push('/**');
  lines.push(' * Research figure catalogue (科研绘图) for the 扩展 → 模板 page.');
  lines.push(' *');
  lines.push(' * GENERATED FILE — do not edit by hand. Run `pnpm run figures:catalog`.');
  lines.push(' *');
  lines.push(' * Two families:');
  lines.push(' *');
  lines.push(' *  - MathModel figure templates extracted from the installed product, in the');
  lines.push(' *    `mathmodel-figure-templates` skill. Ids, titles, categories and layout notes are');
  lines.push(" *    the product's own metadata.");
  lines.push(' *  - Templates written for this project, under `math_figure/assets/templates/`.');
  lines.push(' *');
  lines.push(' * Previews are rendered here, not copied from the product:');
  lines.push(' *   `pnpm run figures:mathmodel` (MathModel set) and `pnpm run figures:build` (ours).');
  lines.push(' */');
  lines.push('');
  lines.push('export type FigureCategory =');
  for (const key of categoryKeys) lines.push(`  | '${key}'`);
  lines.push(';');
  lines.push('');
  lines.push('export interface FigureEntry {');
  lines.push('  id: string;');
  lines.push('  title: string;');
  lines.push('  category: FigureCategory;');
  lines.push('  description: string;');
  lines.push('  /** Skill that owns the template (both families live in their own skill). */');
  lines.push("  skill: 'math-figure' | 'mathmodel-figure-templates';");
  lines.push('  /** Path of the script, relative to that skill directory. */');
  lines.push('  script: string;');
  lines.push('  /** Preview key under src/assets/figures/, empty when none was rendered. */');
  lines.push('  preview: string;');
  lines.push('  /** Python packages beyond matplotlib the template imports. */');
  lines.push('  dependencies: string[];');
  lines.push('  available: boolean;');
  lines.push('}');
  lines.push('');
  lines.push('export const FIGURE_CATEGORIES: FigureCategory[] = [');
  for (const key of categoryKeys) lines.push(`  '${key}',`);
  lines.push('];');
  lines.push('');
  lines.push('/** Display label per category: [Chinese, English]. */');
  lines.push('export const FIGURE_CATEGORY_LABELS: Record<FigureCategory, [string, string]> = {');
  for (const key of categoryKeys) {
    const label = CATEGORY_LABELS[key] ?? [key, key];
    lines.push(`  '${key}': [${JSON.stringify(label[0])}, ${JSON.stringify(label[1])}],`);
  }
  lines.push('};');
  lines.push('');
  lines.push('export const FIGURE_CATALOG: FigureEntry[] = [');
  for (const entry of entries) {
    lines.push('  {');
    lines.push(`    id: '${entry.id}',`);
    lines.push(`    title: ${JSON.stringify(entry.title)},`);
    lines.push(`    category: '${entry.category}',`);
    lines.push(`    description: ${JSON.stringify(entry.description)},`);
    lines.push(`    skill: '${entry.skill}',`);
    lines.push(`    script: '${entry.script}',`);
    lines.push(`    preview: '${entry.preview}',`);
    lines.push(`    dependencies: [${entry.dependencies.map((d) => `'${d}'`).join(', ')}],`);
    lines.push(`    available: ${entry.available},`);
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  lines.push('/** Preview images, resolved from the renderer asset folder at build time. */');
  lines.push("const PREVIEWS = import.meta.glob<string>('../assets/figures/**/*.png', {");
  lines.push('  eager: true,');
  lines.push("  import: 'default',");
  lines.push('});');
  lines.push('');
  lines.push('/** Thumbnail URL for a catalogue entry, empty string when none was rendered. */');
  lines.push('export function figurePreview(entry: FigureEntry): string {');
  lines.push("  return entry.preview ? (PREVIEWS[`../assets/figures/${entry.preview}.png`] ?? '') : '';");
  lines.push('}');
  lines.push('');
  lines.push('export const AVAILABLE_FIGURE_COUNT = FIGURE_CATALOG.filter((e) => e.available).length;');
  lines.push('');

  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`wrote ${path.relative(DESKTOP, OUT)}`);
  console.log(
    `  ${entries.length} entries (${entries.filter((e) => e.available).length} with a rendered preview)`
  );
  console.log(`  ${categoryKeys.length} categories`);
  if (noPreview.length) {
    console.log(`  no preview for ${noPreview.length}: ${noPreview.map((e) => e.id).join(', ')}`);
  }
}

if (require.main === module) main();

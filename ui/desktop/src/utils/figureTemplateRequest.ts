import type { FigureEntry } from '../catalog/figures';

/**
 * Builds the seeded request for a template. Both families name the skill that owns the
 * template and the script's path inside it; the MathModel set is rendered through its own
 * renderer (which copies the script into the project first), the project set is copied out
 * and run directly.
 */
export function figureTemplateRequest(entry: FigureEntry): string {
  const isMathmodel = entry.skill === 'mathmodel-figure-templates';
  const lines: string[] = [
    `请用 ${entry.skill} 技能内置的绘图模板「${entry.title}」出一张图。`,
    '',
    `模板位置（${entry.skill} 技能目录下）：${entry.script}`,
  ];

  if (isMathmodel) {
    const id = entry.script.replace('scripts/templates/make_', '').replace('.py', '');
    lines.push(
      `渲染方式：先加载 ${entry.skill} 技能，用 scripts/render_template.py 渲染` +
        `（模板 id 为 \`${id}\`，可用 --list 查看全部 id）；脚本会复制到项目里再运行，` +
        '需要改参数时改复制出来的那份。'
    );
  } else {
    lines.push(
      `渲染方式：先加载 ${entry.skill} 技能，把 ${entry.script} 复制到项目 figures/scripts/ 下` +
        '再改参数运行（不要改技能目录里的原件）。'
    );
  }

  lines.push(
    '',
    `产物要求：图表落到当前项目的 figures/ 目录，同时导出矢量（PDF/SVG）与 PNG（DPI ≥ 300）；` +
      `图注只写一句不超过 20 字的图题，解读写成正文段落；中文标签用 SimSun。`
  );
  if (entry.dependencies.length > 0) {
    lines.push(`额外依赖：${['matplotlib', ...entry.dependencies].join('、')}。`);
  }
  lines.push('', '我的数据与要表达的信息：', '（把数据路径或要点写在这里）');
  return lines.join('\n');
}

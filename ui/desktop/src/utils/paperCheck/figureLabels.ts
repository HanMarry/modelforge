/**
 * Figure labels (spec mathmodel-parity-and-beyond, requirement 18.3): every chart the paper
 * shows needs an x-axis label, a y-axis label and the physical unit of each. Figures whose
 * content cannot be read are listed as "无法检查" and never count as passed.
 *
 * Pure functions over the figure's content; the caller reads the files.
 *
 * - Matplotlib SVG: the backend writes one `<g id="axes_N">` per axes and inside it one
 *   `<g id="matplotlib.axis_K">` per axis, the x axis first. Tick labels sit in `xtick_*` or
 *   `ytick_*` groups; the other `text_*` groups of an axis group are the axis label and the
 *   offset text (`1e6`). Text is a `<text>` element (`svg.fonttype: none`) or, by default, glyph
 *   paths preceded by a comment holding the text. An axis without ticks and without label is
 *   hidden (the short side of a colour bar) and needs no label; an SVG without visible axes (a
 *   pie chart, an image with `axis('off')`) passes.
 * - Plotly SVG: `<text class="xtitle">` and `<text class="ytitle">` of the cartesian layer.
 * - PDF (first page, from pdfjs): the lowest horizontal text in the bottom quarter is the x
 *   label, the leftmost vertical text in the left quarter the y label. Text made only of
 *   digits, signs and math such as `1e6` or `\times10^{3}` is a tick label, not a label. A PDF
 *   with fewer than two tick-like texts is not recognisably a chart and cannot be checked.
 * - Bitmaps (PNG, JPEG, …) carry no text layer, and matplotlib's PNG metadata holds no labels,
 *   so they cannot be checked. EPS is not read. Other SVGs have no axis structure to go by.
 *
 * A label has a unit when it contains a bracketed part (`时间 (s)`, `成本（元）`, `v [m/s]`),
 * ISO notation (`t / s`), `%`, `‰`, `°`, `℃` or the word `单位`/`unit`. Labels naming a
 * dimensionless quantity (frequency, probability, count, index, rank, score, year, …) need none.
 */

import type { PaperCheckVerdict } from './common';
import type { PdfPageText } from './pdfTextLayer';

export type FigureLabelPart = 'x-label' | 'y-label' | 'x-unit' | 'y-unit';

export type FigureUnreadableReason =
  | 'bitmap'
  | 'unsupported-format'
  | 'no-axes-structure'
  | 'no-text'
  | 'parse-error';

export type FigureAnalysis =
  | { status: 'checked'; missing: FigureLabelPart[] }
  | { status: 'unreadable'; reason: FigureUnreadableReason };

export type FigureFormat = 'svg' | 'pdf' | 'bitmap' | 'unsupported';

export interface FigureResult {
  /** Project-relative path of the figure. */
  path: string;
  analysis: FigureAnalysis;
}

export interface FigureLabelsReport {
  verdict: PaperCheckVerdict;
  /** `figures`: the paper shows no figure; `readable-figures`: none could be read. */
  missing: 'figures' | 'readable-figures' | null;
  /** Figures with missing labels or units, in input order. */
  incomplete: Array<{ path: string; missing: FigureLabelPart[] }>;
  /** Figures listed as "无法检查". */
  unreadable: Array<{ path: string; reason: FigureUnreadableReason }>;
  /** Figures whose content was checked. */
  checked: number;
}

const PART_ORDER: readonly FigureLabelPart[] = ['x-label', 'y-label', 'x-unit', 'y-unit'];

const BITMAP_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff'];

const UNIT_PATTERNS: readonly RegExp[] = [
  /[(（[［【〔][^)）\]］】〕]*\S[^)）\]］】〕]*[)）\]］】〕]/,
  /\s\/\s*\S/,
  /[%‰°℃℉]/,
  /单位|\bunits?\b/i,
];

/** Dimensionless quantities whose axis needs no unit. */
const DIMENSIONLESS =
  /频数|频率|概率|比例|占比|比率|比值|次数|数量|个数|人数|序号|编号|排名|名次|指数|系数|相关|得分|评分|分数|权重|年份|年度|月份|日期|迭代|代数|轮次|样本|frequency|count|probability|ratio|proportion|fraction|share|index|rank|score|weight|coefficient|correlation|iteration|epoch|generation|year|month|date|sample|number of/i;

/** Format of a figure file by extension. */
export function figureFormat(path: string): FigureFormat {
  const lower = path.toLowerCase();
  if (lower.endsWith('.svg')) {
    return 'svg';
  }
  if (lower.endsWith('.pdf')) {
    return 'pdf';
  }
  const bitmap = BITMAP_EXTENSIONS.some((extension) => lower.endsWith(extension));
  return bitmap ? 'bitmap' : 'unsupported';
}

/** Whether an axis label states a unit, or names a quantity that has none. */
export function hasUnit(label: string): boolean {
  const text = label.normalize('NFKC');
  return UNIT_PATTERNS.some((pattern) => pattern.test(text)) || DIMENSIONLESS.test(text);
}

/**
 * Tick labels and offset texts: nothing but digits, signs, separators and math once TeX
 * commands, `$`, braces, `^`, `_`, spaces and exponents (`1e6`) are removed.
 */
export function isTickText(text: string): boolean {
  const stripped = text
    .normalize('NFKC')
    .replace(/\\[A-Za-z]+/g, '')
    .replace(/[$\s{}^_]/g, '')
    .replace(/(\d)[eE][+\-−]?(?=\d)/g, '$1');
  return !/\p{L}/u.test(stripped);
}

function isLabelText(text: string): boolean {
  return text.trim() !== '' && !isTickText(text);
}

export interface AxisLabels {
  /** `null` when the axis is hidden; `''` when visible without a label. */
  x: string | null;
  y: string | null;
}

/**
 * What the axes lack: a visible axis without a label misses its label, a label without a unit
 * misses the unit. A part missing on several axes of the figure counts once.
 */
export function missingParts(axes: readonly AxisLabels[]): FigureLabelPart[] {
  const missing = new Set<FigureLabelPart>();
  const inspect = (
    label: string | null,
    labelPart: FigureLabelPart,
    unitPart: FigureLabelPart
  ): void => {
    if (label === null) {
      return;
    }
    if (label === '') {
      missing.add(labelPart);
    } else if (!hasUnit(label)) {
      missing.add(unitPart);
    }
  };
  for (const axis of axes) {
    inspect(axis.x, 'x-label', 'x-unit');
    inspect(axis.y, 'y-label', 'y-unit');
  }
  return PART_ORDER.filter((part) => missing.has(part));
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = parseInt(entity.slice(2), 16);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    if (entity.startsWith('#')) {
      const code = parseInt(entity.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[entity] ?? all;
  });
}

interface SvgTextEvent {
  text: string;
  /** Ids and classes of the enclosing elements, outermost first. */
  ancestors: Array<{ name: string; id: string; className: string }>;
  /** From a comment (matplotlib path text) rather than character data. */
  comment: boolean;
}

const SVG_TOKEN =
  /<!--([\s\S]*?)-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[?!][^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attributes);
  return match === null ? '' : decodeEntities(match[2] ?? match[3] ?? '');
}

const TEXT_ELEMENTS = new Set(['text', 'tspan', 'textPath']);
const SKIPPED_ELEMENTS = new Set(['style', 'script', 'metadata', 'defs', 'title', 'desc']);

/** Character data of `<text>` elements and every comment, with their enclosing elements. */
function svgTextEvents(svg: string): SvgTextEvent[] {
  const events: SvgTextEvent[] = [];
  const stack: Array<{ name: string; id: string; className: string }> = [];
  let skippedDepth = 0;
  for (const match of svg.matchAll(SVG_TOKEN)) {
    const [, comment, cdata, closing, name, rawAttributes, characters] = match;
    if (comment !== undefined) {
      if (skippedDepth === 0) {
        events.push({ text: comment.trim(), ancestors: [...stack], comment: true });
      }
      continue;
    }
    if (name !== undefined) {
      const attributes = rawAttributes ?? '';
      const selfClosing = attributes.trimEnd().endsWith('/');
      if (closing === '/') {
        // Pop up to and including the matching element; tolerate unbalanced markup.
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) {
            const removed = stack.splice(i);
            skippedDepth -= removed.filter(({ name: n }) => SKIPPED_ELEMENTS.has(n)).length;
            break;
          }
        }
        continue;
      }
      if (selfClosing) {
        continue;
      }
      stack.push({
        name,
        id: attribute(attributes, 'id'),
        className: attribute(attributes, 'class'),
      });
      if (SKIPPED_ELEMENTS.has(name)) {
        skippedDepth++;
      }
      continue;
    }
    const data = cdata ?? characters;
    if (data === undefined || skippedDepth > 0) {
      continue;
    }
    const innermost = stack[stack.length - 1];
    if (innermost !== undefined && TEXT_ELEMENTS.has(innermost.name) && data.trim() !== '') {
      events.push({ text: decodeEntities(data), ancestors: [...stack], comment: false });
    }
  }
  return events;
}

/** Text of each `text`/`tspan` chain joined, keyed by the enclosing `<text>` element. */
function joinTextRuns(events: readonly SvgTextEvent[]): SvgTextEvent[] {
  const joined: SvgTextEvent[] = [];
  let last: { owner: object; event: SvgTextEvent } | null = null;
  for (const event of events) {
    const owner = event.comment
      ? null
      : event.ancestors.find(({ name }) => name === 'text') ?? null;
    if (owner !== null && last !== null && last.owner === owner) {
      last.event.text += event.text;
      continue;
    }
    const copy = { ...event };
    joined.push(copy);
    last = owner === null ? null : { owner, event: copy };
  }
  return joined;
}

function nearest(
  ancestors: SvgTextEvent['ancestors'],
  test: (id: string) => boolean
): string | null {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (test(ancestors[i].id)) {
      return ancestors[i].id;
    }
  }
  return null;
}

const MPL_AXES = /^axes_\d+$/;
const MPL_AXIS = /^matplotlib\.axis_\d+$|^axis3d_\d+$/;
const MPL_TICK = /^[xyz]tick_\d+$/;
const MPL_TEXT = /^text_\d+$/;

function analyzeMatplotlib(events: readonly SvgTextEvent[], svg: string): FigureAnalysis {
  interface AxesInfo {
    axisOrder: string[];
    ticks: Set<string>;
    labels: Map<string, string[]>;
  }
  const axes = new Map<string, AxesInfo>();
  const axesOf = (id: string): AxesInfo => {
    let info = axes.get(id);
    if (info === undefined) {
      info = { axisOrder: [], ticks: new Set(), labels: new Map() };
      axes.set(id, info);
    }
    return info;
  };

  // Axis and tick groups in document order, including those without any text: a tick group
  // always follows the opening tag of its axis group, and an axis group that of its axes.
  let currentAxes: AxesInfo | null = null;
  let currentAxis: string | null = null;
  for (const match of svg.matchAll(/<g\b[^>]*\bid\s*=\s*"([^"]+)"/g)) {
    const id = match[1];
    if (MPL_AXES.test(id)) {
      currentAxes = axesOf(id);
      currentAxis = null;
    } else if (MPL_AXIS.test(id) && currentAxes !== null) {
      if (!currentAxes.axisOrder.includes(id)) {
        currentAxes.axisOrder.push(id);
      }
      currentAxis = id;
    } else if (MPL_TICK.test(id) && currentAxes !== null && currentAxis !== null) {
      currentAxes.ticks.add(currentAxis);
    }
  }

  for (const event of events) {
    const axesId = nearest(event.ancestors, (id) => MPL_AXES.test(id));
    const axisId = nearest(event.ancestors, (id) => MPL_AXIS.test(id));
    if (axesId === null || axisId === null) {
      continue;
    }
    const info = axesOf(axesId);
    if (!info.axisOrder.includes(axisId)) {
      info.axisOrder.push(axisId);
    }
    if (nearest(event.ancestors, (id) => MPL_TICK.test(id)) !== null) {
      info.ticks.add(axisId);
      continue;
    }
    // Path text is only the comment inside a `text_*` group; other comments are not text.
    if (event.comment && nearest(event.ancestors, (id) => MPL_TEXT.test(id)) === null) {
      continue;
    }
    const labels = info.labels.get(axisId) ?? [];
    labels.push(event.text);
    info.labels.set(axisId, labels);
  }

  const found: AxisLabels[] = [];
  for (const info of axes.values()) {
    const [xAxis, yAxis] = info.axisOrder;
    const side = (axisId: string | undefined): string | null => {
      if (axisId === undefined) {
        return null;
      }
      const texts = info.labels.get(axisId) ?? [];
      const label = texts.find(isLabelText);
      if (label !== undefined) {
        return label.trim();
      }
      return info.ticks.has(axisId) ? '' : null;
    };
    found.push({ x: side(xAxis), y: side(yAxis) });
  }
  return { status: 'checked', missing: missingParts(found) };
}

function analyzePlotly(svg: string): FigureAnalysis {
  const title = (className: string): string => {
    const pattern = new RegExp(
      `<text\\b[^>]*\\bclass\\s*=\\s*"[^"]*\\b${className}\\b[^"]*"[^>]*>([\\s\\S]*?)</text>`
    );
    const match = pattern.exec(svg);
    return match === null ? '' : decodeEntities(match[1].replace(/<[^>]*>/g, '')).trim();
  };
  const x = title('xtitle');
  const y = title('ytitle');
  return {
    status: 'checked',
    missing: missingParts([{ x: isLabelText(x) ? x : '', y: isLabelText(y) ? y : '' }]),
  };
}

/** Labels of an SVG chart made by matplotlib or plotly; other SVGs cannot be checked. */
export function analyzeSvgFigure(svg: string): FigureAnalysis {
  try {
    if (/\bid\s*=\s*"(?:matplotlib\.axis_\d+|axes_\d+)"/.test(svg) || /matplotlib/i.test(svg)) {
      return analyzeMatplotlib(joinTextRuns(svgTextEvents(svg)), svg);
    }
    if (/\bclass\s*=\s*"[^"]*\bcartesianlayer\b/.test(svg)) {
      return analyzePlotly(svg);
    }
    return { status: 'unreadable', reason: 'no-axes-structure' };
  } catch {
    return { status: 'unreadable', reason: 'parse-error' };
  }
}

interface PdfLine {
  text: string;
  x: number;
  y: number;
}

function groupPdfLines(
  items: PdfPageText['items'],
  vertical: boolean,
  page: PdfPageText
): PdfLine[] {
  const tolerance = Math.max(page.width, page.height) * 0.01;
  const lines: Array<PdfLine & { parts: Array<{ text: string; at: number }> }> = [];
  for (const item of items) {
    // Horizontal lines share a baseline y; vertical ones share x.
    const key = vertical ? item.x : item.y;
    const at = vertical ? item.y : item.x;
    let line = lines.find(
      (candidate) => Math.abs((vertical ? candidate.x : candidate.y) - key) <= tolerance
    );
    if (line === undefined) {
      line = { text: '', x: item.x, y: item.y, parts: [] };
      lines.push(line);
    }
    line.parts.push({ text: item.text, at });
    line.x = Math.min(line.x, item.x);
    line.y = Math.min(line.y, item.y);
  }
  return lines.map(({ parts, x, y }) => ({
    text: parts
      .sort((a, b) => a.at - b.at)
      .map(({ text }) => text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
    x,
    y,
  }));
}

function isVertical(angle: number): boolean {
  const normalized = ((angle % 360) + 360) % 360;
  return Math.abs(normalized - 90) <= 10 || Math.abs(normalized - 270) <= 10;
}

function isHorizontal(angle: number): boolean {
  const normalized = ((angle % 360) + 360) % 360;
  return normalized <= 10 || normalized >= 350;
}

/** Labels of a chart saved as PDF, from the text layer of its first page. */
export function analyzePdfFigure(page: PdfPageText | undefined): FigureAnalysis {
  const items = (page?.items ?? []).filter(({ text }) => text.trim() !== '');
  if (page === undefined || items.length === 0) {
    return { status: 'unreadable', reason: 'no-text' };
  }
  const ticks = items.filter(({ text }) => isTickText(text));
  if (ticks.length < 2) {
    return { status: 'unreadable', reason: 'no-axes-structure' };
  }
  const horizontal = groupPdfLines(
    items.filter(({ angle }) => isHorizontal(angle)),
    false,
    page
  );
  const vertical = groupPdfLines(
    items.filter(({ angle }) => isVertical(angle)),
    true,
    page
  );
  const xLabel = horizontal
    .filter(({ text, y }) => isLabelText(text) && y <= page.height * 0.25)
    .sort((a, b) => a.y - b.y)[0];
  const yLabel = vertical
    .filter(({ text, x }) => isLabelText(text) && x <= page.width * 0.25)
    .sort((a, b) => a.x - b.x)[0];
  return {
    status: 'checked',
    missing: missingParts([{ x: xLabel?.text ?? '', y: yLabel?.text ?? '' }]),
  };
}

/** Requirement 18.3: the verdict over every figure the paper shows. */
export function checkFigureLabels(results: readonly FigureResult[]): FigureLabelsReport {
  const incomplete: FigureLabelsReport['incomplete'] = [];
  const unreadable: FigureLabelsReport['unreadable'] = [];
  let checked = 0;
  for (const { path, analysis } of results) {
    if (analysis.status === 'unreadable') {
      unreadable.push({ path, reason: analysis.reason });
      continue;
    }
    checked++;
    if (analysis.missing.length > 0) {
      incomplete.push({ path, missing: analysis.missing });
    }
  }
  const base = { incomplete, unreadable, checked };
  if (results.length === 0) {
    return { verdict: '无法执行', missing: 'figures', ...base };
  }
  if (incomplete.length > 0) {
    return { verdict: '发现问题', missing: null, ...base };
  }
  if (checked === 0) {
    return { verdict: '无法执行', missing: 'readable-figures', ...base };
  }
  return { verdict: unreadable.length > 0 ? '发现问题' : '通过', missing: null, ...base };
}

/** Image targets of a Markdown file: `![alt](path "title")` and `<img src="path">`. */
export function extractMarkdownImages(text: string): Array<{ target: string; line: number }> {
  const images: Array<{ target: string; line: number }> = [];
  text.split(/\r\n|\r|\n/).forEach((line, index) => {
    for (const match of line.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^)]*["'])?\s*\)/g)) {
      images.push({ target: match[1], line: index + 1 });
    }
    for (const match of line.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) {
      images.push({ target: match[1], line: index + 1 });
    }
  });
  return images
    .filter(({ target }) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target))
    .map(({ target, line }) => ({ target: decodePercent(target), line }));
}

/** `my%20plot.png` → `my plot.png`; malformed escapes are kept as written. */
function decodePercent(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

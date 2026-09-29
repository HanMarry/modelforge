import { describe, expect, it } from 'vitest';
import {
  analyzePdfFigure,
  analyzeSvgFigure,
  checkFigureLabels,
  extractMarkdownImages,
  figureFormat,
  hasUnit,
  isTickText,
  type FigureResult,
} from './figureLabels';
import type { PdfPageText, PdfTextItem } from './pdfTextLayer';

interface AxisSpec {
  ticks: string[];
  label?: string;
  offset?: string;
}

/** A matplotlib-shaped SVG; `null` axes are drawn as empty (hidden) axis groups. */
function mplSvg(
  axes: Array<{ x: AxisSpec | null; y: AxisSpec | null }>,
  mode: 'path' | 'none' = 'path'
): string {
  let axisId = 0;
  let textId = 0;
  const escape = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const text = (content: string) => {
    textId++;
    return mode === 'path'
      ? `<g id="text_${textId}">\n<!-- ${content} -->\n<g transform="scale(0.1)"><defs><path id="g${textId}" d="M 0 0"/></defs><use xlink:href="#g${textId}"/></g>\n</g>`
      : `<g id="text_${textId}"><text x="1" y="2" style="font: 10px 'DejaVu Sans'">${escape(content)}</text></g>`;
  };
  const axis = (spec: AxisSpec | null, side: 'x' | 'y') => {
    axisId++;
    if (spec === null) {
      return `<g id="matplotlib.axis_${axisId}"/>`;
    }
    const ticks = spec.ticks
      .map(
        (tick, i) =>
          `<g id="${side}tick_${axisId * 10 + i}"><g id="line2d_${axisId * 10 + i}"><use xlink:href="#m" x="1" y="1"/></g>${tick === '' ? '' : text(tick)}</g>`
      )
      .join('\n');
    const label = spec.label === undefined ? '' : text(spec.label);
    const offset = spec.offset === undefined ? '' : text(spec.offset);
    return `<g id="matplotlib.axis_${axisId}">\n${ticks}\n${label}\n${offset}\n</g>`;
  };
  const body = axes
    .map(
      ({ x, y }, i) =>
        `<g id="axes_${i + 1}">\n<g id="patch_${i + 2}"><path d="M 0 0"/></g>\n${axis(x, 'x')}\n${axis(y, 'y')}\n${text('Title')}\n<g id="legend_${i + 1}">${text('series')}</g>\n</g>`
    )
    .join('\n');
  return [
    '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink" width="460pt" height="345pt" xmlns="http://www.w3.org/2000/svg">',
    ' <metadata><rdf:RDF><cc:Work><dc:title>Matplotlib v3.8.0, https://matplotlib.org/</dc:title></cc:Work></rdf:RDF></metadata>',
    ' <defs><style type="text/css">*{stroke-linejoin: round}</style></defs>',
    ' <g id="figure_1">',
    body,
    ' </g>',
    '</svg>',
  ].join('\n');
}

describe('hasUnit and isTickText', () => {
  it('recognises brackets, ISO notation, symbols and dimensionless quantities', () => {
    for (const label of ['时间 (s)', '成本（元）', 'v [m/s]', 't / s', '增长率 %', '温度 ℃', '单位：万人']) {
      expect(hasUnit(label), label).toBe(true);
    }
    for (const label of ['Frequency', '概率', 'Number of cities', '年份']) {
      expect(hasUnit(label), label).toBe(true);
    }
    for (const label of ['Time', '距离', 'Voltage']) {
      expect(hasUnit(label), label).toBe(false);
    }
  });

  it('treats digits, signs and math as tick text', () => {
    for (const text of ['−2', '0.5', '$\\mathdefault{10^{3}}$', '1e6', '+1.234e3', '$\\times10^{6}$']) {
      expect(isTickText(text), text).toBe(true);
    }
    for (const text of ['Jan', 'Time (s)', '$v$ (m/s)']) {
      expect(isTickText(text), text).toBe(false);
    }
  });
});

describe('analyzeSvgFigure', () => {
  it('reads axis labels from matplotlib path text comments', () => {
    const svg = mplSvg([
      {
        x: { ticks: ['0', '1'], label: '时间 (s)' },
        y: { ticks: ['0.5'], label: 'Voltage', offset: '$\\times10^{3}$' },
      },
    ]);
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'checked', missing: ['y-unit'] });
  });

  it('reads <text> elements and joins tspans', () => {
    const svg = mplSvg([{ x: { ticks: ['0'], label: 'Time (s)' }, y: { ticks: ['1'] } }], 'none')
      .replace('>Time (s)<', '><tspan>Time</tspan><tspan> (s)</tspan><');
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'checked', missing: ['y-label'] });
  });

  it('reports missing labels and skips hidden axes such as a colour bar side', () => {
    const svg = mplSvg([
      { x: { ticks: ['0', '1'] }, y: { ticks: ['0', '1'] } },
      { x: null, y: { ticks: ['0.0', '0.5'] } },
    ]);
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'checked', missing: ['x-label', 'y-label'] });

    const colourBar = mplSvg([
      { x: { ticks: ['0'], label: 'x (m)' }, y: { ticks: ['0'], label: 'y (m)' } },
      { x: null, y: { ticks: ['0.0', '0.5'] } },
    ]);
    expect(analyzeSvgFigure(colourBar)).toEqual({ status: 'checked', missing: ['y-label'] });
  });

  it('counts an axis with tick marks but no tick labels as visible', () => {
    const svg = mplSvg([{ x: { ticks: [''] }, y: { ticks: ['1'], label: '成本（元）' } }]);
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'checked', missing: ['x-label'] });
  });

  it('passes a matplotlib figure without axes', () => {
    const svg = mplSvg([]).replace(' <g id="figure_1">', ' <g id="figure_1"><g id="axes_1"/>');
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'checked', missing: [] });
  });

  it('reads plotly titles', () => {
    const svg =
      '<svg class="main-svg"><g class="cartesianlayer"><g class="xtick"><text>0</text></g></g>' +
      '<g class="infolayer"><text class="xtitle" x="1">Time (s)</text>' +
      '<text class="ytitle">Count</text></g></svg>';
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'checked', missing: [] });
  });

  it('cannot check other SVGs', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>';
    expect(analyzeSvgFigure(svg)).toEqual({ status: 'unreadable', reason: 'no-axes-structure' });
  });
});

function item(text: string, x: number, y: number, angle = 0): PdfTextItem {
  return { text, x, y, angle, endOfLine: false };
}

function pdfPage(items: PdfTextItem[]): PdfPageText {
  return { page: 1, width: 400, height: 300, items };
}

describe('analyzePdfFigure', () => {
  const ticks = [item('0', 50, 40), item('1', 150, 40), item('2', 250, 40), item('10', 30, 100)];

  it('finds the x label at the bottom and the rotated y label on the left', () => {
    const page = pdfPage([
      ...ticks,
      item('Time', 170, 15),
      item('(s)', 200, 15),
      item('Voltage', 12, 150, 90),
      item('标题', 180, 280),
    ]);
    expect(analyzePdfFigure(page)).toEqual({ status: 'checked', missing: ['y-unit'] });
  });

  it('reports both labels missing when only ticks are present', () => {
    expect(analyzePdfFigure(pdfPage([...ticks, item('标题', 180, 280)]))).toEqual({
      status: 'checked',
      missing: ['x-label', 'y-label'],
    });
  });

  it('cannot check a PDF without text or without tick labels', () => {
    expect(analyzePdfFigure(pdfPage([]))).toEqual({ status: 'unreadable', reason: 'no-text' });
    expect(analyzePdfFigure(undefined)).toEqual({ status: 'unreadable', reason: 'no-text' });
    expect(analyzePdfFigure(pdfPage([item('流程图', 10, 10), item('开始', 50, 50)]))).toEqual({
      status: 'unreadable',
      reason: 'no-axes-structure',
    });
  });
});

describe('checkFigureLabels', () => {
  const ok: FigureResult = { path: 'fig/a.svg', analysis: { status: 'checked', missing: [] } };
  const incomplete: FigureResult = {
    path: 'fig/b.pdf',
    analysis: { status: 'checked', missing: ['x-unit'] },
  };
  const bitmap: FigureResult = {
    path: 'fig/c.png',
    analysis: { status: 'unreadable', reason: 'bitmap' },
  };

  it('passes only when every figure was checked and complete', () => {
    expect(checkFigureLabels([ok]).verdict).toBe('通过');
    expect(checkFigureLabels([ok, incomplete])).toMatchObject({
      verdict: '发现问题',
      incomplete: [{ path: 'fig/b.pdf', missing: ['x-unit'] }],
      checked: 2,
    });
    // Unreadable figures never count as passed (18.3).
    expect(checkFigureLabels([ok, bitmap])).toMatchObject({
      verdict: '发现问题',
      unreadable: [{ path: 'fig/c.png', reason: 'bitmap' }],
    });
  });

  it('cannot run without figures or without any readable figure', () => {
    expect(checkFigureLabels([])).toMatchObject({ verdict: '无法执行', missing: 'figures' });
    expect(checkFigureLabels([bitmap])).toMatchObject({
      verdict: '无法执行',
      missing: 'readable-figures',
    });
  });
});

describe('figure helpers', () => {
  it('classifies figure files by extension', () => {
    expect(figureFormat('fig/A.SVG')).toBe('svg');
    expect(figureFormat('fig/a.pdf')).toBe('pdf');
    expect(figureFormat('fig/a.JPeG')).toBe('bitmap');
    expect(figureFormat('fig/a.eps')).toBe('unsupported');
  });

  it('extracts local Markdown images', () => {
    const text = [
      '![图 1](fig/a%20b.png "caption")',
      'text <img src="fig/c.svg" width="300"> more',
      '![remote](https://example.org/x.png) ![anchor](#top) ![](<fig/d e.pdf>)',
    ].join('\n');
    expect(extractMarkdownImages(text)).toEqual([
      { target: 'fig/a b.png', line: 1 },
      { target: 'fig/c.svg', line: 2 },
    ]);
  });
});

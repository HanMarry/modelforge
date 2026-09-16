#!/usr/bin/env node
/**
 * Generates the two vector deliverables from src/brand-mark.json:
 *
 *   src/images/icon.svg                      (flatpak/scalable icon)
 *   src/components/icons/ModelForge.tsx      (in-app mark + wordmark)
 *
 * Both files are generated — edit brand-mark.json (via scripts/build-brand-mark.js)
 * instead, then re-run this script.
 *
 * Usage: node scripts/build-brand-vector.js [--check]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MARK = path.join(ROOT, 'src', 'brand-mark.json');
const SVG_OUT = path.join(ROOT, 'src', 'images', 'icon.svg');
const TSX_OUT = path.join(ROOT, 'src', 'components', 'icons', 'ModelForge.tsx');

const BANNER = 'GENERATED FILE — do not edit by hand.';

function hex(colour) {
  return `#${[colour.r, colour.g, colour.b]
    .map((channel) => channel.toString(16).padStart(2, '0'))
    .join('')}`;
}

function buildSvg(mark, size, padding) {
  // Polygons are stored on the 24-unit grid; scale that grid into the canvas.
  const grid = mark.viewBox;
  const scale = size / (1 + padding * 2) / Math.max(mark.source.width, mark.source.height);
  const pixelScale = (scale * mark.source.width) / grid;
  const drawWidth = grid * pixelScale;
  const drawHeight = ((mark.source.height / mark.source.width) * grid) * pixelScale;
  const offsetX = (size - drawWidth) / 2;
  const offsetY = (size - drawHeight) / 2;

  const paths = mark.faces.map((face) => {
    const points = face.polygon
      .map((point) => {
        const x = (offsetX + point.x * pixelScale).toFixed(1);
        const y = (offsetY + point.y * pixelScale).toFixed(1);
        return `${x} ${y}`;
      })
      .join(' L');
    return `  <path fill="${hex(face.colour)}" d="M${points} Z"/>`;
  });

  return [
    `<!-- ${BANNER} Source: src/brand-mark.json -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    ...paths,
    '</svg>',
    '',
  ].join('\n');
}

function buildTsx(mark) {
  const constants = mark.faces
    .map((face) => `const ${face.role.toUpperCase()} = '${hex(face.colour)}';`)
    .join('\n');

  const paths = mark.faces
    .map((face) => {
      const d =
        face.polygon
          .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
          .join(' ') + ' Z';
      return `      <path\n        d="${d}"\n        fill={${face.role.toUpperCase()}}\n      />`;
    })
    .join('\n');

  return `// ${BANNER} Source: src/brand-mark.json
import { cn } from '../../utils';

${constants}

/**
 * The ModelForge mark: an isometric cube of four faces, traced from the brand
 * artwork. Each polygon was fitted to the source mask and checked to IoU > 0.95
 * by scripts/build-brand-mark.js; the raster icons are rendered from the same
 * artwork by scripts/build-brand-icons.js.
 */
export function ModelForgeMark({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 ${mark.viewBox} ${mark.viewBox}"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
${paths}
    </svg>
  );
}

export function ModelForgeWordmark({ className = '' }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <ModelForgeMark className="h-[1.15em] w-[1.15em]" />
      <span>
        Model<span style={{ color: ACCENT }}>Forge</span>
      </span>
    </span>
  );
}
`;
}

function main() {
  const check = process.argv.includes('--check');
  const mark = JSON.parse(fs.readFileSync(MARK, 'utf8'));

  const outputs = [
    { file: SVG_OUT, content: buildSvg(mark, 512, 0.14) },
    { file: TSX_OUT, content: buildTsx(mark) },
  ];

  let stale = 0;
  for (const { file, content } of outputs) {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing === content) {
      console.log(`up to date  ${path.relative(ROOT, file)}`);
      continue;
    }
    if (check) {
      stale++;
      console.log(`STALE       ${path.relative(ROOT, file)}`);
    } else {
      fs.writeFileSync(file, content);
      console.log(`wrote       ${path.relative(ROOT, file)}`);
    }
  }

  if (check && stale) process.exitCode = 1;
}

if (require.main === module) main();

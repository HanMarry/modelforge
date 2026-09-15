#!/usr/bin/env node
/**
 * Derives src/brand-mark.json from the brand artwork: four verified face
 * polygons on a 24x24 grid plus each face's sampled colour.
 *
 * The polygons come from tracing the artwork's connected regions, then fitting a
 * least-squares line to every straight boundary run and intersecting neighbours
 * (scripts/build-brand-icons.js exposes the tracing helpers). That reconstructs
 * the artwork's clean edges instead of the pixel staircase, and every polygon is
 * checked against the source mask before being written.
 *
 * src/images/icon.svg and src/components/icons/ModelForge.tsx are both generated
 * from this file, so the raster icons and the in-app vector mark cannot drift.
 *
 * Usage: node scripts/build-brand-mark.js
 */
const fs = require('fs');
const path = require('path');
const m = require('./build-brand-icons.js');

const IMAGES = path.join(__dirname, '..', 'src', 'images');
const OUTPUT = path.join(__dirname, '..', 'src', 'brand-mark.json');

const NEIGHBOURS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

function reduce(points, epsilon) {
  if (points.length < 3) return points.slice();
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= epsilon) return [points[0], points[points.length - 1]];
  return [
    ...reduce(points.slice(0, index + 1), epsilon).slice(0, -1),
    ...reduce(points.slice(index), epsilon),
  ];
}

function fitLine(points) {
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += p.x;
    my += p.y;
  }
  mx /= points.length;
  my /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { point: { x: mx, y: my }, direction: { x: Math.cos(theta), y: Math.sin(theta) } };
}

function intersect(a, b) {
  const denominator = a.direction.x * b.direction.y - a.direction.y * b.direction.x;
  if (Math.abs(denominator) < 0.05) return null;
  const dx = b.point.x - a.point.x;
  const dy = b.point.y - a.point.y;
  const t = (dx * b.direction.y - dy * b.direction.x) / denominator;
  return { x: a.point.x + t * a.direction.x, y: a.point.y + t * a.direction.y };
}

/** Fits clean straight edges to a staircase boundary. */
function straighten(outline, epsilon = 1.0) {
  let far = 0;
  let best = -1;
  for (let i = 1; i < outline.length; i++) {
    const distance = Math.hypot(outline[i].x - outline[0].x, outline[i].y - outline[0].y);
    if (distance > best) {
      best = distance;
      far = i;
    }
  }
  const rotated = [...outline.slice(far), ...outline.slice(0, far), outline[far]];
  const vertices = reduce(rotated, epsilon);
  vertices.pop();
  if (vertices.length < 3) return null;

  const lines = vertices.map((a, i) => {
    const b = vertices[(i + 1) % vertices.length];
    const run = rotated.filter((p) => Math.hypot(p.x - a.x, p.y - a.y) < 1 || Math.hypot(p.x - b.x, p.y - b.y) < 1);
    return fitLine(run.length >= 2 ? run : [a, b]);
  });

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(intersect(lines[i], lines[(i + 1) % lines.length]) ?? lines[i].point);
  }

  // Line fits that straddle a faint corner introduce near-duplicate vertices;
  // drop any vertex that barely deviates from the edge between its neighbours.
  let pruned = true;
  while (pruned && result.length > 3) {
    pruned = false;
    for (let i = 0; i < result.length; i++) {
      const previous = result[(i - 1 + result.length) % result.length];
      const next = result[(i + 1) % result.length];
      if (perpendicularDistance(result[i], previous, next) < 0.35) {
        result.splice(i, 1);
        pruned = true;
        break;
      }
    }
  }
  return result;
}

/** Ordered boundary trace of a simple 8-connected region. */
function trace(mask, width, height, members, start) {
  const isBoundary = (x, y) =>
    NEIGHBOURS.some(([dx, dy]) => {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) return true;
      return !mask[ny * width + nx];
    });

  const outline = [{ x: start.x, y: start.y }];
  const visited = new Set([`${start.x},${start.y}`]);
  let current = { ...start };
  let previousDirection = 0;

  for (let step = 0; step < members.length * 8; step++) {
    let moved = false;
    for (let turn = 0; turn < 8; turn++) {
      const direction = (previousDirection + 6 + turn) % 8;
      const [dx, dy] = NEIGHBOURS[direction];
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!mask[ny * width + nx] || !isBoundary(nx, ny)) continue;
      const isStart = nx === start.x && ny === start.y;
      const key = `${nx},${ny}`;
      if (visited.has(key) && !isStart) continue;
      if (isStart && outline.length < 8) continue;
      current = { x: nx, y: ny };
      previousDirection = direction;
      if (isStart) return outline;
      outline.push(current);
      visited.add(key);
      moved = true;
      break;
    }
    if (!moved) break;
  }
  return outline;
}

function polygonMask(points, width, height) {
  const mask = new Uint8Array(width * height);
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p.y))));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y))));
  for (let y = minY; y <= maxY; y++) {
    const crossings = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (a.y === b.y) continue;
      const yc = y + 0.5;
      if ((yc >= a.y && yc < b.y) || (yc >= b.y && yc < a.y)) {
        crossings.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      for (let x = Math.max(0, Math.round(crossings[i])); x <= Math.min(width - 1, Math.round(crossings[i + 1])); x++) {
        mask[y * width + x] = 1;
      }
    }
  }
  return mask;
}

function main() {
  const image = m.decodePng(fs.readFileSync(path.join(IMAGES, 'modelforge-logo.png')));
  const bounds = m.findMarkBounds(image, false);
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const pixels = width * height;

  const labels = new Int8Array(pixels);
  const colours = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = ((bounds.minY + y) * image.width + (bounds.minX + x)) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const fit = m.fitInk(r, g, b);
      const colour = fit.colour === m.ORANGE ? 'accent' : 'primary';
      labels[y * width + x] = fit.alpha < 0.5 ? 0 : colour === 'accent' ? 3 : 1;
      colours.push([r, g, b]);
    }
  }

  const assigned = new Int32Array(pixels).fill(-1);
  const faces = [];
  for (let startIndex = 0; startIndex < pixels; startIndex++) {
    if (labels[startIndex] === 0 || assigned[startIndex] >= 0) continue;
    const kind = labels[startIndex];
    const id = faces.length;
    const members = [];
    const stack = [startIndex];
    let topLeft = null;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    assigned[startIndex] = id;

    while (stack.length) {
      const index = stack.pop();
      members.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (!topLeft || y < topLeft.y || (y === topLeft.y && x < topLeft.x)) topLeft = { x, y };
      sumR += colours[index][0];
      sumG += colours[index][1];
      sumB += colours[index][2];
      for (const [dx, dy] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const neighbour = ny * width + nx;
        if (labels[neighbour] !== kind || assigned[neighbour] >= 0) continue;
        assigned[neighbour] = id;
        stack.push(neighbour);
      }
    }

    const mask = new Uint8Array(pixels);
    for (const index of members) mask[index] = 1;
    const outline = trace(mask, width, height, members, topLeft);
    const polygon = straighten(outline);
    if (!polygon) continue;

    const sourceMask = mask;
    const fitted = polygonMask(polygon, width, height);
    let intersection = 0;
    let union = 0;
    for (let i = 0; i < pixels; i++) {
      if (fitted[i] && sourceMask[i]) intersection++;
      if (fitted[i] || sourceMask[i]) union++;
    }
    const iou = intersection / union;
    if (iou < 0.95) throw new Error(`Face fit too loose: IoU ${iou.toFixed(4)}`);

    faces.push({
      role: null,
      colour: {
        r: Math.round(sumR / members.length),
        g: Math.round(sumG / members.length),
        b: Math.round(sumB / members.length),
      },
      iou: Number(iou.toFixed(4)),
      area: members.length,
      centre: {
        x: Math.round((members.reduce((sum, index) => sum + (index % width), 0) / members.length) * 10) / 10,
        y: Math.round((members.reduce((sum, index) => sum + ((index / width) | 0), 0) / members.length) * 10) / 10,
      },
      accent: kind === 3,
      polygon: polygon.map((point) => ({
        x: Number(((point.x * 24) / width).toFixed(3)),
        y: Number(((point.y * 24) / height).toFixed(3)),
      })),
    });
  }

  // Roles come from position, not size: the top face is the widest shape high in
  // the mark, the left face is the leftmost dark shape, the front face is the
  // dark shape below the top one, and the accent is the orange face.
  const dark = faces.filter((face) => !face.accent);
  const top = dark.reduce((best, face) => (face.centre.y < best.centre.y ? face : best));
  top.role = 'primary';
  const rest = dark.filter((face) => face !== top);
  const left = rest.reduce((best, face) => (face.centre.x < best.centre.x ? face : best));
  left.role = 'secondary';
  for (const face of rest) if (face.role !== 'secondary') face.role = 'front';
  for (const face of faces) if (face.accent) face.role = 'accent';

  // Paint order: the top face sits above the left and front faces.
  const order = { primary: 0, front: 1, accent: 2, secondary: 3 };
  faces.sort((a, b) => order[a.role] - order[b.role]);

  const mark = {
    viewBox: 24,
    source: {
      file: 'src/images/modelforge-logo.png',
      bounds,
      width,
      height,
    },
    faces: faces.map((face) => ({
      role: face.role,
      colour: face.colour,
      iou: face.iou,
      polygon: face.polygon,
    })),
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(mark, null, 2) + '\n');

  for (const face of faces) {
    const hex = `#${[face.colour.r, face.colour.g, face.colour.b]
      .map((c) => c.toString(16).padStart(2, '0'))
      .join('')}`;
    console.log(
      `${face.role.padEnd(9)} ${hex}  IoU=${face.iou}  area=${face.area}  vertices=${face.polygon.length}`
    );
  }
  console.log(`\nwrote ${path.relative(path.join(__dirname, '..'), OUTPUT)}`);
}

if (require.main === module) main();

module.exports = { straighten, trace };

#!/usr/bin/env node
/**
 * Regenerates the ModelForge desktop/tray icons from the brand wordmark.
 *
 * Source:  src/images/modelforge-logo.png (wide wordmark on an opaque background)
 * Outputs: icon.png, icon@2x.png, icon-512.png, icon.ico, icon.icns,
 *          icon.svg, iconTemplate*.png
 *
 * The mark is isolated from the wordmark by colour clustering (dark slate glyph +
 * orange tile on a near-white background) and re-centred on a transparent canvas.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const IMAGES_DIR = path.join(__dirname, '..', 'src', 'images');
const SOURCE = path.join(IMAGES_DIR, 'modelforge-logo.png');

const SLATE = { r: 0x33, g: 0x3d, b: 0x4a };
const SLATE_LIGHT = { r: 0x55, g: 0x5d, b: 0x64 };
const ORANGE = { r: 0xe8, g: 0x7a, b: 0x3e };

/**
 * The artwork is flat ink composited over white, so every pixel lies on the line
 * from white to one of the brand colours. Fitting that line yields the coverage
 * (alpha) and identifies the colour, which avoids colour fringing on antialiased
 * edges that naive unpremultiplication would produce.
 */
function fitInk(r, g, b) {
  let best = null;
  for (const colour of [SLATE, SLATE_LIGHT, ORANGE]) {
    const dr = colour.r - 255;
    const dg = colour.g - 255;
    const db = colour.b - 255;
    const t = Math.max(
      0,
      Math.min(1, ((r - 255) * dr + (g - 255) * dg + (b - 255) * db) / (dr * dr + dg * dg + db * db))
    );
    const er = r - (255 + t * dr);
    const eg = g - (255 + t * dg);
    const eb = b - (255 + t * db);
    const error = er * er + eg * eg + eb * eb;
    if (!best || error < best.error) best = { error, alpha: t, colour };
  }
  return best;
}

/** Coverage of a pixel: how far it is from the near-white background, 0..1. */
function inkAlpha(r, g, b) {
  const fit = fitInk(r, g, b);
  if (fit.alpha < 0.04) return 0;
  return fit.alpha;
}

function classify(r, g, b) {
  return fitInk(r, g, b).colour;
}

function decodePng(buffer) {
  let offset = 8;
  const chunks = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette = null;
  let transparency = null;

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('Interlaced PNG is not supported');
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      transparency = Buffer.from(data);
    } else if (type === 'IDAT') {
      chunks.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`Unsupported colour type: ${colorType}`);

  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));

    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      switch (filter) {
        case 0:
          break;
        case 1:
          line[i] = (line[i] + left) & 0xff;
          break;
        case 2:
          line[i] = (line[i] + up) & 0xff;
          break;
        case 3:
          line[i] = (line[i] + ((left + up) >> 1)) & 0xff;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          line[i] = (line[i] + pred) & 0xff;
          break;
        }
        default:
          throw new Error(`Unsupported filter: ${filter}`);
      }
    }

    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      if (colorType === 3) {
        const index = line[x];
        out[dst] = palette[index * 3];
        out[dst + 1] = palette[index * 3 + 1];
        out[dst + 2] = palette[index * 3 + 2];
        out[dst + 3] = transparency && index < transparency.length ? transparency[index] : 255;
      } else if (colorType === 0) {
        out[dst] = out[dst + 1] = out[dst + 2] = line[x];
        out[dst + 3] = 255;
      } else if (colorType === 4) {
        out[dst] = out[dst + 1] = out[dst + 2] = line[x * 2];
        out[dst + 3] = line[x * 2 + 1];
      } else if (colorType === 2) {
        out[dst] = line[x * 3];
        out[dst + 1] = line[x * 3 + 1];
        out[dst + 2] = line[x * 3 + 2];
        out[dst + 3] = 255;
      } else {
        out[dst] = line[x * 4];
        out[dst + 1] = line[x * 4 + 1];
        out[dst + 2] = line[x * 4 + 2];
        out[dst + 3] = line[x * 4 + 3];
      }
    }

    previous = line;
  }

  return { width, height, data: out };
}

function findMarkBounds(image, background) {
  const { width, height, data } = image;
  const columnInk = new Array(width).fill(0);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (inkAlpha(data[i], data[i + 1], data[i + 2]) > 0.12) columnInk[x]++;
    }
  }

  const inked = (x) => x >= 0 && x < width && columnInk[x] >= 4;
  const gapTolerance = Math.round(width * 0.015);

  // Grow the mark's horizontal extent outwards from its densest column, tolerating
  // the internal gaps between the cube's faces but stopping at the empty margin
  // that separates the mark from the wordmark.
  let seed = 0;
  for (let x = 1; x < width; x++) {
    if (columnInk[x] > columnInk[seed]) seed = x;
  }

  let maxX = seed;
  for (let gap = 0, x = seed; x < width; x++) {
    if (inked(x)) {
      maxX = x;
      gap = 0;
    } else if (++gap > gapTolerance) {
      break;
    }
  }

  let minX = seed;
  for (let gap = 0, x = seed; x >= 0; x--) {
    if (inked(x)) {
      minX = x;
      gap = 0;
    } else if (++gap > gapTolerance) {
      break;
    }
  }

  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = minX; x <= maxX; x++) {
      const i = (y * width + x) * 4;
      if (inkAlpha(data[i], data[i + 1], data[i + 2]) <= 0.12) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      break;
    }
  }

  if (maxX < 0 || maxY < 0) throw new Error('Could not locate the brand mark in the source image');

  if (background) {
    // Grow the window a little so the mark's antialiased edge is fully contained.
    const pad = 4;
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(width - 1, maxX + pad);
    maxY = Math.min(height - 1, maxY + pad);
  }

  if (process.env.DEBUG_BRAND_ICONS) {
    console.log(`seed column x=${seed} (ink=${columnInk[seed]}), gapTolerance=${gapTolerance}`);
  }

  return { minX, minY, maxX, maxY };
}

function renderMark(image, bounds, size, { padding = 0.14, monochrome = null } = {}) {
  const markWidth = bounds.maxX - bounds.minX + 1;
  const markHeight = bounds.maxY - bounds.minY + 1;
  const longest = Math.max(markWidth, markHeight);

  const side = size / (1 + padding * 2);
  const scale = side / longest;
  const drawWidth = markWidth * scale;
  const drawHeight = markHeight * scale;
  const offsetX = (size - drawWidth) / 2;
  const offsetY = (size - drawHeight) / 2;

  const out = Buffer.alloc(size * size * 4);
  const samples = Math.max(2, Math.ceil(1 / scale) + 1);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sourceX = (x + 0.5 - offsetX) / scale + bounds.minX;
      const sourceY = (y + 0.5 - offsetY) / scale + bounds.minY;

      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      let hits = 0;

      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const px = Math.floor(sourceX + (sx + 0.5) / samples - 0.5);
          const py = Math.floor(sourceY + (sy + 0.5) / samples - 0.5);
          if (px < bounds.minX || px > bounds.maxX || py < bounds.minY || py > bounds.maxY) continue;

          const i = (py * image.width + px) * 4;
          const r = image.data[i];
          const g = image.data[i + 1];
          const b = image.data[i + 2];
          const alpha = inkAlpha(r, g, b);
          if (alpha <= 0) continue;

          const colour = monochrome || classify(r, g, b);
          alphaSum += alpha;
          redSum += colour.r * alpha;
          greenSum += colour.g * alpha;
          blueSum += colour.b * alpha;
          hits++;
        }
      }

      if (!hits || alphaSum === 0) continue;

      const total = samples * samples;
      const alpha = Math.min(1, alphaSum / total);
      const index = (y * size + x) * 4;
      if (monochrome) {
        out[index] = monochrome.r;
        out[index + 1] = monochrome.g;
        out[index + 2] = monochrome.b;
      } else {
        out[index] = Math.round(redSum / alphaSum);
        out[index + 1] = Math.round(greenSum / alphaSum);
        out[index + 2] = Math.round(blueSum / alphaSum);
      }
      out[index + 3] = Math.round(alpha * 255);
    }
  }

  return out;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Downscales by an integer-free box filter; input must be square RGBA. */
function resize(rgba, from, to) {
  if (from === to) return Buffer.from(rgba);
  const out = Buffer.alloc(to * to * 4);
  const ratio = from / to;

  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      const x0 = Math.floor(x * ratio);
      const x1 = Math.min(from, Math.ceil((x + 1) * ratio));
      const y0 = Math.floor(y * ratio);
      const y1 = Math.min(from, Math.ceil((y + 1) * ratio));

      let alphaSum = 0;
      let redSum = 0;
      let greenSum = 0;
      let blueSum = 0;
      let count = 0;

      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * from + sx) * 4;
          const alpha = rgba[i + 3] / 255;
          alphaSum += alpha;
          redSum += rgba[i] * alpha;
          greenSum += rgba[i + 1] * alpha;
          blueSum += rgba[i + 2] * alpha;
          count++;
        }
      }

      const index = (y * to + x) * 4;
      if (alphaSum > 0) {
        out[index] = Math.round(redSum / alphaSum);
        out[index + 1] = Math.round(greenSum / alphaSum);
        out[index + 2] = Math.round(blueSum / alphaSum);
      }
      out[index + 3] = Math.round((alphaSum / count) * 255);
    }
  }

  return out;
}

function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;

  entries.forEach((entry, index) => {
    const base = index * 16;
    directory[base] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[base + 2] = 0;
    directory[base + 3] = 0;
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(32, base + 6);
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

function encodeIcns(entries) {
  const chunks = entries.map(({ type, png }) => {
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

function markPath(size, bounds, image, padding) {
  const markWidth = bounds.maxX - bounds.minX + 1;
  const markHeight = bounds.maxY - bounds.minY + 1;
  const side = size / (1 + padding * 2);
  const scale = side / Math.max(markWidth, markHeight);
  const drawWidth = markWidth * scale;
  const drawHeight = markHeight * scale;
  return {
    width: drawWidth,
    height: drawHeight,
    scale,
    x: (size - drawWidth) / 2,
    y: (size - drawHeight) / 2,
  };
}

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

/** Ordered boundary of a simple 8-connected region, traced from its top-left pixel. */
function traceRegion(mask, width, height, members, start) {
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

function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / length;
}

function reduceOutline(points, epsilon) {
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
    ...reduceOutline(points.slice(0, index + 1), epsilon).slice(0, -1),
    ...reduceOutline(points.slice(index), epsilon),
  ];
}

/**
 * Splits the mark into its four faces (connected components of same-coloured ink)
 * and returns them as polygons in source-image pixel space.
 */
function extractFaces(image, bounds) {
  const width = bounds.maxX - bounds.minX + 1;
  const height = bounds.maxY - bounds.minY + 1;
  const pixels = width * height;
  const labels = new Int8Array(pixels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = bounds.minX + x;
      const sy = bounds.minY + y;
      const i = (sy * image.width + sx) * 4;
      const r = image.data[i];
      const g = image.data[i + 1];
      const b = image.data[i + 2];
      const fit = fitInk(r, g, b);
      if (fit.alpha < 0.5) continue;
      // Split faces on hue alone; per-face shading is sampled afterwards. Using
      // the tint in the split would fragment a shaded face into slivers.
      labels[y * width + x] = fit.colour.r > fit.colour.b ? 3 : 1;
    }
  }

  const assigned = new Int32Array(pixels).fill(-1);
  const faces = [];
  const stack = [];

  for (let startIndex = 0; startIndex < pixels; startIndex++) {
    if (labels[startIndex] === 0 || assigned[startIndex] >= 0) continue;
    const kind = labels[startIndex];
    const id = faces.length;
    const members = [];
    let topLeft = null;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    assigned[startIndex] = id;
    stack.push(startIndex);

    while (stack.length) {
      const index = stack.pop();
      members.push(index);
      const x = index % width;
      const y = (index / width) | 0;
      if (!topLeft || y < topLeft.y || (y === topLeft.y && x < topLeft.x)) topLeft = { x, y };
      const sample = ((bounds.minY + y) * image.width + (bounds.minX + x)) * 4;
      sumR += image.data[sample];
      sumG += image.data[sample + 1];
      sumB += image.data[sample + 2];
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
    const outline = traceRegion(mask, width, height, members, topLeft);
    const closed = [...outline, outline[0]];
    const polygon = reduceOutline(closed, 2.0);
    polygon.pop();
    if (polygon.length < 3) continue;
    faces.push({
      colour: {
        r: Math.round(sumR / members.length),
        g: Math.round(sumG / members.length),
        b: Math.round(sumB / members.length),
      },
      orange: kind === 3,
      polygon,
    });
  }

  // Draw the darker faces first so the mark reads the same as the artwork.
  faces.sort((a, b) => Number(a.orange) - Number(b.orange));
  return faces;
}

/**
 * Emits the mark as filled polygons. A row-by-row trace would be faithful but
 * shows banding when scaled up, so the faces are traced as connected regions and
 * simplified into polygons instead.
 */
function buildSvg(image, bounds, size, padding) {
  const box = markPath(size, bounds, image, padding);
  const faces = extractFaces(image, bounds);
  if (!faces.length) throw new Error('No mark faces found for the SVG output');

  const paths = faces.map(({ colour, polygon }) => {
    const points = polygon
      .map((point) => {
        const x = box.x + point.x * box.scale;
        const y = box.y + point.y * box.scale;
        return `${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' L');
    const hex = `#${[colour.r, colour.g, colour.b]
      .map((channel) => channel.toString(16).padStart(2, '0'))
      .join('')}`;
    return `  <path fill="${hex}" d="M${points} Z"/>`;
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    ...paths,
    '</svg>',
    '',
  ].join('\n');
}

function main() {
  const source = decodePng(fs.readFileSync(SOURCE));
  const bounds = findMarkBounds(source, false);
  console.log(
    `mark bounds: x=${bounds.minX}..${bounds.maxX} y=${bounds.minY}..${bounds.maxY} ` +
      `(${bounds.maxX - bounds.minX + 1}x${bounds.maxY - bounds.minY + 1})`
  );

  const master = renderMark(source, bounds, 1024);
  const write = (name, size) => {
    const rgba = size === 1024 ? master : resize(master, 1024, size);
    const png = encodePng(size, size, rgba);
    fs.writeFileSync(path.join(IMAGES_DIR, name), png);
    console.log(`wrote ${name} (${size}x${size}, ${png.length} bytes)`);
    return png;
  };

  const icon1024 = write('icon.png', 1024);
  const icon512 = write('icon-512.png', 512);

  const icon2048 = encodePng(2048, 2048, renderMark(source, bounds, 2048));
  fs.writeFileSync(path.join(IMAGES_DIR, 'icon@2x.png'), icon2048);
  console.log(`wrote icon@2x.png (2048x2048, ${icon2048.length} bytes)`);

  const ico = encodeIco([
    { size: 16, png: encodePng(16, 16, resize(master, 1024, 16)) },
    { size: 32, png: encodePng(32, 32, resize(master, 1024, 32)) },
    { size: 48, png: encodePng(48, 48, resize(master, 1024, 48)) },
    { size: 64, png: encodePng(64, 64, resize(master, 1024, 64)) },
    { size: 128, png: encodePng(128, 128, resize(master, 1024, 128)) },
    { size: 256, png: encodePng(256, 256, resize(master, 1024, 256)) },
  ]);
  fs.writeFileSync(path.join(IMAGES_DIR, 'icon.ico'), ico);
  console.log(`wrote icon.ico (6 sizes, ${ico.length} bytes)`);

  const icns = encodeIcns([
    { type: 'icp4', png: encodePng(16, 16, resize(master, 1024, 16)) },
    { type: 'icp5', png: encodePng(32, 32, resize(master, 1024, 32)) },
    { type: 'icp6', png: encodePng(64, 64, resize(master, 1024, 64)) },
    { type: 'ic07', png: encodePng(128, 128, resize(master, 1024, 128)) },
    { type: 'ic08', png: encodePng(256, 256, resize(master, 1024, 256)) },
    { type: 'ic09', png: icon512 },
    { type: 'ic10', png: icon1024 },
    { type: 'ic11', png: encodePng(32, 32, resize(master, 1024, 32)) },
    { type: 'ic12', png: encodePng(64, 64, resize(master, 1024, 64)) },
    { type: 'ic13', png: encodePng(256, 256, resize(master, 1024, 256)) },
    { type: 'ic14', png: icon512 },
  ]);
  fs.writeFileSync(path.join(IMAGES_DIR, 'icon.icns'), icns);
  console.log(`wrote icon.icns (11 entries, ${icns.length} bytes)`);

  fs.writeFileSync(path.join(IMAGES_DIR, 'icon.svg'), buildSvg(source, bounds, 512, 0.14));
  console.log('wrote icon.svg');

  // macOS tray icons are template images: black with an alpha channel, so the
  // system can invert them for light and dark menu bars.
  const trayMark = renderMark(source, bounds, 44, { padding: 0.06, monochrome: { r: 0, g: 0, b: 0 } });
  const traySmall = resize(trayMark, 44, 22);
  fs.writeFileSync(path.join(IMAGES_DIR, 'iconTemplate.png'), encodePng(22, 22, traySmall));
  fs.writeFileSync(path.join(IMAGES_DIR, 'iconTemplate@2x.png'), encodePng(44, 44, trayMark));
  fs.writeFileSync(path.join(IMAGES_DIR, 'iconTemplateUpdate.png'), encodePng(22, 22, traySmall));
  fs.writeFileSync(
    path.join(IMAGES_DIR, 'iconTemplateUpdate@2x.png'),
    encodePng(44, 44, trayMark)
  );
  console.log('wrote iconTemplate*.png');
}

if (require.main === module) {
  main();
}

module.exports = {
  decodePng,
  encodePng,
  findMarkBounds,
  renderMark,
  resize,
  encodeIco,
  encodeIcns,
  extractFaces,
  markPath,
  fitInk,
  inkAlpha,
  SLATE,
  SLATE_LIGHT,
  ORANGE,
};

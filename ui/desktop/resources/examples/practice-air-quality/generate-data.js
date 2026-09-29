#!/usr/bin/env node
/**
 * 生成城市空气质量预测示例题的合成数据（固定随机种子，结果可复现）。
 * 运行：node generate-data.js
 */
const fs = require('fs');
const path = require('path');

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAYS = 200;
const rand = mulberry32(20230515);

const lines = ['date,temperature,humidity,wind_speed,traffic_index,pm2_5'];
for (let i = 0; i < DAYS; i += 1) {
  const date = new Date(Date.UTC(2023, 0, 1 + i)).toISOString().slice(0, 10);
  const temperature = (15 + Math.sin(i / 30) * 12 + rand() * 8 - 4).toFixed(1);
  const humidity = Math.min(95, Math.max(20, Math.round(60 + Math.cos(i / 20) * 20 + rand() * 16 - 8)));
  const wind = (2 + rand() * 4).toFixed(1);
  const traffic = Math.min(100, Math.max(10, Math.round(55 + Math.sin(i / 7) * 15 + rand() * 30 - 15)));
  const pm = Math.round(
    Math.max(10, 40 + traffic * 0.5 + humidity * 0.3 - wind * 4 + rand() * 25 - 12)
  );
  lines.push(`${date},${temperature},${humidity},${wind},${traffic},${pm}`);
}

const outDir = path.join(__dirname, 'attachments');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'air_quality.csv'), lines.join('\n') + '\n', 'utf8');
console.log('生成完成：attachments/air_quality.csv');

#!/usr/bin/env node
/**
 * 生成共享单车调度优化示例题的合成数据（固定随机种子，结果可复现）。
 * 运行：node generate-data.js
 */
const fs = require('fs');
const path = require('path');

// mulberry32 伪随机数生成器（固定种子，保证跨平台一致）
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

const STATIONS = 12;
const rand = mulberry32(20230901);

const stationLines = ['station_id,x,y,capacity,initial_bikes'];
for (let i = 0; i < STATIONS; i += 1) {
  const x = (rand() * 10).toFixed(3);
  const y = (rand() * 10).toFixed(3);
  const capacity = 30 + Math.floor(rand() * 30); // 30..59
  const initial = Math.floor(rand() * (capacity + 1));
  stationLines.push(`S${String(i + 1).padStart(2, '0')},${x},${y},${capacity},${initial}`);
}

const demandLines = ['station_id,hour,net_demand'];
for (let i = 0; i < STATIONS; i += 1) {
  for (let hour = 0; hour < 24; hour += 1) {
    const rush = hour >= 7 && hour <= 9 ? 1.6 : hour >= 17 && hour <= 19 ? 1.4 : 1.0;
    const net = Math.round((rand() * 10 - 5) * rush);
    demandLines.push(`S${String(i + 1).padStart(2, '0')},${hour},${net}`);
  }
}

const outDir = path.join(__dirname, 'attachments');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'stations.csv'), stationLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(outDir, 'demand.csv'), demandLines.join('\n') + '\n', 'utf8');
console.log('生成完成：attachments/stations.csv, attachments/demand.csv');

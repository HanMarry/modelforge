#!/usr/bin/env node
/**
 * 生成高校科研实力综合评价示例题的合成数据（固定随机种子，结果可复现）。
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

const N = 20;
const rand = mulberry32(20240101);

const lines = ['university,papers,citations,h_index,research_funding,awards'];
for (let i = 0; i < N; i += 1) {
  const papers = Math.round(200 + rand() * 2800); // 200..3000
  const citations = Math.round(papers * (5 + rand() * 25)); // 引用与论文正相关
  const hIndex = Math.round(10 + rand() * 60); // 10..70
  const funding = Math.round(500 + rand() * 9500); // 万元
  const awards = Math.round(rand() * 40); // 0..40
  lines.push(`U${String(i + 1).padStart(2, '0')},${papers},${citations},${hIndex},${funding},${awards}`);
}

const outDir = path.join(__dirname, 'attachments');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'universities.csv'), lines.join('\n') + '\n', 'utf8');
console.log('生成完成：attachments/universities.csv');

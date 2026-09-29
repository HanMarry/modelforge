#!/usr/bin/env node
/**
 * Generates fixtures/run-record-vectors.json, the cross-language Run_Record vectors
 * (spec mathmodel-parity-and-beyond, Property 36 and 38).
 *
 * - `records`: 100 valid records. Rust (crates/goose-run-record/src/run_record.rs) and the
 *   desktop (ui/desktop/src/utils/runRecord.test.ts) both parse each one and must re-serialize
 *   it to the same JSON value, so a record written by either side reads back unchanged on the
 *   other.
 * - `invalid`: records both sides must reject, with the fields the desktop reports.
 *
 * Deterministic: a fixed seed, no dependencies. Regenerate with
 *   node fixtures/gen-run-record-vectors.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED = 20260929;
const RECORD_COUNT = 100;
const MAX_FILES = 1000;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);
const int = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (items) => items[int(0, items.length - 1)];
const pad = (value, width) => String(value).padStart(width, '0');

const NAME_CHARS = Array.from(
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' +
    '数据模型结果图表问题一二三赛题附件é' +
    ' _-.()[]{}\'"\\$%&+=,;!@#~'
).concat(['📊', '🔑', '🚀', '😀']);
const TEXT_CHARS = NAME_CHARS.concat(['/', '\n', '\t', '\u0001', '\u001f', '\u007f', '\u2028']);
const HEX = '0123456789abcdef';
const RUN_ID_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const OFFSETS = ['+08:00', '+00:00', 'Z', '-05:00', '+05:45', '-09:30'];

function text(chars, min, max) {
  let out = '';
  const length = int(min, max);
  for (let i = 0; i < length; i += 1) {
    out += pick(chars);
  }
  return out;
}

function isProjectRelativePath(value) {
  if (value.length === 0 || value.includes('\0')) return false;
  if (value.startsWith('/') || value.startsWith('\\') || /^[A-Za-z]:/.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}

function projectPath() {
  for (;;) {
    const segments = Array.from({ length: int(1, 4) }, () => text(NAME_CHARS, 1, 12));
    const candidate = segments.join('/');
    if (isProjectRelativePath(candidate)) return candidate;
  }
}

function sha256() {
  let out = '';
  for (let i = 0; i < 64; i += 1) out += pick(Array.from(HEX));
  return out;
}

function fileHash() {
  return { path: projectPath(), sha256: sha256() };
}

function daysInMonth(year, month) {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function instant() {
  const year = int(2020, 2030);
  const month = int(1, 12);
  // Every tenth record lands on the last day of the month, including 29 February.
  const day = random() < 0.1 ? daysInMonth(year, month) : int(1, daysInMonth(year, month));
  return {
    date: `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`,
    compactDate: `${pad(year, 4)}${pad(month, 2)}${pad(day, 2)}`,
    time: `${pad(int(0, 23), 2)}:${pad(int(0, 59), 2)}:${pad(int(0, 59), 2)}`,
    millis: pad(int(0, 999), 3),
  };
}

function timestamp(at) {
  return `${at.date}T${at.time}.${at.millis}${pick(OFFSETS)}`;
}

function runId(at) {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) suffix += pick(Array.from(RUN_ID_CHARS));
  return `${at.compactDate}T${at.time.replaceAll(':', '')}${at.millis}-${suffix}`;
}

function fileList(length) {
  return Array.from({ length }, fileHash);
}

/** A full list at the cap, with short names so the fixture stays small. */
function fullFileList() {
  return Array.from({ length: MAX_FILES }, (_, i) => ({
    path: `data/附件${pad(i, 4)}.csv`,
    sha256: sha256(),
  }));
}

function outcome() {
  const roll = random();
  if (roll < 0.6) return { exitCode: 0, failure: null };
  if (roll < 0.8) {
    const exitCode = pick([1, 2, 127, 137, 255, -1, -1073741819, 2147483647, -2147483648]);
    return { exitCode, failure: '非零退出码' };
  }
  return { exitCode: null, failure: roll < 0.9 ? '超时' : '用户取消' };
}

function record(index) {
  const started = instant();
  const { exitCode, failure } = outcome();
  // Only record 0 sits at the cap. The output list cap is covered by the unit tests on each side.
  const inputsTruncated = index === 0;
  const outputsTruncated = false;
  return {
    schemaVersion: 1,
    runId: runId(started),
    inputs: inputsTruncated ? fullFileList() : fileList(pick([0, 1, 2, 3, 5, 8])),
    inputsTruncated,
    code: fileHash(),
    config: {
      provider: pick(['openai', 'anthropic', 'custom_deepseek', '', text(TEXT_CHARS, 1, 12)]),
      model: pick(['gpt-4o', 'claude-sonnet-4', 'deepseek-chat', text(TEXT_CHARS, 1, 16)]),
      runtime: pick(['python 3.12.4', 'Rscript 4.4.1', 'MATLAB R2024b', text(TEXT_CHARS, 1, 16)]),
    },
    command: index === 2 ? '' : text(TEXT_CHARS, 1, 80),
    dependencies: Array.from({ length: pick([0, 1, 3, 8]) }, () => ({
      name: pick(['numpy', 'pandas', 'scipy', text(NAME_CHARS, 1, 12)]),
      version: pick(['1.26.4', '2.2.2', '', text(TEXT_CHARS, 1, 10)]),
    })),
    seed: pick(['未设置', '42', '20260929', text(TEXT_CHARS, 1, 12)]),
    exitCode,
    failure,
    startedAt: timestamp(started),
    endedAt: timestamp(instant()),
    outputs: fileList(pick([0, 1, 2, 4, 6])),
    outputsTruncated,
  };
}

const records = Array.from({ length: RECORD_COUNT }, (_, index) => record(index));

/** A small valid record that the invalid vectors mutate. */
function base() {
  return {
    schemaVersion: 1,
    runId: '20260920T101530123-a1b2c3',
    inputs: [{ path: 'data/附件1.xlsx', sha256: 'a'.repeat(64) }],
    inputsTruncated: false,
    code: { path: 'code/问题一.py', sha256: 'b'.repeat(64) },
    config: { provider: 'openai', model: 'gpt-4o', runtime: 'python 3.12.4' },
    command: 'python "code/问题一.py"',
    dependencies: [{ name: 'numpy', version: '1.26.4' }],
    seed: '未设置',
    exitCode: 0,
    failure: null,
    startedAt: '2026-09-20T10:15:30.123+08:00',
    endedAt: '2026-09-20T10:15:31.456+08:00',
    outputs: [{ path: 'results/q1.csv', sha256: 'c'.repeat(64) }],
    outputsTruncated: false,
  };
}

function mutated(name, mutate, expected) {
  const value = base();
  mutate(value);
  return { name, record: value, missing: expected.missing ?? [], invalid: expected.invalid ?? [] };
}

const invalid = [
  mutated('missing top-level fields', (r) => {
    delete r.runId;
    delete r.exitCode;
    delete r.outputs;
  }, { missing: ['runId', 'exitCode', 'outputs'] }),
  mutated('missing nested fields', (r) => {
    delete r.code.sha256;
    delete r.config.model;
    delete r.inputs[0].path;
  }, { missing: ['inputs[0].path', 'code.sha256', 'config.model'] }),
  mutated('schema version 2', (r) => {
    r.schemaVersion = 2;
  }, { invalid: ['schemaVersion'] }),
  mutated('run id without random suffix', (r) => {
    r.runId = '20260920T101530123';
  }, { invalid: ['runId'] }),
  mutated('uppercase sha256', (r) => {
    r.outputs[0].sha256 = 'C'.repeat(64);
  }, { invalid: ['outputs[0].sha256'] }),
  mutated('absolute and escaping paths', (r) => {
    r.inputs = [
      { path: '/etc/passwd', sha256: 'a'.repeat(64) },
      { path: 'C:\\Users\\x.csv', sha256: 'a'.repeat(64) },
      { path: 'data/../../x.csv', sha256: 'a'.repeat(64) },
      { path: 'data\\..\\x.csv', sha256: 'a'.repeat(64) },
    ];
  }, { invalid: ['inputs[0].path', 'inputs[1].path', 'inputs[2].path', 'inputs[3].path'] }),
  mutated('30 February', (r) => {
    r.startedAt = '2026-02-30T10:15:30.123+08:00';
  }, { invalid: ['startedAt'] }),
  mutated('timestamp without milliseconds', (r) => {
    r.endedAt = '2026-09-20T10:15:31+08:00';
  }, { invalid: ['endedAt'] }),
  mutated('exit code out of range', (r) => {
    r.exitCode = 2147483648;
    r.failure = '非零退出码';
  }, { invalid: ['exitCode'] }),
  mutated('non-zero exit without failure', (r) => {
    r.exitCode = 1;
  }, { invalid: ['failure'] }),
  mutated('timeout with exit code', (r) => {
    r.exitCode = 0;
    r.failure = '超时';
  }, { invalid: ['exitCode'] }),
  mutated('unknown failure kind', (r) => {
    r.exitCode = 1;
    r.failure = '崩溃';
  }, { invalid: ['failure'] }),
  mutated('truncated list below the cap', (r) => {
    r.inputsTruncated = true;
  }, { invalid: ['inputsTruncated'] }),
  // A list above the cap is left to the unit tests on each side: 1001 entries would double the file.
  mutated('wrong types', (r) => {
    r.command = ['python'];
    r.seed = 42;
    r.inputsTruncated = 'no';
  }, { invalid: ['inputsTruncated', 'command', 'seed'] }),
];

const vectors = {
  description:
    'Generated by fixtures/gen-run-record-vectors.mjs (seed ' +
    SEED +
    '). Shared by the Rust and desktop Run_Record tests; do not edit by hand.',
  records,
  invalid,
};

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-record-vectors.json');
fs.writeFileSync(target, `${JSON.stringify(vectors, null, 2)}\n`, 'utf8');
console.log(`wrote ${records.length} records and ${invalid.length} invalid vectors to ${target}`);

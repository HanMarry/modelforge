/**
 * Disabling a skill moves its folder out of the roots the agent scans, so these tests
 * work on a real temporary directory: the behaviour under test *is* the filesystem move,
 * and a mocked fs would not catch a wrong destination or a lost index entry.
 *
 * The default jsdom environment is kept (the shared setup file defines `window.electron`);
 * `node:fs` is available either way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  disabledSkillsRoot,
  isSkillDirectory,
  readDisabledIndex,
  setSkillEnabled,
} from './skillEnablement';

let appDataDir: string;
let skillsRoot: string;
let skillDir: string;

function writeSkill(dir: string, name = 'demo'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: demo skill\n---\n\n# Demo\n`,
    'utf8'
  );
}

beforeEach(() => {
  appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelforge-skills-'));
  skillsRoot = path.join(appDataDir, 'agents', 'skills');
  skillDir = path.join(skillsRoot, 'demo');
  writeSkill(skillDir);
});

afterEach(() => {
  fs.rmSync(appDataDir, { recursive: true, force: true });
});

describe('skill enablement', () => {
  it('recognises a skill directory by its SKILL.md', () => {
    expect(isSkillDirectory(skillDir)).toBe(true);
    expect(isSkillDirectory(skillsRoot)).toBe(false);
  });

  it('moves the folder out of the scanned root and records where it came from', () => {
    const result = setSkillEnabled(appDataDir, {
      name: 'demo',
      path: skillDir,
      enabled: false,
    });

    expect(fs.existsSync(skillDir)).toBe(false);
    expect(fs.existsSync(path.join(disabledSkillsRoot(appDataDir), 'demo', 'SKILL.md'))).toBe(true);

    const [record] = result.records;
    expect(record).toMatchObject({ name: 'demo', originalPath: skillDir });
    expect(record.disabledAt).not.toBe('');
    expect(readDisabledIndex(appDataDir)).toEqual(result.records);
  });

  it('restores the folder to its original path when re-enabled', () => {
    setSkillEnabled(appDataDir, { name: 'demo', path: skillDir, enabled: false });
    const result = setSkillEnabled(appDataDir, { name: 'demo', path: skillDir, enabled: true });

    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(result.location).toBe(skillDir);
    expect(result.records).toEqual([]);
    expect(fs.existsSync(path.join(disabledSkillsRoot(appDataDir), 'demo'))).toBe(false);
  });

  it('keeps a stable name when the folder has to be renamed to avoid a clash', () => {
    writeSkill(path.join(skillsRoot, 'other', 'demo'));

    const first = setSkillEnabled(appDataDir, { name: 'demo', path: skillDir, enabled: false });
    const second = setSkillEnabled(appDataDir, {
      name: 'demo',
      path: path.join(skillsRoot, 'other', 'demo'),
      enabled: false,
    });

    expect(first.records.map((r) => r.name)).toEqual(['demo']);
    expect(second.records.map((r) => r.name).sort()).toEqual(['demo', 'demo-2']);

    // Both are restorable, each to its own original path.
    setSkillEnabled(appDataDir, { name: 'demo', path: '', enabled: true });
    setSkillEnabled(appDataDir, { name: 'demo-2', path: '', enabled: true });
    expect(fs.existsSync(path.join(skillDir, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillsRoot, 'other', 'demo', 'SKILL.md'))).toBe(true);
  });

  it('refuses to disable a built-in skill, which has no folder', () => {
    expect(() =>
      setSkillEnabled(appDataDir, {
        name: 'math-paper',
        path: 'builtin://skills/math-paper',
        enabled: false,
      })
    ).toThrow(/内置技能/);
  });

  it('refuses to enable a skill that is not in the index instead of guessing', () => {
    expect(() => setSkillEnabled(appDataDir, { name: 'ghost', path: '', enabled: true })).toThrow(
      /停用记录/
    );
  });

  it('does not overwrite a folder that reappeared at the original path', () => {
    setSkillEnabled(appDataDir, { name: 'demo', path: skillDir, enabled: false });
    writeSkill(skillDir, 'replacement');

    expect(() =>
      setSkillEnabled(appDataDir, { name: 'demo', path: skillDir, enabled: true })
    ).toThrow(/已被占用/);
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toContain('name: replacement');
  });

  it('treats an unreadable index as empty rather than inventing entries', () => {
    fs.mkdirSync(disabledSkillsRoot(appDataDir), { recursive: true });
    fs.writeFileSync(path.join(disabledSkillsRoot(appDataDir), 'index.json'), 'not json', 'utf8');
    expect(readDisabledIndex(appDataDir)).toEqual([]);
  });
});

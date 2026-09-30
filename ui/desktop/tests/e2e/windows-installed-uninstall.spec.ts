/**
 * Uninstall smoke test (spec mathmodel-parity-and-beyond, task 13.6; requirement 7.10): the
 * uninstaller removes the program files, shortcuts and the "Apps & features" entry, asks
 * whether to keep configuration, sessions and Project data, and does what the user chose.
 *
 * Runs last: it uninstalls the app three times and reinstalls it in between.
 *
 *   1. silent (`/S`, as used by upgrades and scripts): no question, data kept
 *   2. interactive, answering "是" (keep) through UI Automation: data kept
 *   3. interactive, answering "否" (remove): desktop and kernel data removed, Projects kept
 *
 * The dialogs are driven by scripts/Uninstall-ModelForge.ps1 (UI Automation by control id, so
 * the installer language does not matter). When UI Automation cannot reach them, the script
 * exits with code 3 and the test reports the prompt as unverified instead of passing.
 */
import { expect, test, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  annotate,
  appPaths,
  ensureProject,
  hashTree,
  runHelper,
  smokeConfig,
  type SmokeConfig,
} from './windows-smoke/harness';

const cfg = smokeConfig();

interface UninstallResult {
  ok: boolean;
  mode: 'Silent' | 'Keep' | 'Remove';
  uiaAvailable: boolean;
  promptSeen: boolean;
  promptText: string;
  answered: string;
  dialogs: string[];
  clicks: string[];
  screenshots: string[];
  installDirExists: boolean;
  exePresent: boolean;
  remainingFiles: string[];
  uninstallEntryPresent: boolean;
  startMenuShortcut: string;
  startMenuShortcutPresent: boolean;
  desktopShortcut: string;
  desktopShortcutPresent: boolean;
  error: string | null;
}

interface InstallResult {
  ok: boolean;
  startMenuShortcutPresent: boolean;
  desktopShortcutPresent: boolean;
  uninstallEntryPresent: boolean;
  displayName: string;
  publisher: string;
}

/** UI Automation could not reach the uninstaller's dialogs (see the script). */
const EXIT_UIA_UNAVAILABLE = 3;

test.describe('installed ModelForge: uninstall options (7.10)', () => {
  test.skip(cfg === null, 'MODELFORGE_INSTALL_DIR is not set; run by modelforge-windows-smoke.yml');
  test.skip(cfg !== null && !cfg.installer, 'MODELFORGE_INSTALLER is not set');

  test('silent uninstall removes the program and keeps the user data', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const projectDir = ensureProject(c, testInfo);
    ensureInstalled(c, testInfo);
    const before = dataSnapshot(c, projectDir);

    const run = await uninstall(c, testInfo, 'Silent');
    expect(run.exitCode, run.output.slice(-4_000)).toBe(0);
    expectProgramRemoved(run.result);
    expect(run.result?.promptSeen, 'a silent uninstall asks nothing').toBe(false);

    const after = dataSnapshot(c, projectDir);
    expect(after.userDataPresent, 'desktop data kept').toBe(true);
    expect(changed(before.userData, after.userData), 'desktop data unchanged').toEqual([]);
    expect(changed(before.kernel, after.kernel), 'kernel configuration and sessions unchanged').toEqual([]);
    expect(changed(before.project, after.project), 'Project unchanged').toEqual([]);
  });

  test('interactive uninstall asks; answering "keep" leaves the data in place', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const projectDir = ensureProject(c, testInfo);
    ensureInstalled(c, testInfo);
    const before = dataSnapshot(c, projectDir);

    const run = await uninstall(c, testInfo, 'Keep');
    skipIfUiaUnavailable(run.exitCode, testInfo);
    expect(run.exitCode, run.output.slice(-4_000)).toBe(0);
    expectPrompt(run.result, 'yes');
    expectProgramRemoved(run.result);

    const after = dataSnapshot(c, projectDir);
    expect(after.userDataPresent, 'desktop data kept').toBe(true);
    expect(changed(before.userData, after.userData), 'desktop data unchanged').toEqual([]);
    expect(changed(before.kernel, after.kernel), 'kernel configuration and sessions unchanged').toEqual([]);
    expect(changed(before.project, after.project), 'Project unchanged').toEqual([]);
  });

  test('interactive uninstall asks; answering "remove" deletes configuration and sessions but not Projects', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const paths = appPaths(c);
    const projectDir = ensureProject(c, testInfo);
    ensureInstalled(c, testInfo);
    const before = dataSnapshot(c, projectDir);
    expect(fs.existsSync(paths.sessionsDb), 'there are sessions to remove').toBe(true);

    const run = await uninstall(c, testInfo, 'Remove');
    skipIfUiaUnavailable(run.exitCode, testInfo);
    expect(run.exitCode, run.output.slice(-4_000)).toBe(0);
    expectPrompt(run.result, 'no');
    expectProgramRemoved(run.result);

    expect(fs.existsSync(paths.userData), `desktop data ${paths.userData} removed`).toBe(false);
    expect(fs.existsSync(paths.updaterCache), `updater cache ${paths.updaterCache} removed`).toBe(false);
    // Requirement 7.10 covers the configuration and sessions the kernel keeps. On Windows goose
    // keeps them under %APPDATA%\Block\goose; build/installer.nsh removes ~/.config/goose and
    // ~/.local/share/goose, which goose only uses on Linux.
    const kernelLeft = [paths.gooseConfigFile, paths.sessionsDb].filter((file) => fs.existsSync(file));
    if (kernelLeft.length > 0) {
      annotate(testInfo, 'product-defect', `"remove" left the kernel's configuration and sessions: ${kernelLeft.join(', ')}`);
    }
    expect.soft(kernelLeft, 'kernel configuration and sessions removed').toEqual([]);

    const after = dataSnapshot(c, projectDir);
    expect(changed(before.project, after.project), 'the Project folder is never removed').toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------

function ensureInstalled(c: SmokeConfig, testInfo: TestInfo): void {
  if (fs.existsSync(c.exe)) {
    return;
  }
  const install = runHelper<InstallResult>(
    c,
    'Install-ModelForge.ps1',
    { Installer: c.installer, InstallDir: c.installDir },
    20 * 60_000
  );
  annotate(testInfo, 'reinstall', JSON.stringify(install.result ?? { output: install.output.slice(-2_000) }));
  expect(install.exitCode, `reinstall failed:\n${install.output.slice(-4_000)}`).toBe(0);
  expect(install.result?.uninstallEntryPresent, '"Apps & features" entry after installing').toBe(true);
  expect(install.result?.startMenuShortcutPresent, 'Start menu shortcut after installing').toBe(true);
  expect(install.result?.desktopShortcutPresent, 'desktop shortcut after installing').toBe(true);
}

async function uninstall(c: SmokeConfig, testInfo: TestInfo, mode: UninstallResult['mode']) {
  const run = runHelper<UninstallResult>(
    c,
    'Uninstall-ModelForge.ps1',
    { Mode: mode, EvidenceDir: path.join(c.evidenceDir, `uninstall-${mode.toLowerCase()}`) },
    10 * 60_000
  );
  annotate(testInfo, `uninstall-${mode.toLowerCase()}`, JSON.stringify(run.result ?? { output: run.output.slice(-2_000) }));
  for (const shot of run.result?.screenshots ?? []) {
    if (fs.existsSync(shot)) {
      await testInfo.attach(path.basename(shot), { path: shot, contentType: 'image/png' });
    }
  }
  return run;
}

function skipIfUiaUnavailable(exitCode: number | null, testInfo: TestInfo): void {
  if (exitCode === EXIT_UIA_UNAVAILABLE) {
    annotate(
      testInfo,
      'unverified',
      'UI Automation could not reach the uninstaller dialogs; the keep/remove prompt is not verified on this runner'
    );
  }
  expect(exitCode, 'UI Automation reached the uninstaller dialogs').not.toBe(EXIT_UIA_UNAVAILABLE);
}

function expectPrompt(result: UninstallResult | null, answer: 'yes' | 'no'): void {
  expect(result?.promptSeen, 'the uninstaller asked whether to keep the data').toBe(true);
  expect(result?.promptText ?? '', 'the question is the one from build/installer.nsh').toContain('是否保留');
  expect(result?.promptText ?? '', 'the question says Projects are never deleted').toContain('项目文件夹');
  expect(result?.answered).toBe(answer);
}

function expectProgramRemoved(result: UninstallResult | null): void {
  expect(result, 'uninstall result').toBeTruthy();
  expect(result?.exePresent, 'ModelForge.exe removed').toBe(false);
  expect(result?.remainingFiles ?? [], 'program files left in the install directory').toEqual([]);
  expect(result?.uninstallEntryPresent, '"Apps & features" entry removed').toBe(false);
  expect(result?.startMenuShortcutPresent, `Start menu shortcut ${result?.startMenuShortcut} removed`).toBe(false);
  expect(result?.desktopShortcutPresent, `desktop shortcut ${result?.desktopShortcut} removed`).toBe(false);
}

interface DataSnapshot {
  userDataPresent: boolean;
  userData: Record<string, string>;
  kernel: Record<string, string>;
  project: Record<string, string>;
}

function dataSnapshot(c: SmokeConfig, projectDir: string): DataSnapshot {
  const paths = appPaths(c);
  return {
    userDataPresent: fs.existsSync(paths.userData),
    userData: hashTree(paths.userData),
    kernel: hashTree(paths.gooseRoot),
    project: hashTree(projectDir),
  };
}

function changed(before: Record<string, string>, after: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [file, hash] of Object.entries(before)) {
    if (!(file in after)) out.push(`removed ${file}`);
    else if (after[file] !== hash) out.push(`changed ${file}`);
  }
  for (const file of Object.keys(after)) {
    if (!(file in before)) out.push(`added ${file}`);
  }
  return out;
}

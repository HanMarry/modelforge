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
 * The data are the four folders customUnInstall in build/installer.nsh removes on "remove":
 * %APPDATA%\ModelForge, %LOCALAPPDATA%\modelforge-updater, %APPDATA%\Block\goose and
 * %LOCALAPPDATA%\Block\goose. "keep" and a silent uninstall must leave all four untouched,
 * "remove" must delete all four, and the Project folder always stays. The updater cache and the
 * kernel cache only appear after an update download or certain extensions, so before each run
 * every folder gets a marker file (created with the folder when missing, reported as `setup`).
 *
 * The uninstaller reads APPDATA / LOCALAPPDATA from its environment, so it has to run with the
 * profile of the user under test: the runner account (primary), the new local user whose
 * profile path has Chinese characters and a space (cn-user; Run-AsUserInner.ps1 takes the
 * variables from that user's logon token and everything started from there inherits them), or
 * the stand-in profile (cn-profile-sim, passed through `profileEnv`). Each run checks that
 * Uninstall-ModelForge.ps1 saw the same folders as the harness.
 *
 * The dialogs are driven by scripts/Uninstall-ModelForge.ps1 with scripts/UninstallerDialogs.ps1:
 * it presses the buttons of whatever window the uninstaller shows, in order. The one-click
 * uninstaller first asks "Are you sure you want to uninstall ModelForge?" (OK, IDOK 1); the
 * assisted one shows its wizard instead (Next / Uninstall / Finish, 1). Then the keep-data
 * question of customUnInstall: Yes (IDYES 6) keeps the data, No (IDNO 7) removes it. Windows are
 * recognised by their controls and buttons by their control id, so the installer language does
 * not matter. Every press is in the result (`clicks`, `steps`); a timeout names the window the
 * run was waiting at. When UI Automation cannot reach or press the windows, the script exits
 * with code 3 and the test reports the prompt as unverified instead of passing.
 */
import { expect, test, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  annotate,
  appPaths,
  copyTreeSync,
  ensureProject,
  hasCjkAndSpace,
  hashTree,
  profileEnv,
  runHelper,
  smokeConfig,
  writeProjectFile,
  type HelperResult,
  type SmokeConfig,
} from './windows-smoke/harness';

const cfg = smokeConfig();

/** A window of the uninstaller as Uninstall-ModelForge.ps1 saw it. */
interface UninstallWindow {
  /**
   * confirm (OK/Cancel box), keep-data-question (Yes/No box), wizard (NSIS page), unexpected
   * (another box) or other (neither a box nor a wizard page).
   */
  role: string;
  /** Window handle; a new window (or wizard page) has a new one. */
  hwnd: number;
  title: string;
  process: string;
  pid: number;
  /** "<control id> '<label>'" for each button, comma-separated. */
  buttons: string;
  text: string;
}

/** One button press. */
interface UninstallStep extends UninstallWindow {
  /** Seconds since the uninstaller was started. */
  at: number;
  /** Control id of the pressed button (1 OK / Next, 6 Yes, 7 No). */
  pressed: number;
  label: string;
  method: string;
  /** 1 for the first press of this button in this window, more when it was pressed again. */
  attempt: number;
}

interface UninstallResult {
  ok: boolean;
  mode: 'Silent' | 'Keep' | 'Remove';
  uiaAvailable: boolean;
  /** finished | timeout | no-window | unexpected-dialog | no-reaction | cannot-click */
  outcome: string;
  /** one-click (OK/Cancel confirmation first) | assisted (NSIS wizard) | '' */
  flow: string;
  confirmSeen: boolean;
  confirmText: string;
  promptSeen: boolean;
  promptText: string;
  answered: string;
  dialogs: string[];
  clicks: string[];
  steps: UninstallStep[];
  /** Uninstaller windows open when the run ended (the one it was stuck at, after a timeout). */
  openWindows: UninstallWindow[];
  uiaErrors: string[];
  leftoverUninstallers: string[];
  killedUninstallers: string[];
  screenshots: string[];
  installDirExists: boolean;
  exePresent: boolean;
  remainingFiles: string[];
  uninstallEntryPresent: boolean;
  startMenuShortcut: string;
  startMenuShortcutPresent: boolean;
  desktopShortcut: string;
  desktopShortcutPresent: boolean;
  /** Account and profile variables the script (and so the uninstaller) ran with. */
  identity: string;
  userProfile: string;
  appData: string;
  localAppData: string;
  /** The four data folders under that profile, after the uninstall. */
  dataDirs: { path: string; exists: boolean }[];
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

/** Marker the harness puts into each data folder and the Project before an uninstall. */
const MARKER = 'mfsmoke-uninstall-marker.txt';

test.describe('installed ModelForge: uninstall options (7.10)', () => {
  test.skip(cfg === null, 'MODELFORGE_INSTALL_DIR is not set; run by modelforge-windows-smoke.yml');
  test.skip(cfg !== null && !cfg.installer, 'MODELFORGE_INSTALLER is not set');

  test('silent uninstall removes the program and keeps the user data', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const projectDir = ensureProject(c, testInfo);
    ensureInstalled(c, testInfo);
    const before = prepareData(c, testInfo, projectDir, 'silent');

    const run = await uninstall(c, testInfo, 'Silent');
    expectFinished(run);
    expectProgramRemoved(run.result);
    expectSameProfile(c, run.result);
    expect(run.result?.promptSeen, 'a silent uninstall asks nothing').toBe(false);

    expectDataKept(c, projectDir, before, 'silent uninstall');
  });

  test('interactive uninstall asks; answering "keep" leaves the data in place', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const projectDir = ensureProject(c, testInfo);
    ensureInstalled(c, testInfo);
    const before = prepareData(c, testInfo, projectDir, 'keep');

    const run = await uninstall(c, testInfo, 'Keep');
    skipIfUiaUnavailable(run.exitCode, testInfo);
    expectFinished(run);
    expectPrompt(run.result, 'yes');
    expectProgramRemoved(run.result);
    expectSameProfile(c, run.result);

    expectDataKept(c, projectDir, before, '"keep" answer');
  });

  test('interactive uninstall asks; answering "remove" deletes configuration and sessions but not Projects', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const paths = appPaths(c);
    const projectDir = ensureProject(c, testInfo);
    ensureInstalled(c, testInfo);
    expect(fs.existsSync(paths.sessionsDb), `there are sessions to remove (${paths.sessionsDb})`).toBe(true);
    // "remove" also deletes the app and kernel logs the workflow collects at the end.
    keepLogs(c, testInfo);
    const before = prepareData(c, testInfo, projectDir, 'remove');

    const run = await uninstall(c, testInfo, 'Remove');
    skipIfUiaUnavailable(run.exitCode, testInfo);
    expectFinished(run);
    expectPrompt(run.result, 'no');
    expectProgramRemoved(run.result);
    expectSameProfile(c, run.result);

    const after = dataSnapshot(c, projectDir);
    expect(fs.existsSync(projectDir), `the Project folder ${projectDir} is never removed`).toBe(true);
    expect(changed(before.project, after.project), 'the Project folder is unchanged').toEqual([]);
    const left = dataDirs(c).filter((entry) => fs.existsSync(entry.dir));
    for (const entry of left) {
      annotate(testInfo, 'left-behind', `${entry.label} (${entry.dir}): ${Object.keys(hashTree(entry.dir)).slice(0, 10).join(', ')}`);
    }
    expect(
      left.map((entry) => `${entry.label} (${entry.dir})`),
      'data folders left after answering "remove"'
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------

/** The folders build/installer.nsh removes on "remove", under the profile of the user under test. */
function dataDirs(c: SmokeConfig): { label: string; dir: string }[] {
  const paths = appPaths(c);
  return [
    { label: '%APPDATA%\\ModelForge', dir: paths.userData },
    { label: '%LOCALAPPDATA%\\modelforge-updater', dir: paths.updaterCache },
    { label: '%APPDATA%\\Block\\goose', dir: paths.gooseRoot },
    { label: '%LOCALAPPDATA%\\Block\\goose', dir: paths.gooseLocalRoot },
  ];
}

interface DataSnapshot {
  /** Label -> relative path -> SHA-256 (empty when the folder is missing). */
  dirs: Record<string, Record<string, string>>;
  project: Record<string, string>;
}

function dataSnapshot(c: SmokeConfig, projectDir: string): DataSnapshot {
  return {
    dirs: Object.fromEntries(dataDirs(c).map((entry) => [entry.label, hashTree(entry.dir)])),
    project: hashTree(projectDir),
  };
}

/**
 * Puts a marker into each data folder (creating the folders nothing has created yet) and into
 * the Project, so keeping and removing are both observable, and returns the snapshot to compare.
 */
function prepareData(c: SmokeConfig, testInfo: TestInfo, projectDir: string, run: string): DataSnapshot {
  const created: string[] = [];
  const stamp = `${run} ${new Date().toISOString()}\n`;
  for (const entry of dataDirs(c)) {
    if (!fs.existsSync(entry.dir)) {
      fs.mkdirSync(entry.dir, { recursive: true });
      created.push(`${entry.label} (${entry.dir})`);
    }
    fs.writeFileSync(path.join(entry.dir, MARKER), stamp, 'utf8');
  }
  if (created.length > 0) {
    annotate(testInfo, 'setup', `created before the ${run} run, as nothing had yet: ${created.join(', ')}`);
  }
  writeProjectFile(projectDir, MARKER, stamp);
  return dataSnapshot(c, projectDir);
}

/** All four data folders are still there with the same files, and so is the Project. */
function expectDataKept(c: SmokeConfig, projectDir: string, before: DataSnapshot, run: string): void {
  const missing = dataDirs(c).filter((entry) => !fs.existsSync(entry.dir));
  expect(
    missing.map((entry) => `${entry.label} (${entry.dir})`),
    `data folders missing after a ${run}`
  ).toEqual([]);
  const after = dataSnapshot(c, projectDir);
  for (const entry of dataDirs(c)) {
    expect(changed(before.dirs[entry.label], after.dirs[entry.label]), `${entry.label} unchanged by a ${run}`).toEqual([]);
  }
  expect(fs.existsSync(projectDir), `the Project folder ${projectDir} is never removed`).toBe(true);
  expect(changed(before.project, after.project), `the Project folder unchanged by a ${run}`).toEqual([]);
}

/** The uninstaller ran with the same profile folders as the harness (see the file comment). */
function expectSameProfile(c: SmokeConfig, result: UninstallResult | null): void {
  const paths = appPaths(c);
  const same = (a: string | undefined, b: string) =>
    path.resolve(a ?? '').toLowerCase() === path.resolve(b).toLowerCase();
  expect(same(result?.appData, paths.appData), `uninstaller APPDATA ${result?.appData} is ${paths.appData}`).toBe(true);
  expect(
    same(result?.localAppData, paths.localAppData),
    `uninstaller LOCALAPPDATA ${result?.localAppData} is ${paths.localAppData}`
  ).toBe(true);
  if (c.scenario !== 'primary') {
    // The scenario user's own profile (Chinese characters and a space), not the runner's.
    expect(hasCjkAndSpace(paths.appData), `APPDATA of the ${c.scenario} user: ${paths.appData}`).toBe(true);
    expect(hasCjkAndSpace(paths.localAppData), `LOCALAPPDATA of the ${c.scenario} user: ${paths.localAppData}`).toBe(true);
  }
}

/** Copies the logs and settings "remove" is about to delete into the evidence directory. */
function keepLogs(c: SmokeConfig, testInfo: TestInfo): void {
  const paths = appPaths(c);
  const target = path.join(c.evidenceDir, 'before-remove');
  // Never the credential store (agent-kernel-secrets.json) or the kernel's secrets.yaml.
  const items: [string, string][] = [
    [paths.appLogsDir, 'desktop-logs'],
    [paths.settingsFile, 'settings.json'],
    [paths.gooseLogsDir, 'kernel-logs'],
    [paths.gooseConfigFile, 'config.yaml'],
  ];
  for (const [source, name] of items) {
    if (!fs.existsSync(source)) {
      continue;
    }
    try {
      // Not fs.cpSync: it aborts the worker for a source under a Chinese profile path (harness).
      copyTreeSync(source, path.join(target, name));
    } catch (error) {
      annotate(testInfo, 'evidence', `could not copy ${source}: ${String(error)}`);
    }
  }
}

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
  const env = profileEnv(c);
  if (env.TEMP) {
    // The uninstaller copies itself to %TEMP% before it runs.
    fs.mkdirSync(env.TEMP, { recursive: true });
  }
  const run = runHelper<UninstallResult>(
    c,
    'Uninstall-ModelForge.ps1',
    { Mode: mode, EvidenceDir: path.join(c.evidenceDir, `uninstall-${mode.toLowerCase()}`) },
    10 * 60_000,
    env
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
      'UI Automation could not reach or press the uninstaller dialogs; the keep/remove prompt is not verified on this runner'
    );
  }
  expect(exitCode, 'UI Automation reached the uninstaller dialogs').not.toBe(EXIT_UIA_UNAVAILABLE);
}

/** The run for messages: outcome, flow, the presses in order and the windows still open. */
function describeRun(result: UninstallResult | null): string {
  if (!result) {
    return 'no result file';
  }
  const lines = [
    `outcome ${result.outcome || '-'}, flow ${result.flow || '-'}, clicks: ${(result.clicks ?? []).join(' -> ') || 'none'}`,
    ...(result.openWindows ?? []).map(
      (window) => `still open: ${window.role} '${window.title}' (${window.process} ${window.pid}) [${window.buttons}] ${window.text}`
    ),
  ];
  return lines.join('\n');
}

/** The script finished; otherwise its error (where it stopped, what it pressed) comes first. */
function expectFinished(run: HelperResult<UninstallResult>): void {
  const detail = [run.result?.error ? `error: ${run.result.error}` : '', describeRun(run.result), run.output.slice(-3_000)]
    .filter(Boolean)
    .join('\n');
  expect(run.exitCode, detail).toBe(0);
}

/**
 * The keep-data question of build/installer.nsh was asked once and answered with the right
 * button: Yes (IDYES 6) keeps, No (IDNO 7) removes. A confirmation box before it (one-click
 * uninstaller) was accepted with OK (IDOK 1).
 */
function expectPrompt(result: UninstallResult | null, answer: 'yes' | 'no'): void {
  const run = describeRun(result);
  expect(result?.promptSeen, `the uninstaller asked whether to keep the data\n${run}`).toBe(true);
  expect(result?.promptText ?? '', 'the question is the one from build/installer.nsh').toContain('是否保留');
  expect(result?.promptText ?? '', 'the question says Projects are never deleted').toContain('项目文件夹');
  expect(result?.answered).toBe(answer);

  const steps = result?.steps ?? [];
  const answers = steps.filter((step) => step.role === 'keep-data-question');
  const expected = answer === 'yes' ? 6 : 7;
  expect(
    [...new Set(answers.map((step) => step.pressed))],
    `answered with ${answer === 'yes' ? 'Yes (6): keep' : 'No (7): remove'}\n${run}`
  ).toEqual([expected]);
  // Presses repeated on the same box share its window handle.
  expect(new Set(answers.map((step) => step.hwnd)).size, `the question was asked once\n${run}`).toBe(1);
  const firstAnswer = steps.indexOf(answers[0]);
  for (const [index, step] of steps.entries()) {
    if (step.role === 'confirm') {
      expect(step.pressed, `the confirmation "${step.text}" was accepted with OK (1)`).toBe(1);
      expect(index, `the confirmation came before the question\n${run}`).toBeLessThan(firstAnswer);
    }
  }
}

function expectProgramRemoved(result: UninstallResult | null): void {
  expect(result, 'uninstall result').toBeTruthy();
  expect(result?.exePresent, 'ModelForge.exe removed').toBe(false);
  expect(result?.remainingFiles ?? [], 'program files left in the install directory').toEqual([]);
  expect(result?.uninstallEntryPresent, '"Apps & features" entry removed').toBe(false);
  expect(result?.startMenuShortcutPresent, `Start menu shortcut ${result?.startMenuShortcut} removed`).toBe(false);
  expect(result?.desktopShortcutPresent, `desktop shortcut ${result?.desktopShortcut} removed`).toBe(false);
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

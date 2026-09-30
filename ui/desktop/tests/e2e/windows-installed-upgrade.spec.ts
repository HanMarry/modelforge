/**
 * Upgrade smoke test (spec mathmodel-parity-and-beyond, task 13.6; requirement 7.5): installing
 * over an existing ModelForge keeps the user's configuration, sessions, Projects and stored
 * keys, and the app shows the same number of sessions and Projects afterwards.
 *
 * Run after windows-installed-smoke.spec.ts in the same profile, so there is history to keep.
 * The workflow has one installer, so the "new version" is the same build installed again over
 * the existing one. The NSIS side is the same as for a real version bump: the installer finds
 * the uninstall entry, runs the installed uninstaller with `--updated` (customUnInstall in
 * build/installer.nsh then leaves the data alone) and writes the new files. What a same-version
 * run cannot show is a data migration between versions; none exists today.
 *
 * In strict mode (the default, see `WIZARD_STRICT` in the harness) the chats before and after
 * the upgrade run on the provider, model and key the wizard saved in the primary scenario, so
 * the post-upgrade chat also shows that the kernel's configuration and secret store survived.
 */
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import {
  annotate,
  appPaths,
  dismissInterruptions,
  ensureKernelSeeded,
  ensureProject,
  hashTree,
  kernelChatUse,
  kernelEnv,
  listRecentDirs,
  newNonce,
  readSessions,
  runHelper,
  sendChat,
  sleep,
  smokeConfig,
  visibleSessions,
  waitForAssistant,
  waitForShell,
  withApp,
  wizardKernelConfigProblems,
  STUB_MODEL,
  WIZARD_STRICT,
  type SmokeConfig,
} from './windows-smoke/harness';

const cfg = smokeConfig();

/** File time set on the installed executable before the reinstall. */
const BACKDATED = new Date('2001-01-01T00:00:00Z');

interface InstallResult {
  ok: boolean;
  exitCode: number | null;
  exe: string;
  exeWriteTimeUtc: string;
  displayVersion: string;
  error: string | null;
}

interface Shown {
  sessionCards: number;
  sessionNames: string[];
  recentDirs: string[];
}

test.describe('installed ModelForge: upgrade keeps user data (7.5)', () => {
  test.skip(cfg === null, 'MODELFORGE_INSTALL_DIR is not set; run by modelforge-windows-smoke.yml');
  test.skip(cfg !== null && !cfg.installer, 'MODELFORGE_INSTALLER is not set');

  test('installing over the existing installation keeps configuration, sessions, Projects and keys', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const paths = appPaths(c);
    if (WIZARD_STRICT) {
      // The chats below run on the provider the wizard saved in the primary scenario; the
      // harness supplies nothing, so say plainly when it is missing.
      expect(
        wizardKernelConfigProblems(c),
        `the provider saved by the wizard is in ${paths.gooseConfigFile}`
      ).toEqual([]);
    } else {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);

    // History to keep: the main spec leaves several sessions; make one if it did not.
    if (visibleSessions(await readSessions(paths.sessionsDb)).length === 0) {
      annotate(testInfo, 'setup', 'no session history yet; creating one before the upgrade');
      await chatOnce(c, testInfo, 'pre-upgrade-chat');
    }

    const shownBefore = await withApp(c, testInfo, 'before-upgrade', { env: kernelEnv(c) }, (app) => shownCounts(app.page));
    annotate(testInfo, 'shown-before', JSON.stringify(shownBefore));
    expect(shownBefore.sessionCards, 'sessions listed before the upgrade').toBeGreaterThan(0);

    const sessionsBefore = await readSessions(paths.sessionsDb);
    const before = snapshot(c, projectDir);
    // The installer may restore the archived file times, so reinstalling the same build could
    // leave the mtime as it was. Backdate the installed executable to make a rewrite visible.
    fs.utimesSync(c.exe, BACKDATED, BACKDATED);

    const install = runHelper<InstallResult>(
      c,
      'Install-ModelForge.ps1',
      { Installer: c.installer, InstallDir: c.installDir },
      20 * 60_000
    );
    annotate(testInfo, 'reinstall', JSON.stringify(install.result ?? { output: install.output.slice(-2_000) }));
    expect(install.exitCode, `installer run failed:\n${install.output.slice(-4_000)}`).toBe(0);
    expect(install.result?.ok).toBe(true);
    // The installer really replaced the program files.
    expect(fs.statSync(c.exe).mtimeMs, 'ModelForge.exe was rewritten').toBeGreaterThan(BACKDATED.getTime() + 60_000);

    // Nothing the user owns changed on disk.
    const after = snapshot(c, projectDir);
    expect(diffKeys(before.userData, after.userData), `desktop data under ${paths.userData}`).toEqual([]);
    expect(diffKeys(before.kernel, after.kernel), `kernel configuration and sessions under ${paths.gooseRoot}`).toEqual([]);
    expect(diffKeys(before.project, after.project), `Project ${projectDir}`).toEqual([]);
    // The stored key was among the files kept. In strict mode the wizard saved it; in soft mode
    // the wizard may not have got that far (the harness then passes the key through the
    // environment) and there is no key store to keep.
    if (WIZARD_STRICT || fs.existsSync(paths.credentialsFile)) {
      expect(Object.keys(before.userData), `the key store ${paths.credentialsFile} before the upgrade`).toContain(
        'agent-kernel-secrets.json'
      );
    } else {
      annotate(testInfo, 'unverified', `no key store at ${paths.credentialsFile} (soft mode): keeping keys not shown`);
    }

    // The app shows the same sessions and Projects, and still reaches the model.
    const shownAfter = await withApp(c, testInfo, 'after-upgrade', { env: kernelEnv(c) }, async (app) => {
      const shown = await shownCounts(app.page);
      await app.snap('sessions-after-upgrade');
      return shown;
    });
    annotate(testInfo, 'shown-after', JSON.stringify(shownAfter));
    expect(shownAfter.sessionCards, 'sessions listed after the upgrade').toBe(shownBefore.sessionCards);
    expect([...shownAfter.sessionNames].sort()).toEqual([...shownBefore.sessionNames].sort());
    expect(shownAfter.recentDirs, 'recent Projects after the upgrade').toEqual(shownBefore.recentDirs);

    // Every session from before is still there with all its messages (opening the app may add
    // an empty one, which does not count).
    const afterById = new Map((await readSessions(paths.sessionsDb)).map((row) => [row.id, row]));
    const lost = sessionsBefore
      .filter((row) => afterById.get(row.id)?.messages !== row.messages)
      .map((row) => `${row.id} (${row.messages} messages)`);
    expect(lost, 'sessions lost or shortened by the upgrade').toEqual([]);

    await chatOnce(c, testInfo, 'post-upgrade-chat');
  });
});

// ---------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------

interface Snapshot {
  userData: Record<string, string>;
  kernel: Record<string, string>;
  project: Record<string, string>;
}

function snapshot(c: SmokeConfig, projectDir: string): Snapshot {
  const paths = appPaths(c);
  return {
    userData: hashTree(paths.userData),
    kernel: hashTree(paths.gooseRoot),
    project: hashTree(projectDir),
  };
}

/** Files added, removed or changed between two hash trees. */
function diffKeys(before: Record<string, string>, after: Record<string, string>): string[] {
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

/** What the app displays: the session history cards and the recent Project folders. */
async function shownCounts(page: Page): Promise<Shown> {
  const shell = await waitForShell(page, 90_000);
  expect(shell, 'main window').toBe('main');
  await dismissInterruptions(page);
  const recentDirs = await listRecentDirs(page);
  await page.evaluate(() => {
    window.location.hash = '#/sessions';
  });
  const titles = page.locator('h3.line-clamp-2');
  await expect(titles.first()).toBeVisible({ timeout: 60_000 });
  // The list loads in pages; wait until the count stops changing and no skeleton is left.
  let last = -1;
  let stable = 0;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && stable < 3) {
    const skeletons = await page.locator('.session-skeleton').count();
    const count = await titles.count();
    stable = count === last && skeletons === 0 ? stable + 1 : 0;
    last = count;
    await sleep(1_000);
  }
  const sessionNames = (await titles.allInnerTexts()).map((name) => name.trim());
  return { sessionCards: sessionNames.length, sessionNames, recentDirs };
}

async function chatOnce(c: SmokeConfig, testInfo: TestInfo, label: string): Promise<void> {
  const nonce = newNonce();
  await withApp(c, testInfo, label, { env: kernelEnv(c) }, async (app) => {
    const shell = await waitForShell(app.page, 90_000);
    expect(shell, 'main window').toBe('main');
    await sendChat(app.page, `请回复冒烟口令。MFSMOKE_NONCE:${nonce}`);
    await waitForAssistant(app.page, testInfo, new RegExp(`MODELFORGE_WINDOWS_SMOKE_OK[^\\n]*${nonce}`), 180_000);
    await app.snap(label);
  });
  // The model and the key the wizard saved are still what the kernel uses.
  const use = await kernelChatUse(c, nonce);
  annotate(testInfo, `${label}-requests`, JSON.stringify(use));
  expect(use.models, `${label}: model the kernel asked for`).toContain(STUB_MODEL);
  expect(use.withoutKey, `${label}: chat requests sent without the key`).toBe(0);
  // Give the kernel a moment to flush the session to disk before the files are hashed.
  await sleep(1_000);
}

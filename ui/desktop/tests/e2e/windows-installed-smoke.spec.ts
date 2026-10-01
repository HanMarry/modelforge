/**
 * Smoke test of the INSTALLED Windows build (spec mathmodel-parity-and-beyond, task 13.6;
 * requirement 7.2-7.4). Driven by .github/workflows/modelforge-windows-smoke.yml through
 * tests/e2e/windows-smoke/playwright.config.ts; see windows-smoke/harness.ts for how the packaged
 * ModelForge.exe is launched (clean PATH, CDP instead of `_electron.launch`) and the stub for the
 * scripted model (windows-smoke/openai-stub.cjs).
 *
 * The tests run in order in one worker and share state through MODELFORGE_SMOKE_STATE_DIR, but a
 * failure does not skip the later ones: each checks what it needs and falls back (reported as a
 * `harness-substitution` annotation) so one broken flow does not hide the others.
 *
 *   1. clean machine: nothing forbidden on the app's PATH, Python and Typst present
 *   2. first launch shows the wizard or the main window within 30 s (7.2)
 *   3. first-run configuration through the wizard, persisted across a restart (7.3)
 *   4. plain chat receives the model reply (7.3)
 *   5. Python execution returns exit code 0 and its stdout (7.3)
 *   6. paper compilation writes a PDF inside the Project (7.3)
 *   7. phase-2 entries open without errors: resume prompt, /learning, workspace tabs
 *   8. phase-1 entries open (task 20; primary scenario): diagnostics center, competitions,
 *      example library, datasets, gallery, join collaboration, the workspace browser tab, the
 *      versions panel's auto snapshots and the connectors page's Feishu section
 *   9. paper check runs read-only in its utility process and reads the PDF with pdfjs
 *
 * Test 3 creates the example Project through wizard step 4 as a user does, including the
 * Windows folder dialog, which scripts/Select-FolderInDialog.ps1 drives with UI Automation.
 *
 * The scenario (`primary`, `cn-user`, `cn-profile-sim`) only changes which paths must contain
 * Chinese characters and spaces (7.4).
 *
 * Wizard step 2 is where the product configures the built-in kernel: the test types the stub's
 * address, a key and the stub's model, and after "连接成功" the kernel's config.yaml must hold
 * that provider, address and model (`readWizardKernelConfig` in the harness). In strict mode
 * (the default, see `WIZARD_STRICT`) these are hard assertions and tests 4-8 run on that
 * configuration alone: the harness supplies no endpoint, model or key. With
 * MODELFORGE_SMOKE_WIZARD_STRICT=0 they are soft, the step is skipped as a user would when it
 * fails, and `ensureKernelSeeded` stands in for the missing configuration (reported), so the
 * later flows are still covered when the product regresses.
 */
import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import {
  annotate,
  appPaths,
  checkCleanEnvironment,
  createExampleProject,
  dismissInterruptions,
  ensureKernelSeeded,
  ensureProject,
  expectedWizardKernelConfig,
  hasCjkAndSpace,
  hashTree,
  kernelChatUse,
  kernelEnv,
  listRecentDirs,
  newNonce,
  projectParentDir,
  readCredentialEntries,
  readOnboarding,
  readState,
  readWizardKernelConfig,
  removeSync,
  runHelperAsync,
  runRecords,
  sendChat,
  sleep,
  smokeConfig,
  stubRequests,
  toolDirective,
  waitForAssistant,
  waitForShell,
  withApp,
  wizardAddress,
  writeProjectFile,
  writeState,
  STUB_MODEL,
  WIZARD_PROVIDER,
  WIZARD_STRICT,
  type DismissOptions,
  type LaunchedApp,
  type SmokeConfig,
} from './windows-smoke/harness';

const cfg = smokeConfig();

/** Requirement 7.2: wizard or main window within 30 s of starting ModelForge.exe. */
const FIRST_SHELL_BUDGET_MS = 30_000;

/**
 * Wizard step 2 runs one connectivity request and then saves the key and the provider in the
 * desktop store and the kernel (three calls); "连接成功" or an error shows only after all of it.
 */
const WIZARD_SAVE_BUDGET_MS = 90_000;

/**
 * Providers step 1 must not offer (requirement 5.1, wizardProviderSetup.ts
 * `canConfigureInWizard`): ACP agents, sign-in only providers and providers that need more than a
 * key and an address. Display names as the kernel lists them (crates/goose/src/providers and
 * crates/goose-providers/src).
 */
const NOT_IN_WIZARD = [
  'Azure OpenAI',
  'Databricks',
  'GCP Vertex AI',
  'GitHub Copilot',
  'Ollama',
  'Claude Code ACP',
  'Codex ACP',
];

/** `expect` for the wizard step 2 checks: hard in strict mode, soft otherwise. */
function wizardExpect<T>(actual: T, message: string) {
  return WIZARD_STRICT ? expect(actual, message) : expect.soft(actual, message);
}

test.describe('installed ModelForge (Windows smoke)', () => {
  test.skip(cfg === null, 'MODELFORGE_INSTALL_DIR is not set; run by modelforge-windows-smoke.yml');

  test('clean machine: no Rust, Node or ACP adapter on the app PATH; Python and Typst present', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const report = checkCleanEnvironment(c);
    annotate(testInfo, 'app-path', report.path);
    for (const [command, version] of Object.entries(report.versions)) {
      annotate(testInfo, 'runtime', `${command}: ${version}`);
    }
    expect(report.forbiddenFound, 'commands a clean student machine does not have').toEqual([]);
    expect(report.requiredMissing, 'optional runtimes the smoke machine must provide').toEqual([]);

    expect(fs.existsSync(c.exe), `installed executable ${c.exe}`).toBe(true);
    for (const file of ['goose.exe', 'build-manifest.json']) {
      const target = path.join(c.installDir, 'resources', 'bin', file);
      expect(fs.existsSync(target), `installed ${target}`).toBe(true);
    }

    // Requirement 7.4: the paths this scenario is about.
    const paths = appPaths(c);
    annotate(testInfo, 'install-dir', c.installDir);
    annotate(testInfo, 'user-profile', paths.home);
    if (c.scenario === 'primary') {
      expect(hasCjkAndSpace(c.installDir), `install dir has Chinese and a space: ${c.installDir}`).toBe(true);
    } else {
      expect(hasCjkAndSpace(paths.home), `user profile has Chinese and a space: ${paths.home}`).toBe(true);
      // The app, the kernel and the uninstaller use this user's own folders, not the runner's.
      expect(paths.appData.startsWith(paths.home), `APPDATA ${paths.appData} lives in the profile`).toBe(true);
      expect(
        paths.localAppData.startsWith(paths.home),
        `LOCALAPPDATA ${paths.localAppData} lives in the profile`
      ).toBe(true);
    }
    expect(hasCjkAndSpace(projectParentDir(c))).toBe(true);
  });

  test('first launch shows the wizard or the main window within 30 s', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const paths = appPaths(c);
    if (fs.existsSync(paths.userData) || fs.existsSync(paths.gooseConfigFile)) {
      annotate(testInfo, 'not-first-launch', `app data already exists under ${paths.userData} or ${paths.gooseRoot}`);
    }
    await withApp(c, testInfo, 'first-launch', { windowTimeoutMs: FIRST_SHELL_BUDGET_MS }, async (app) => {
      const remaining = Math.max(1_000, FIRST_SHELL_BUDGET_MS - (Date.now() - app.spawnedAt));
      const shell = await waitForShell(app.page, remaining);
      const elapsed = Date.now() - app.spawnedAt;
      await app.snap('first-shell');
      writeState(c, { firstShell: shell, firstShellMs: elapsed });
      annotate(testInfo, 'first-shell', `${shell} after ${elapsed} ms (window reachable after ${app.windowAt - app.spawnedAt} ms)`);
      expect(shell === 'wizard' || shell === 'main', `first screen: ${shell}`).toBe(true);
      expect(elapsed, 'milliseconds until the wizard or main window').toBeLessThanOrEqual(FIRST_SHELL_BUDGET_MS);
      // No provider is configured on a clean machine, so the wizard is what should show.
      if (shell === 'main') {
        annotate(testInfo, 'unexpected', 'the main window showed instead of the onboarding wizard on a clean profile');
      }
    });
  });

  test('first-run configuration through the wizard is saved and survives a restart', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    const paths = appPaths(c);
    const parentDir = projectParentDir(c);
    fs.mkdirSync(parentDir, { recursive: true });
    const wizardStartedAt = new Date().toISOString();

    await withApp(c, testInfo, 'wizard', {}, async (app) => {
      const { page } = app;
      const shell = await waitForShell(page, 90_000, 'wizard');
      expect(shell, 'the wizard is shown while no provider is configured').toBe('wizard');
      await dismissInterruptions(page);

      // Step 1: provider. Only providers a key and an address configure are offered, and a
      // clean machine has no local ACP runtime (Claude Code, Codex) to offer either.
      const openai = page.getByRole('button', { name: 'OpenAI', exact: true });
      await openai.waitFor({ state: 'visible', timeout: 60_000 });
      // Local runtimes are detected separately from the provider list; give them time to show.
      const seen = new Set<string>();
      const settleUntil = Date.now() + 10_000;
      while (Date.now() < settleUntil) {
        for (const label of await page.locator('div.grid > button').allInnerTexts()) {
          seen.add(label.trim());
        }
        await sleep(1_000);
      }
      const offered = [...seen];
      annotate(testInfo, 'wizard-providers', offered.join(', '));
      wizardExpect(
        offered.filter((label) => NOT_IN_WIZARD.includes(label) || label.includes('通过 ACP 接入本机运行时')),
        'step 1 offers only providers an API key and an address configure'
      ).toEqual([]);
      await openai.click();
      await clickNext(page);

      // Step 2: address, key and model, then "测试连接": one connectivity request to the stub,
      // after which the wizard stores the key in the desktop credential store and saves the key,
      // the address (ACP providers/config/save) and the provider and model (defaults/save) in
      // the kernel. "连接成功" shows only once all of that is saved; any failure shows an error
      // and keeps the input on this step.
      await expect(page.getByText(/第 2 步\/共 4 步/)).toBeVisible();
      const address = page.locator('#onboarding-address');
      const model = page.locator('#onboarding-model');
      annotate(
        testInfo,
        'wizard-defaults',
        `address ${await address.inputValue()}, model ${await model.inputValue()}`
      );
      await address.fill(wizardAddress(c));
      await page.locator('#onboarding-key').fill(`sk-wizard-${newNonce()}`);
      // goose may send known OpenAI models to the Responses API, which the stub does not serve.
      await model.fill(STUB_MODEL);
      const testButton = page.getByRole('button', { name: '测试连接', exact: true });
      await testButton.click();
      const first = await firstVisible(page, WIZARD_SAVE_BUDGET_MS, {
        success: page.getByText('连接成功', { exact: true }),
        failure: page.locator('p.text-red-600'),
      });
      annotate(testInfo, 'wizard-connectivity', `first result: ${first}`);
      await expect(testButton, 'the test button is idle again').toBeEnabled({ timeout: WIZARD_SAVE_BUDGET_MS });
      const succeeded = await page.getByText('连接成功', { exact: true }).isVisible().catch(() => false);
      const errors = (await page.locator('p.text-red-600').allInnerTexts().catch(() => [])).map((t) => t.trim());
      const nextEnabled = await page.getByRole('button', { name: '下一步', exact: true }).isEnabled();
      // "连接成功" means the kernel already has the provider: read config.yaml at that moment.
      const atSuccess = readWizardKernelConfig(c);
      await app.snap('wizard-key');
      annotate(
        testInfo,
        'wizard-mode',
        WIZARD_STRICT ? 'strict (the later flows run on what the wizard saved)' : 'soft (MODELFORGE_SMOKE_WIZARD_STRICT=0)'
      );
      const detail = `connectivity ${succeeded ? 'ok' : 'not ok'}, errors: ${errors.join(' / ') || '(none)'}`;
      if (!(succeeded && nextEnabled && errors.length === 0)) {
        annotate(testInfo, 'product-defect', `wizard step 2 cannot be completed on a clean machine (${detail})`);
      }
      wizardExpect(succeeded, `wizard step 2: "连接成功" after saving (${detail})`).toBe(true);
      wizardExpect(errors, `wizard step 2: no error while testing and saving (${detail})`).toEqual([]);
      wizardExpect(nextEnabled, `wizard step 2 lets the user continue (${detail})`).toBe(true);
      if (succeeded) {
        annotate(testInfo, 'wizard-kernel-config', JSON.stringify(atSuccess));
        wizardExpect(
          atSuccess,
          `kernel configuration ${paths.gooseConfigFile} when "连接成功" shows`
        ).toEqual(expectedWizardKernelConfig(c));
      }
      if (succeeded && nextEnabled) {
        await clickNext(page);
        writeState(c, { wizardProviderSaved: errors.length === 0 });
      } else {
        // Soft mode only (strict mode stopped above): skip the step as a user would, and keep
        // going so steps 3 and 4 are still covered.
        await page.getByRole('button', { name: '跳过', exact: true }).click();
        writeState(c, { wizardProviderSaved: false });
      }

      // Step 3: environment detection must find Python and a paper compiler (Typst).
      await expect(page.getByText(/第 3 步\/共 4 步/)).toBeVisible();
      const python = page.getByText(/^Python：/).first();
      const typesetting = page.getByText(/^论文编译环境：/).first();
      await expect(python).toBeVisible({ timeout: 40_000 });
      await expect(typesetting).toBeVisible({ timeout: 40_000 });
      const pythonText = (await python.innerText()).trim();
      const typesettingText = (await typesetting.innerText()).trim();
      annotate(testInfo, 'wizard-environment', `${pythonText} | ${typesettingText}`);
      await app.snap('wizard-environment');
      expect(pythonText).toMatch(/^Python：可用/);
      expect(typesettingText).toMatch(/^论文编译环境：可用/);
      await clickNext(page);

      // Step 4: example Project, as a user creates it. "选择保存位置" opens the Windows folder
      // dialog (main.ts 'directory-chooser'), which CDP cannot reach, so
      // scripts/Select-FolderInDialog.ps1 does the user's part there: it types the folder into
      // the dialog's folder box and presses OK. Then "创建并打开". Only a dialog that cannot be
      // driven at all is replaced by the IPC the button uses, reported as a substitution.
      await expect(page.getByText(/第 4 步\/共 4 步/)).toBeVisible();
      const listed = await firstVisible(page, 30_000, {
        list: page.getByRole('radiogroup', { name: '示例题' }),
        empty: page.getByText(/^暂无可直接打开的示例题/),
      });
      if (listed === 'list') {
        await page.getByRole('button', { name: '选择保存位置', exact: true }).click();
        const pick = await runHelperAsync<FolderDialogResult>(
          c,
          'Select-FolderInDialog.ps1',
          {
            ProcessId: String(app.child.pid),
            Folder: parentDir,
            EvidenceDir: path.join(c.evidenceDir, 'folder-dialog'),
          },
          120_000
        );
        const picked = pick.result;
        annotate(
          testInfo,
          'folder-dialog',
          picked
            ? JSON.stringify({
                outcome: picked.outcome,
                dialog: picked.dialog,
                text: picked.textMethod,
                presses: picked.presses,
                cancelled: picked.cancelled,
                ...(picked.ok ? {} : { editBoxes: picked.editBoxes, message: picked.messageText, error: picked.error }),
              })
            : `no result (exit ${pick.exitCode}): ${pick.output.slice(-1_500)}`
        );
        for (const shot of picked?.screenshots ?? []) {
          if (fs.existsSync(shot)) {
            await testInfo.attach(path.basename(shot), { path: shot, contentType: 'image/png' });
          }
        }
        if (pick.exitCode === 0) {
          // The step shows the folder the dialog returned, and the Project is created in it.
          await expect(page.getByText('尚未选择保存位置', { exact: true })).toBeHidden({ timeout: 15_000 });
          await expect(page.getByText(new RegExp(`^${escapeRegExp(parentDir)}\\\\?$`, 'i'))).toBeVisible();
          await app.snap('wizard-location');
          await page.getByRole('button', { name: '创建并打开', exact: true }).click();
          await expect(page.getByText(/第 4 步\/共 4 步/)).toBeHidden({ timeout: 60_000 });
          const recent = await listRecentDirs(page);
          const projectDir = recent[0] ?? '';
          expect(isInsideDir(projectDir, parentDir), `new Project ${projectDir} under ${parentDir}`).toBe(true);
          writeState(c, { projectDir, projectVia: 'wizard-button' });
        } else {
          if (pick.exitCode !== EXIT_NO_FOLDER_DIALOG) {
            annotate(testInfo, 'unexpected', `the folder dialog opened but could not be used: ${picked?.error ?? pick.output.slice(-500)}`);
          }
          const created = await createExampleProject(page, parentDir);
          writeState(c, { projectDir: created.projectDir, exampleId: created.exampleId, projectVia: 'wizard-ipc' });
          annotate(
            testInfo,
            'harness-substitution',
            `folder dialog not driven (${picked?.outcome ?? `exit ${pick.exitCode}`}); Project created through project-create-from-example (${created.exampleId})`
          );
          await page.getByRole('button', { name: '完成', exact: true }).click();
        }
      } else {
        annotate(testInfo, 'unexpected', 'no locally available example problem in the installed build');
        await page.getByRole('button', { name: '完成', exact: true }).click();
      }

      const after = await waitForShell(page, 60_000, 'main');
      await app.snap('wizard-done');
      expect(after, 'the main window follows the wizard').toBe('main');
    });

    // What the wizard saved (read from disk while the app is closed).
    const onboarding = readOnboarding(c);
    expect(onboarding?.completed, 'settings.json onboarding.completed').toBe(true);
    annotate(testInfo, 'wizard-steps', JSON.stringify(onboarding?.steps ?? {}));
    expect(onboarding?.steps?.provider).toBe('done');
    wizardExpect(onboarding?.steps?.key, 'wizard step 2 recorded as done').toBe('done');
    const credentials = readCredentialEntries(paths.credentialsFile);
    const providerKey = credentials?.[`provider:${WIZARD_PROVIDER}`] ?? '';
    expect(providerKey.startsWith('enc:'), 'desktop credential store holds the encrypted key').toBe(true);
    // The kernel's own configuration, as the wizard left it once the app has quit.
    const kernelConfig = readWizardKernelConfig(c);
    wizardExpect(kernelConfig, `kernel configuration ${paths.gooseConfigFile} after the wizard`).toEqual(
      expectedWizardKernelConfig(c)
    );
    const probes = (await stubRequests(c)).filter(
      (entry) => entry.method === 'GET' && entry.path.endsWith('/models') && entry.at >= wizardStartedAt
    );
    expect(probes.length, 'the connectivity test reached the stub').toBeGreaterThan(0);
    expect(probes.every((entry) => entry.auth), 'the connectivity test sent the key').toBe(true);
    writeState(c, { wizardCompleted: onboarding?.completed === true });

    // Requirement 7.3: the configuration survives a restart and the wizard does not come back.
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    await withApp(c, testInfo, 'restart', { env: kernelEnv(c), windowTimeoutMs: FIRST_SHELL_BUDGET_MS }, async (app) => {
      const remaining = Math.max(1_000, FIRST_SHELL_BUDGET_MS - (Date.now() - app.spawnedAt));
      const shell = await waitForShell(app.page, remaining, 'main');
      annotate(testInfo, 'restart-shell', `${shell} after ${Date.now() - app.spawnedAt} ms`);
      expect(shell, 'after a restart the main window shows, not the wizard').toBe('main');
      const persisted = await app.page.evaluate(() =>
        (window as unknown as { electron: { getSetting: (key: string) => Promise<unknown> } }).electron.getSetting(
          'onboarding'
        )
      );
      expect((persisted as { completed?: boolean } | null)?.completed).toBe(true);
    });
    expect(
      readCredentialEntries(paths.credentialsFile)?.[`provider:${WIZARD_PROVIDER}`],
      'stored key after a restart'
    ).toBe(providerKey);
    expect(readOnboarding(c), 'onboarding record after a restart').toEqual(onboarding);
    expect(readWizardKernelConfig(c), 'kernel configuration after a restart').toEqual(kernelConfig);
  });

  test('plain chat receives the model reply', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);
    const nonce = newNonce();
    await withProjectApp(c, testInfo, 'chat', projectDir, async (app) => {
      await sendChat(app.page, `请回复冒烟口令。MFSMOKE_NONCE:${nonce}`);
      const reply = await waitForReply(app, testInfo, new RegExp(`MODELFORGE_WINDOWS_SMOKE_OK[^\\n]*${nonce}`), 180_000);
      annotate(testInfo, 'reply', reply.slice(0, 200));
      await app.snap('chat');
    });
    // In strict mode the app got no endpoint, model or key from the harness, so the kernel
    // reached the stub with what the wizard saved.
    const use = await kernelChatUse(c, nonce);
    const { offeredToolNames, ...requestFacts } = use;
    annotate(
      testInfo,
      'kernel-requests',
      `${JSON.stringify(requestFacts)}; configuration from ${readState(c).providerSeeded ? 'the soft-mode harness fallback' : 'the wizard'}`
    );
    expect(use.requests, 'chat requests the stub saw for this message').toBeGreaterThan(0);
    expect(use.paths, 'the kernel called the address saved in step 2').toEqual(['/v1/chat/completions']);
    expect(use.models, 'the kernel asked for the model saved in step 2').toContain(STUB_MODEL);
    expect(use.withoutKey, 'chat requests sent without the key saved in step 2').toBe(0);

    // Requirement 12: every new session connects the built-in browser panel's MCP server, so
    // its tools reach the model next to the modeling tools.
    const browserTools = offeredToolNames.filter((name) => /^modelforge[-_]?browser__browser_/.test(name));
    annotate(testInfo, 'browser-tools', browserTools.join(', ') || `none among ${offeredToolNames.length} tools`);
    expect(browserTools, 'built-in browser tools offered to the model').toEqual(
      expect.arrayContaining([
        expect.stringMatching(/__browser_open$/),
        expect.stringMatching(/__browser_read$/),
      ])
    );
  });

  test('Python code runs with exit code 0 and returns its output', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);
    // The expected output is computed by the script, so it appears nowhere in the prompt.
    writeProjectFile(
      projectDir,
      'code/smoke_check.py',
      [
        'import os',
        'import sys',
        '',
        'total = sum(range(1, 101))',
        'print("MFSMOKE_PY_SUM=" + str(total))',
        'print("MFSMOKE_PY_CWD=" + os.getcwd())',
        'print("MFSMOKE_PY_VERSION=" + sys.version.split()[0])',
        '',
      ].join('\n')
    );
    const startedAt = Date.now();
    const nonce = newNonce();
    const directive = toolDirective('run_script', { script: 'code/smoke_check.py' });
    await withProjectApp(c, testInfo, 'python', projectDir, async (app) => {
      await sendChat(app.page, `运行冒烟脚本 code/smoke_check.py。MFSMOKE_NONCE:${nonce} ${directive}`);
      const reply = await waitForToolEcho(app, testInfo, 300_000);
      annotate(testInfo, 'tool-result', reply.slice(0, 600));
      await app.snap('python');
      expect(reply).toContain('MFSMOKE_PY_SUM=5050');
      expect(reply).toMatch(/finished with exit code 0/);
      // The script ran in the Project, whose path has Chinese characters and a space.
      const cwd = /MFSMOKE_PY_CWD=(.+)/.exec(reply)?.[1]?.trim() ?? '';
      expect(path.resolve(cwd).toLowerCase(), 'working directory of the script').toBe(
        path.resolve(projectDir).toLowerCase()
      );
    });
    const record = runRecords(projectDir).find((entry) => entry.codePath === 'code/smoke_check.py');
    expect(record, 'Run_Record of the script').toBeTruthy();
    expect(record?.exitCode).toBe(0);
    expect(record?.failure).toBeNull();
    expect(fs.statSync(record?.file ?? '').mtimeMs).toBeGreaterThanOrEqual(startedAt - 1_000);
    const echoed = (await stubRequests(c, nonce)).some((entry) =>
      (entry.toolResults ?? []).some((result) => result.text.includes('MFSMOKE_PY_SUM=5050'))
    );
    expect(echoed, 'the tool result went back to the model').toBe(true);
  });

  test('paper compilation writes a PDF inside the Project', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);
    const source = writeProjectFile(
      projectDir,
      'paper/main.typ',
      [
        '#set document(title: "ModelForge Windows smoke")',
        '#set page(paper: "a4")',
        '#set text(font: ("Libertinus Serif", "Microsoft YaHei", "SimSun"), lang: "zh")',
        '',
        '= ModelForge Windows smoke paper',
        '',
        'This document was compiled by the installed ModelForge through its modeling extension.',
        '',
        '#lorem(300)',
        '',
        '== 结论',
        '',
        '冒烟测试：论文编译在项目目录中生成 PDF。',
        '',
      ].join('\n')
    );
    const pdf = path.join(projectDir, 'paper', 'main.pdf');
    // Not fs.rmSync: it removes nothing under a path with Chinese characters (harness).
    removeSync(pdf);
    expect(fs.existsSync(pdf), `no PDF from an earlier run at ${pdf}`).toBe(false);
    const startedAt = Date.now();
    const nonce = newNonce();
    // compile_latex resolves `path` against the kernel's cwd, so it gets an absolute path.
    const directive = toolDirective('compile_latex', { path: source, engine: 'typst' });
    await withProjectApp(c, testInfo, 'paper', projectDir, async (app) => {
      await sendChat(app.page, `编译论文 paper/main.typ。MFSMOKE_NONCE:${nonce} ${directive}`);
      const reply = await waitForToolEcho(app, testInfo, 300_000);
      annotate(testInfo, 'tool-result', reply.slice(0, 600));
      await app.snap('paper');
      expect(reply).toContain('Compiled successfully');
    });
    expect(fs.existsSync(pdf), `PDF at ${pdf}`).toBe(true);
    const bytes = fs.readFileSync(pdf);
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1024);
    expect(fs.statSync(pdf).mtimeMs).toBeGreaterThanOrEqual(startedAt - 1_000);
    writeState(c, { paperPdf: pdf });
  });

  test('phase-2 entries open without errors', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);
    // An interrupted task plan, so the startup scan offers to resume it (task 25.5).
    const taskId = `mfsmoke${newNonce()}`;
    const planFile = writeProjectFile(
      projectDir,
      `.modelforge/tasks/${taskId}.json`,
      JSON.stringify(
        {
          schemaVersion: 1,
          taskId,
          title: '冒烟 恢复任务',
          status: '已暂停',
          dismissed: false,
          createdAt: new Date().toISOString().replace('Z', '+00:00'),
          steps: [{ id: 'fit', title: '模型求解', runIds: [] }],
        },
        null,
        2
      )
    );
    try {
      // keepResumePrompt: the start-up clean-up dismisses resume prompts for the other tests,
      // but this one checks the prompt itself.
      await withProjectApp(c, testInfo, 'phase2', projectDir, async (app) => {
        const { page } = app;
        const benign = (text: string) => /ResizeObserver loop/.test(text);
        app.pageErrors.length = 0;

        await test.step('resume prompt', async () => {
          const dialog = page.getByRole('dialog').filter({ hasText: '未完成的任务' });
          await expect(dialog).toBeVisible({ timeout: 60_000 });
          await expect(dialog.getByText('冒烟 恢复任务')).toBeVisible();
          await app.snap('resume-prompt');
          const close = dialog.getByRole('button', { name: '关闭', exact: true }).first();
          if (await close.isVisible().catch(() => false)) {
            await close.click();
          } else {
            await page.keyboard.press('Escape');
          }
          await expect(dialog).toBeHidden({ timeout: 15_000 });
        });

        await test.step('/learning', async () => {
          await page.evaluate(() => {
            window.location.hash = '#/learning';
          });
          await expect(page.getByRole('heading', { level: 1, name: '学习路径' })).toBeVisible({ timeout: 30_000 });
          // The course groups load from the bundled catalogue; a failure renders role="alert".
          await expect(page.locator('section[aria-labelledby^="learning-group-"]').first()).toBeVisible({
            timeout: 30_000,
          });
          await sleep(1_500);
          await expect(page.locator('[role="alert"]:not(.Toastify *)')).toHaveCount(0);
          await app.snap('learning');
          await page.evaluate(() => {
            window.location.hash = '#/';
          });
          await expect(page.locator('[data-testid="chat-input"]').first()).toBeVisible({ timeout: 30_000 });
          await dismissInterruptions(page);
        });

        const openTab = async (label: string) => {
          await page.getByRole('button', { name: label, exact: true }).first().click();
        };

        await test.step('workspace: 论文检查', async () => {
          await openTab('论文检查');
          const panel = page.locator('[data-testid="paper-check-panel"]');
          await expect(panel).toBeVisible({ timeout: 30_000 });
          await sleep(1_500);
          await expect(panel.locator('[role="alert"]')).toHaveCount(0);
          await app.snap('tab-paper-check');
        });

        await test.step('workspace: 方案对比', async () => {
          await openTab('方案对比');
          const panel = page.locator('[data-testid="run-compare-panel"]');
          await expect(panel).toBeVisible({ timeout: 30_000 });
          await sleep(3_000);
          await expect(panel.locator('[role="alert"]')).toHaveCount(0);
          await app.snap('tab-run-compare');
        });

        await test.step('workspace: 模拟评审', async () => {
          await openTab('模拟评审');
          const panel = page.locator('[data-testid="review-panel"]');
          await expect(panel).toBeVisible({ timeout: 30_000 });
          await expect(panel.locator('[data-testid="review-disclaimer"]')).toBeVisible();
          await sleep(1_500);
          await expect(panel.locator('[role="alert"]')).toHaveCount(0);
          await app.snap('tab-review');
        });

        await test.step('workspace: 环境', async () => {
          await openTab('环境');
          await expect(page.getByRole('button', { name: '重新检测' }).first()).toBeVisible({ timeout: 30_000 });
          await expect(page.getByText('正在检测环境…')).toHaveCount(0, { timeout: 60_000 });
          await expect(page.getByText('环境检测失败')).toHaveCount(0);
          // Python and Typst are installed, so no missing-runtime hint may show (7.7, 13.4).
          await expect(page.getByText(/^未找到 .+。$/)).toHaveCount(0);
          await app.snap('tab-environment');
        });

        const errors = app.pageErrors.filter((text) => !benign(text));
        expect(errors, 'uncaught renderer errors while opening the entries').toEqual([]);
      }, { keepResumePrompt: true });
    } finally {
      // Gone for the later launches, so they are not offered this task to resume.
      removeSync(planFile);
    }
  });

  test('phase-1 entries open: diagnostics, competitions, examples, datasets, gallery, collaboration, browser, auto snapshots, Feishu', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    // Task 20 (phase-1 acceptance) on the installed app; the other scenarios cover the flows.
    test.skip(c.scenario !== 'primary', 'the phase-1 entry check runs in the primary scenario');
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);
    await withProjectApp(c, testInfo, 'phase1', projectDir, async (app) => {
      const { page } = app;
      const benign = (text: string) => /ResizeObserver loop/.test(text);
      app.pageErrors.length = 0;
      // Error banners of a page; react-toastify renders its own role="alert" container.
      const alerts = () => page.locator('[role="alert"]:not(.Toastify *)');
      const h1 = (name: string) => page.getByRole('heading', { level: 1, name, exact: true });
      const h2 = (name: string) => page.getByRole('heading', { level: 2, name, exact: true });

      // A sidebar row is a button holding an icon and a span with its label (NavigationPanel.tsx
      // NavRow / NavSubRow / NavGroupRow); other buttons can carry the same text (the Hub's
      // "赛事" picker), so the row is found by that span.
      const navRow = (label: string) =>
        page
          .locator('button')
          .filter({
            has: page.locator('span.text-left.flex-1.truncate', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }),
          })
          .first();
      const openFromSidebar = async (label: string, route: string) => {
        const row = navRow(label);
        if (!(await row.isVisible().catch(() => false))) {
          // The sidebar folds away on a narrow window; open it again as a user would.
          const reopen = page.getByRole('button', { name: '展开导航', exact: true }).first();
          if (await reopen.isVisible().catch(() => false)) {
            await reopen.click();
          }
        }
        await expect(row, `sidebar entry "${label}"`).toBeVisible({ timeout: 15_000 });
        await row.click();
        await expect
          .poll(() => page.evaluate(() => window.location.hash), { message: `"${label}" opens #${route}`, timeout: 15_000 })
          .toBe(`#${route}`);
      };
      const home = async () => {
        await page.evaluate(() => {
          window.location.hash = '#/';
        });
        await expect(page.locator('[data-testid="chat-input"]').first()).toBeVisible({ timeout: 30_000 });
        await dismissInterruptions(page);
      };
      const openTab = async (label: string) => {
        const tab = page.getByRole('button', { name: label, exact: true }).first();
        await tab.click();
        await expect(tab, `workspace tab "${label}" is the open one`).toHaveAttribute('aria-pressed', 'true');
      };

      await test.step('workspace: 浏览器', async () => {
        await openTab('浏览器');
        await expect(page.getByPlaceholder('搜索或输入网址')).toBeVisible({ timeout: 30_000 });
        await sleep(1_500);
        await expect(alerts().filter({ hasText: /无法加载页面|URL 协议不受支持/ })).toHaveCount(0);
        await app.snap('tab-browser');
      });

      await test.step('workspace: 版本 › 自动快照', async () => {
        await openTab('版本');
        await page.getByRole('button', { name: '自动快照', exact: true }).click();
        // Before the list arrives and when there is none the tab shows its empty text; with
        // snapshots it shows the hint above the list. An error (no git) shows neither.
        const listed = page
          .getByText('还没有自动快照。智能体写入文件前会自动创建快照。', { exact: true })
          .or(page.getByText('选择两个快照进行对比，或选择一个进行恢复。', { exact: true }));
        await expect(listed).toBeVisible({ timeout: 30_000 });
        await sleep(2_000);
        await expect(listed).toBeVisible();
        await expect(page.getByText('Git 不可用，无法创建快照。', { exact: true })).toHaveCount(0);
        await app.snap('tab-auto-snapshots');
      });

      await test.step('诊断中心', async () => {
        await openFromSidebar('诊断中心', '/diagnostics');
        await expect(h1('诊断中心')).toBeVisible({ timeout: 30_000 });
        // Auto snapshots run the MinGit that ships with the app (requirement 11.2).
        const git = page.locator('section').filter({ has: h2('自动快照使用的 git') });
        await expect(git).toContainText('随包 MinGit', { timeout: 30_000 });
        await expect(git.locator('.text-red-600')).toHaveCount(0);
        // The installed kernel is traceable to its build manifest.
        const provenance = page.locator('section').filter({ has: h2('构建来源') });
        await expect(provenance).toContainText('commit：', { timeout: 30_000 });
        await expect(provenance.locator('.text-red-600')).toHaveCount(0);
        const packageSha = process.env.MODELFORGE_SMOKE_PACKAGE_SHA ?? '';
        if (packageSha) {
          await expect(provenance, 'the build manifest names the packaged commit').toContainText(packageSha.slice(0, 9));
        }
        annotate(testInfo, 'diagnostics', (await provenance.innerText()).replace(/\s+/g, ' ').slice(0, 300));
        await app.snap('entry-diagnostics');
      });

      await test.step('赛事', async () => {
        await openFromSidebar('赛事', '/competitions');
        await expect(h1('数学建模赛事')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText(/^数据更新日期：/)).toBeVisible();
        // The first competition is selected and its preparation can start.
        await expect(page.getByRole('button', { name: '开始备赛', exact: true })).toBeVisible();
        await expect(alerts()).toHaveCount(0);
        await app.snap('entry-competitions');
      });

      await test.step('示例题库', async () => {
        await openFromSidebar('示例题', '/examples');
        await expect(h1('示例题库')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByText('加载中…', { exact: true })).toHaveCount(0, { timeout: 30_000 });
        await expect(page.getByText('暂无可用示例题', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '参考思路', exact: true })).toBeVisible();
        await app.snap('entry-examples');
      });

      await test.step('数据集', async () => {
        await openFromSidebar('数据集', '/datasets');
        await expect(h1('数据集')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: '生成数据说明', exact: true })).toBeVisible();
        await sleep(1_500);
        await expect(alerts()).toHaveCount(0);
        await app.snap('entry-datasets');
      });

      await test.step('作品广场', async () => {
        await openFromSidebar('作品广场', '/gallery');
        await expect(h1('作品广场')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('button', { name: '导入', exact: true })).toBeVisible();
        await expect(page.getByRole('button', { name: '刷新', exact: true }).first()).toBeVisible();
        await sleep(1_500);
        await expect(alerts()).toHaveCount(0);
        await app.snap('entry-gallery');
      });

      await test.step('加入协作', async () => {
        await openFromSidebar('加入协作', '/collab');
        await expect(h1('加入协作')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByLabel('邀请码')).toBeVisible();
        await expect(page.getByLabel('显示名')).toBeVisible();
        // Nothing to join with yet: the button waits for an invitation code and a name.
        await expect(page.getByRole('button', { name: '加入', exact: true })).toBeDisabled();
        await expect(alerts()).toHaveCount(0);
        await app.snap('entry-collab');
      });

      await test.step('连接器 › 飞书', async () => {
        const group = navRow('扩展');
        await expect(group, 'sidebar group "扩展"').toBeVisible({ timeout: 15_000 });
        if ((await group.getAttribute('aria-expanded')) !== 'true') {
          await group.click();
        }
        await openFromSidebar('连接器', '/connectors');
        await expect(h1('连接器')).toBeVisible({ timeout: 30_000 });
        await expect(h2('飞书')).toBeVisible({ timeout: 30_000 });
        // A clean profile: the bot is off and its whitelist is empty.
        const enabled = page.getByRole('checkbox', { name: '启用飞书机器人', exact: true });
        await expect(enabled).toBeVisible();
        await expect(enabled).not.toBeChecked();
        await expect(page.getByText('白名单为空，不会响应任何账号', { exact: true })).toBeVisible();
        await expect(alerts()).toHaveCount(0);
        await app.snap('entry-connectors-feishu');
      });

      await home();
      const errors = app.pageErrors.filter((text) => !benign(text));
      expect(errors, 'uncaught renderer errors while opening the entries').toEqual([]);
    });
  });

  test('paper check runs read-only in its utility process and reads the PDF with pdfjs', async ({}, testInfo) => {
    const c = cfg as SmokeConfig;
    if (!WIZARD_STRICT) {
      ensureKernelSeeded(c, testInfo);
    }
    const projectDir = ensureProject(c, testInfo);
    const pdf = readState(c).paperPdf ?? path.join(projectDir, 'paper', 'main.pdf');
    test.skip(!fs.existsSync(pdf), `no compiled paper at ${pdf} (the paper compilation test failed)`);

    const ignored = (file: string) => file.startsWith('.modelforge/') || file.startsWith('.git/');
    const before = Object.fromEntries(Object.entries(hashTree(projectDir)).filter(([file]) => !ignored(file)));
    await withProjectApp(c, testInfo, 'paper-check', projectDir, async (app) => {
      // The same IPC the panel's "开始检查" button calls, with the anonymity terms so the PDF
      // text layer is read by pdfjs inside the utility process.
      const result = await app.page.evaluate(
        (dir: string) =>
          (
            window as unknown as {
              electron: { paperCheckRun: (request: unknown) => Promise<unknown> };
            }
          ).electron.paperCheckRun({
            projectDir: dir,
            paperPath: 'paper/main.typ',
            online: false,
            anonymity: { names: ['MFSMOKE甲'], school: 'MFSMOKE大学', team: 'MFSMOKE队' },
          }),
        projectDir
      );
      const report = result as {
        ok: boolean;
        error?: { code?: string; message?: string };
        data?: { items: { id: string; verdict: string; issues: { code: string }[]; reason?: string }[] };
      };
      annotate(testInfo, 'paper-check', JSON.stringify(report).slice(0, 1_500));
      expect(report.ok, `paper check failed: ${JSON.stringify(report.error)}`).toBe(true);
      const items = report.data?.items ?? [];
      const byId = (id: string) => items.find((entry) => entry.id === id);
      expect(byId('pdf-freshness'), 'pdf-freshness item').toBeTruthy();
      expect(byId('pdf-freshness')?.issues.map((issue) => issue.code)).not.toContain('pdf-missing');
      const anonymity = byId('anonymity');
      expect(anonymity, 'anonymity item (reads the PDF text layer)').toBeTruthy();
      expect(anonymity?.issues.map((issue) => issue.code), 'pdfjs read the PDF').not.toContain('pdf-unreadable');
      expect(anonymity?.reason, 'anonymity check ran').not.toBe('check-failed');
    });
    const after = Object.fromEntries(Object.entries(hashTree(projectDir)).filter(([file]) => !ignored(file)));
    expect(after, 'the paper check wrote nothing into the Project').toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------------------------

/** Result of scripts/Select-FolderInDialog.ps1. */
interface FolderDialogResult {
  ok: boolean;
  /** picked | no-dialog | no-folder-box | message-box | still-open | uia-unavailable | error */
  outcome: string;
  dialog: { title: string; buttons: string; process: string; pid: number } | null;
  /** ValuePattern or WM_SETTEXT */
  textMethod: string;
  presses: number;
  editBoxes: string[];
  messageText: string;
  cancelled: boolean;
  screenshots: string[];
  error: string | null;
}

/** Select-FolderInDialog.ps1: no folder dialog appeared, or UI Automation is unavailable. */
const EXIT_NO_FOLDER_DIALOG = 3;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `child` lies inside `parent` (Windows paths, any letter case). */
function isInsideDir(child: string, parent: string): boolean {
  const base = path.resolve(parent).toLowerCase() + path.sep;
  return path.resolve(child).toLowerCase().startsWith(base);
}

async function clickNext(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: '下一步', exact: true });
  await expect(next).toBeEnabled({ timeout: 30_000 });
  await next.click();
}

/** Resolves with the key of the first locator that becomes visible, or 'timeout'. */
async function firstVisible(
  page: Page,
  timeoutMs: number,
  candidates: Record<string, Locator>
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const [key, locator] of Object.entries(candidates)) {
      if (await locator.first().isVisible().catch(() => false)) {
        return key;
      }
    }
    await sleep(250);
  }
  return 'timeout';
}

/**
 * Launches the app (on the wizard's configuration; in soft mode on the harness fallback when
 * `ensureKernelSeeded` needed it) and checks that the window opened on the Project: the app
 * reopens the most recent folder, which the wizard (or `ensureProject`) set.
 */
async function withProjectApp(
  c: SmokeConfig,
  testInfo: TestInfo,
  label: string,
  projectDir: string,
  body: (app: LaunchedApp) => Promise<void>,
  dismiss: DismissOptions = {}
): Promise<void> {
  await withApp(c, testInfo, label, { env: kernelEnv(c) }, async (app) => {
    const shell = await waitForShell(app.page, 90_000, 'main');
    expect(shell, 'main window').toBe('main');
    await dismissInterruptions(app.page, dismiss);
    const workingDir = await app.page.evaluate(() =>
      String((window as unknown as { appConfig: { get: (key: string) => unknown } }).appConfig.get('GOOSE_WORKING_DIR') ?? '')
    );
    expect(path.resolve(workingDir).toLowerCase(), 'the window opened on the Project').toBe(
      path.resolve(projectDir).toLowerCase()
    );
    await body(app);
  });
}

function waitForReply(app: LaunchedApp, testInfo: TestInfo, pattern: RegExp, timeoutMs: number): Promise<string> {
  return waitForAssistant(app.page, testInfo, pattern, timeoutMs);
}

/** Waits for the stub's echo of a tool result (or its tool-missing notice) and returns it. */
async function waitForToolEcho(app: LaunchedApp, testInfo: TestInfo, timeoutMs: number): Promise<string> {
  const text = await waitForReply(app, testInfo, /MFSMOKE_TOOL_(RESULT|MISSING|ERROR)/, timeoutMs);
  if (/MFSMOKE_TOOL_(MISSING|ERROR)/.test(text)) {
    throw new Error(`the scripted tool call could not be made: ${text.slice(0, 2_000)}`);
  }
  // The echo is one SSE chunk, but give the renderer a moment to finish the markdown.
  await sleep(1_000);
  const messages = await app.page.locator('[data-testid="message-container"].assistant').allInnerTexts();
  return messages.find((message) => message.includes('MFSMOKE_TOOL_RESULT')) ?? text;
}

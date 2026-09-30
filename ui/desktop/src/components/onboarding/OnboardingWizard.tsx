import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import {
  initialWizardState,
  isKeySubmittable,
  next,
  openAt,
  prev,
  skip,
  stepIndex,
  ONBOARDING_STEPS,
  type WizardState,
} from './wizardMachine';
import type { OnboardingState, OnboardingStepId } from '../../utils/settings';
import {
  acpListProviderDetails,
  acpSaveDefaults,
  acpSaveProviderConfig,
} from '../../acp/providers';
import type { ProviderDetails } from '../../types/providers';
import {
  classifyProviderError,
  PROVIDER_ERROR_LABELS,
  type ProviderConnectionResult,
  type ProviderErrorClass,
} from '../../utils/providerConnectivity';
import type { LocalRuntimeDetection } from '../../utils/runtimeDetection';
import type { ExampleEntry } from '../../types/catalog';
import { requestOpenProject } from '../../utils/pendingProject';
import { useModelAndProvider } from '../ModelAndProviderContext';
import { defineMessages, useIntl } from '../../i18n';
import {
  canConfigureInWizard,
  endpointField,
  initialProviderInput,
  modelSuggestions,
  normalizeAddress,
  saveWizardProvider,
  type WizardSaveResult,
} from './wizardProviderSetup';

const i18n = defineMessages({
  wizardAddressTestOnly: {
    id: 'onboardingGuard.wizardAddressTestOnly',
    defaultMessage:
      'Only used for the connection test; the built-in kernel keeps the address this provider comes with.',
  },
  wizardKeySaveFailed: {
    id: 'onboardingGuard.wizardKeySaveFailed',
    defaultMessage: 'Could not save the key: {reason}',
  },
  wizardModelHint: {
    id: 'onboardingGuard.wizardModelHint',
    defaultMessage:
      "Starts with the provider's recommended model; enter another model name if your endpoint serves a different one.",
  },
  wizardModelLabel: {
    id: 'onboardingGuard.wizardModelLabel',
    defaultMessage: 'Model',
  },
  wizardProviderSaveFailed: {
    id: 'onboardingGuard.wizardProviderSaveFailed',
    defaultMessage:
      'The connection works, but the built-in kernel could not save this provider: {reason}',
  },
  wizardSaving: {
    id: 'onboardingGuard.wizardSaving',
    defaultMessage: 'Saving…',
  },
});

type ProviderChoice =
  | { kind: 'provider'; id: string; label: string }
  | { kind: 'acp'; id: 'claude-code' | 'codex'; label: string };

type TestState = 'idle' | 'testing' | 'saving' | 'success' | 'failure';

interface EnvironmentResult {
  python: 'available' | 'missing' | 'timeout';
  pythonVersion: string;
  typesetting: 'available' | 'missing' | 'timeout';
  typesettingVersion: string;
}

const STEP_NAMES: Record<OnboardingStepId, string> = {
  provider: '选择供应商',
  key: '填写密钥',
  environment: '检测环境',
  example: '打开示例题',
};

interface OnboardingWizardProps {
  /** Step the diagnostics centre opens directly (requirement 5.4). */
  initialStep?: OnboardingStepId;
  onComplete: () => void;
}

export default function OnboardingWizard({ initialStep, onComplete }: OnboardingWizardProps) {
  const intl = useIntl();
  const { refreshCurrentModelAndProvider } = useModelAndProvider();
  const [state, setState] = useState<WizardState>(() => initialWizardState());
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [runtimes, setRuntimes] = useState<LocalRuntimeDetection[]>([]);
  const [selected, setSelected] = useState<ProviderChoice | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState<ProviderErrorClass | null>(null);
  const [acpConfirmed, setAcpConfirmed] = useState(false);
  const [environment, setEnvironment] = useState<EnvironmentResult | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [examples, setExamples] = useState<ExampleEntry[] | null>(null);
  const [exampleId, setExampleId] = useState<string | null>(null);
  const [exampleParent, setExampleParent] = useState('');
  const [creatingExample, setCreatingExample] = useState(false);

  useEffect(() => {
    window.electron
      .getSetting('onboarding')
      .then((value) => {
        const persisted = value as OnboardingState | undefined;
        setState(openAt(initialWizardState(persisted), initialStep ?? 'provider'));
      })
      .catch(() => setState(openAt(initialWizardState(), initialStep ?? 'provider')))
      .finally(() => setReady(true));
  }, [initialStep]);

  useEffect(() => {
    let cancelled = false;
    acpListProviderDetails()
      .then((list) => {
        if (!cancelled) {
          // Step 2 configures a provider with an API key and an address only; the rest are
          // set up from the settings page (their own sign-in, or more required settings).
          setProviders(
            list.filter((provider) => provider.visible_in_setup && canConfigureInWizard(provider))
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setProviders([]);
        }
      });
    (async () => {
      try {
        const detected = await window.electron.detectLocalRuntimes();
        if (!cancelled) {
          setRuntimes(detected);
        }
      } catch {
        if (!cancelled) {
          setRuntimes([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = (nextState: WizardState) => {
    setState(nextState);
    const onboarding: OnboardingState = { completed: nextState.completed, steps: nextState.steps };
    window.electron
      .setSetting('onboarding', onboarding)
      .then(() => {
        if (nextState.completed) {
          onComplete();
        }
      })
      .catch(() => {
        if (nextState.completed) {
          onComplete();
        }
      });
  };

  const handleNext = () => persist(next(state));

  const handleSkip = () => persist(skip(state));

  const handlePrev = () => setState(prev(state));

  const selectedProviderId = selected?.kind === 'provider' ? selected.id : null;
  const selectedProvider =
    providers.find((provider) => provider.name === selectedProviderId) ?? null;

  const selectProvider = (choice: ProviderChoice) => {
    setSelected(choice);
    const details =
      choice.kind === 'provider' ? providers.find((provider) => provider.name === choice.id) : null;
    const initial = details ? initialProviderInput(details) : { address: '', model: '' };
    setBaseUrl(initial.address);
    setModel(initial.model);
    setKey('');
    setTestState('idle');
    setTestError(null);
    setAcpConfirmed(false);
    setStepError(null);
  };

  const saveFailureMessage = (result: Exclude<WizardSaveResult, { ok: true }>): string => {
    switch (result.failure) {
      case 'secure-storage-unavailable':
        return '安全存储不可用，密钥仅在本次会话内有效';
      case 'credential-store':
        return intl.formatMessage(i18n.wizardKeySaveFailed, { reason: result.reason });
      case 'kernel':
        return intl.formatMessage(i18n.wizardProviderSaveFailed, { reason: result.reason });
    }
  };

  // One connectivity request (requirement 5.2), then the same save path as the settings page
  // (see wizardProviderSetup.ts). Any failure keeps the provider and the inputs on this step so
  // the user can retry or skip (requirement 5.3).
  const testConnection = async () => {
    if (!selectedProvider) {
      return;
    }
    const trimmedKey = key.trim();
    setTestState('testing');
    setTestError(null);
    setStepError(null);

    let result: ProviderConnectionResult;
    try {
      result = await window.electron.testProviderConnection(
        { baseUrl: normalizeAddress(baseUrl) },
        trimmedKey
      );
    } catch (error) {
      setTestError(classifyProviderError(null, '', error));
      setTestState('failure');
      return;
    }
    if (!result.ok) {
      setTestError(
        classifyProviderError(result.failure.status, result.failure.body, result.failure.cause)
      );
      setTestState('failure');
      return;
    }

    setTestState('saving');
    const saved = await saveWizardProvider(
      selectedProvider,
      { address: baseUrl, key: trimmedKey, model },
      {
        rememberKey: (providerId, value) =>
          window.electron.rememberProviderApiKey(providerId, value),
        saveProviderConfig: acpSaveProviderConfig,
        saveDefaults: acpSaveDefaults,
      }
    );
    if (!saved.ok) {
      setStepError(saveFailureMessage(saved));
      setTestState('failure');
      return;
    }
    // The chat view reads the default provider and model from this context.
    await refreshCurrentModelAndProvider();
    setTestState('success');
  };

  const confirmAcp = () => {
    setAcpConfirmed(true);
    setStepError(null);
    persist(next(state));
  };

  // 单独取出当前步骤：react-hooks 规则把 `state.current` 当作 ref 读取，不接受它作依赖
  const currentStep = state.current;

  useEffect(() => {
    if (currentStep !== 'environment' || environment) {
      return;
    }
    const timer = setTimeout(
      () =>
        setEnvironment({
          python: 'timeout',
          pythonVersion: '',
          typesetting: 'timeout',
          typesettingVersion: '',
        }),
      30_000
    );
    (async () => {
      try {
        const probes = await window.electron.workspaceProbeEnvironment();
        const python = probes.find((probe) => probe.id === 'python');
        const typesettingProbes = probes.filter((probe) =>
          ['latexmk', 'xelatex', 'typst'].includes(probe.id)
        );
        const typesetting = typesettingProbes.find((probe) => probe.available);
        // A tool that was found but answered too late is not reported as missing.
        setEnvironment({
          python: python?.available
            ? 'available'
            : python?.status === 'timeout'
              ? 'timeout'
              : 'missing',
          pythonVersion: python?.version ?? '',
          typesetting: typesetting
            ? 'available'
            : typesettingProbes.some((probe) => probe.status === 'timeout')
              ? 'timeout'
              : 'missing',
          typesettingVersion: typesetting?.version ?? '',
        });
      } catch {
        setEnvironment({
          python: 'missing',
          pythonVersion: '',
          typesetting: 'missing',
          typesettingVersion: '',
        });
      } finally {
        clearTimeout(timer);
      }
    })();
    return () => clearTimeout(timer);
  }, [currentStep, environment]);

  // Step 4 lists only examples whose statement and attachments are available locally.
  useEffect(() => {
    if (currentStep !== 'example' || examples !== null) {
      return;
    }
    let cancelled = false;
    window.electron
      .examplesList()
      .then((list) => {
        if (cancelled) return;
        const local = list.filter((entry) => !entry.needsDownload);
        setExamples(local);
        setExampleId((current) => current ?? local[0]?.manifest.id ?? null);
      })
      .catch(() => {
        if (!cancelled) setExamples([]);
      });
    return () => {
      cancelled = true;
    };
  }, [currentStep, examples]);

  const chooseExampleParent = async () => {
    const result = await window.electron.directoryChooser();
    if (!result.canceled && result.filePaths[0]) {
      setExampleParent(result.filePaths[0]);
    }
  };

  // Creates the Project, hands it to the home view and finishes the wizard, so the chat page
  // opens on the new Project (requirement 5.1 step 4).
  const createExampleProject = async () => {
    const entry = examples?.find((candidate) => candidate.manifest.id === exampleId);
    if (!entry || !exampleParent) {
      return;
    }
    setCreatingExample(true);
    setStepError(null);
    try {
      const result = await window.electron.projectCreateFromExample({
        exampleId: entry.manifest.id,
        name: entry.manifest.title,
        parentDir: exampleParent,
      });
      if (!result.ok) {
        setStepError(result.error.message);
        return;
      }
      await window.electron.addRecentDir(result.data.projectDir);
      requestOpenProject(result.data.projectDir);
      persist(next(state));
    } catch (error) {
      setStepError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingExample(false);
    }
  };

  const index = stepIndex(state.current);
  const canNext =
    state.current === 'provider'
      ? selected !== null
      : state.current === 'key'
        ? selected?.kind === 'acp'
          ? acpConfirmed
          : testState === 'success'
        : true;

  const runtimeChoices: ProviderChoice[] = runtimes
    .filter((runtime) => runtime.available)
    .map((runtime) =>
      runtime.id === 'claude-code'
        ? { kind: 'acp', id: 'claude-code' as const, label: 'Claude Code（通过 ACP 接入本机运行时）' }
        : { kind: 'acp', id: 'codex' as const, label: 'Codex（通过 ACP 接入本机运行时）' }
    );

  const providerChoices: ProviderChoice[] = providers.map((provider) => ({
    kind: 'provider',
    id: provider.name,
    label: provider.metadata.display_name,
  }));

  if (!ready) {
    return null;
  }

  return (
    <div className="flex h-screen w-full flex-col items-center justify-center bg-background-default p-4">
      <div className="w-full max-w-xl">
        <p className="mb-6 text-text-muted">
          第 {index + 1} 步/共 {ONBOARDING_STEPS.length} 步 · {STEP_NAMES[state.current]}
        </p>

        {state.current === 'provider' && (
          <div className="space-y-2">
            <div className="grid gap-2">
              {[...providerChoices, ...runtimeChoices].map((choice) => (
                <button
                  key={`${choice.kind}:${choice.id}`}
                  onClick={() => selectProvider(choice)}
                  className={`rounded-lg border p-3 text-left ${
                    selected?.kind === choice.kind && selected?.id === choice.id
                      ? 'border-blue-400 bg-background-muted'
                      : 'border-border-default hover:border-blue-400'
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
            {[...providerChoices, ...runtimeChoices].length === 0 && (
              <p className="text-sm text-text-muted">未检测到可用的模型供应商或本机运行时。</p>
            )}
          </div>
        )}

        {state.current === 'key' && selected?.kind === 'acp' && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              已选择 {selected.label}。确认授权后即可通过 ACP 接入该运行时，无需填写 API 密钥。
            </p>
            <Button onClick={confirmAcp} disabled={acpConfirmed}>
              {acpConfirmed ? '已确认' : '确认接入'}
            </Button>
          </div>
        )}

        {state.current === 'key' && selectedProvider && (
          <div className="space-y-3">
            <div>
              <label htmlFor="onboarding-address" className="mb-1 block text-sm">
                API 地址
              </label>
              <input
                id="onboarding-address"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="w-full rounded border border-border-default bg-background-default p-2"
                placeholder="https://api.example.com/v1"
              />
              {!endpointField(selectedProvider) && (
                <p className="mt-1 text-xs text-text-muted">
                  {intl.formatMessage(i18n.wizardAddressTestOnly)}
                </p>
              )}
            </div>
            <div>
              <label htmlFor="onboarding-key" className="mb-1 block text-sm">
                API Key
              </label>
              <input
                id="onboarding-key"
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="w-full rounded border border-border-default bg-background-default p-2"
              />
            </div>
            <div>
              <label htmlFor="onboarding-model" className="mb-1 block text-sm">
                {intl.formatMessage(i18n.wizardModelLabel)}
              </label>
              <input
                id="onboarding-model"
                list="onboarding-model-options"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                className="w-full rounded border border-border-default bg-background-default p-2"
                aria-describedby="onboarding-model-hint"
              />
              <datalist id="onboarding-model-options">
                {modelSuggestions(selectedProvider).map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
              <p id="onboarding-model-hint" className="mt-1 text-xs text-text-muted">
                {intl.formatMessage(i18n.wizardModelHint)}
              </p>
            </div>
            {testState === 'success' && <p className="text-sm text-green-600">连接成功</p>}
            {testState === 'failure' && !stepError && (
              <p className="text-sm text-red-600">
                {testError ? PROVIDER_ERROR_LABELS[testError] : '连接失败'}
              </p>
            )}
            {stepError && (
              <p className="text-sm text-red-600" role="alert">
                {stepError}
              </p>
            )}
            <Button
              onClick={() => void testConnection()}
              disabled={
                testState === 'testing' ||
                testState === 'saving' ||
                !isKeySubmittable(key) ||
                !baseUrl.trim() ||
                !model.trim()
              }
            >
              {testState === 'testing'
                ? '连接测试中…'
                : testState === 'saving'
                  ? intl.formatMessage(i18n.wizardSaving)
                  : '测试连接'}
            </Button>
          </div>
        )}

        {state.current === 'environment' && (
          <div className="space-y-3 text-sm">
            {environment ? (
              <>
                <div>
                  Python：
                  {environment.python === 'available'
                    ? `可用（${environment.pythonVersion}）`
                    : environment.python === 'timeout'
                      ? '检测超时'
                      : '未找到'}
                </div>
                <div>
                  论文编译环境：
                  {environment.typesetting === 'available'
                    ? `可用（${environment.typesettingVersion}）`
                    : environment.typesetting === 'timeout'
                      ? '检测超时'
                      : '未找到'}
                </div>
              </>
            ) : (
              <p className="text-text-muted">正在检测 Python 与论文编译环境…</p>
            )}
          </div>
        )}

        {state.current === 'example' && (
          <div className="space-y-3 text-sm text-text-secondary">
            <p>
              选择一道示例题，ModelForge 会在所选位置创建项目并直接打开。也可以点“完成”，稍后再从示例题库开始。
            </p>
            {examples === null ? (
              <p className="text-text-muted">正在读取示例题…</p>
            ) : examples.length === 0 ? (
              <p className="text-text-muted">暂无可直接打开的示例题，可稍后在示例题库中查看下载指引。</p>
            ) : (
              <div className="grid gap-2" role="radiogroup" aria-label="示例题">
                {examples.map((entry) => (
                  <label
                    key={entry.manifest.id}
                    className="flex cursor-pointer items-center gap-2 rounded border border-border-default px-3 py-2"
                  >
                    <input
                      type="radio"
                      name="onboarding-example"
                      checked={exampleId === entry.manifest.id}
                      onChange={() => setExampleId(entry.manifest.id)}
                    />
                    <span className="text-text-primary">{entry.manifest.title}</span>
                    <span className="text-xs text-text-muted">{entry.manifest.category}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate rounded border border-border-default px-2 py-1.5 text-xs">
                {exampleParent || '尚未选择保存位置'}
              </span>
              <Button variant="outline" onClick={() => void chooseExampleParent()}>
                选择保存位置
              </Button>
            </div>
            {stepError && <p className="text-sm text-red-600">{stepError}</p>}
            <Button
              onClick={() => void createExampleProject()}
              disabled={!exampleId || !exampleParent || creatingExample}
            >
              {creatingExample ? '正在创建…' : '创建并打开'}
            </Button>
          </div>
        )}

        <div className="mt-8 flex justify-between">
          <Button variant="outline" onClick={handlePrev} disabled={index === 0}>
            上一步
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={handleSkip}>
              跳过
            </Button>
            <Button onClick={handleNext} disabled={!canNext}>
              {state.current === 'example' ? '完成' : '下一步'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

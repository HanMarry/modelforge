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
import { acpListProviderDetails, acpSaveDefaults } from '../../acp/providers';
import type { ProviderDetails } from '../../types/providers';
import {
  classifyProviderError,
  PROVIDER_ERROR_LABELS,
  type ProviderErrorClass,
} from '../../utils/providerConnectivity';
import type { LocalRuntimeDetection } from '../../utils/runtimeDetection';

type ProviderChoice =
  | { kind: 'provider'; id: string; label: string }
  | { kind: 'acp'; id: 'claude-code' | 'codex'; label: string };

type TestState = 'idle' | 'testing' | 'success' | 'failure';

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
  const [state, setState] = useState<WizardState>(() => initialWizardState());
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState<ProviderDetails[]>([]);
  const [runtimes, setRuntimes] = useState<LocalRuntimeDetection[]>([]);
  const [selected, setSelected] = useState<ProviderChoice | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [testState, setTestState] = useState<TestState>('idle');
  const [testError, setTestError] = useState<ProviderErrorClass | null>(null);
  const [acpConfirmed, setAcpConfirmed] = useState(false);
  const [environment, setEnvironment] = useState<EnvironmentResult | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

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
          setProviders(list.filter((provider) => provider.visible_in_setup));
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

  const selectProvider = (choice: ProviderChoice) => {
    setSelected(choice);
    setBaseUrl('');
    setKey('');
    setTestState('idle');
    setTestError(null);
    setAcpConfirmed(false);
    setStepError(null);
  };

  const testConnection = async () => {
    setTestState('testing');
    setTestError(null);
    setStepError(null);
    try {
      const result = await window.electron.testProviderConnection({ baseUrl }, key);
      if (result.ok) {
        setTestState('success');
        if (selected?.kind === 'provider') {
          const saved = await window.electron.rememberProviderApiKey(selected.id, key);
          if (saved.ok && saved.data.outcome === 'encrypted') {
            await acpSaveDefaults(selected.id);
          } else if (saved.ok && saved.data.outcome === 'memory-only') {
            setStepError('安全存储不可用，密钥仅在本次会话内有效');
            setTestState('failure');
            return;
          } else {
            setStepError('密钥保存失败');
            setTestState('failure');
            return;
          }
        }
      } else {
        setTestError(
          classifyProviderError(result.failure.status, result.failure.body, result.failure.cause)
        );
        setTestState('failure');
      }
    } catch (error) {
      setTestError(classifyProviderError(null, '', error));
      setTestState('failure');
    }
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
        const typesetting = probes.find(
          (probe) => ['latexmk', 'xelatex', 'typst'].includes(probe.id) && probe.available
        );
        setEnvironment({
          python: python?.available ? 'available' : 'missing',
          pythonVersion: python?.version ?? '',
          typesetting: typesetting ? 'available' : 'missing',
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

        {state.current === 'key' && selected?.kind === 'provider' && (
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-sm">API 地址</label>
              <input
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                className="w-full rounded border border-border-default bg-background-default p-2"
                placeholder="https://api.example.com/v1"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm">API Key</label>
              <input
                type="password"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                className="w-full rounded border border-border-default bg-background-default p-2"
              />
            </div>
            {testState === 'success' && <p className="text-sm text-green-600">连接成功</p>}
            {testState === 'failure' && (
              <p className="text-sm text-red-600">
                {testError ? PROVIDER_ERROR_LABELS[testError] : '连接失败'}
              </p>
            )}
            {stepError && <p className="text-sm text-red-600">{stepError}</p>}
            <Button
              onClick={testConnection}
              disabled={testState === 'testing' || !isKeySubmittable(key) || !baseUrl.trim()}
            >
              {testState === 'testing' ? '连接测试中…' : '测试连接'}
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
            <p>示例题库将在后续版本提供。你可以现在就完成配置，稍后再从示例题库开始备赛。</p>
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

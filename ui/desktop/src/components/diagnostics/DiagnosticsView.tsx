import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../ui/button';
import {
  DIAGNOSTIC_CATEGORIES,
  UNKNOWN_VERSION,
  type CategoryResult,
  type DiagnosticCategory,
  type DiagnosticReport,
  type KernelProvenance,
} from '../../utils/diagnostics/diagnosticsService';
import { OPTIONAL_RUNTIMES } from '../../utils/diagnostics/optionalRuntimes';
import type { OnboardingState, OnboardingStepId } from '../../utils/settings';
import type { CheckpointGitSource } from '../../utils/checkpoints/checkpointIpc';
import {
  CredentialMigrationNotice,
  useCredentialMigrationFailures,
} from '../settings/providers/CredentialMigrationNotice';

const CATEGORY_LABELS: Record<DiagnosticCategory, string> = {
  provider: '模型供应商',
  runtime: '智能体运行时',
  python: 'Python 环境',
  typesetting: 'LaTeX/Typst 编译环境',
};

const STATE_TEXT: Record<CategoryResult['state'], string> = {
  正常: '正常',
  异常: '异常',
  检测中: '检测中',
  未检测: '未检测',
};

const UNCHECKED: CategoryResult = {
  state: '未检测',
  version: UNKNOWN_VERSION,
  checkedAt: null,
  reason: null,
  fixes: [],
  logIds: [],
};

const NO_PROVENANCE: KernelProvenance = {
  state: '不可追溯',
  version: null,
  commit: null,
  features: [],
  dirty: null,
  differences: [],
  reason: '尚未检测',
};

function checkingResult(): CategoryResult {
  return { state: '检测中', version: UNKNOWN_VERSION, checkedAt: null, reason: null, fixes: [], logIds: [] };
}

const STEP_LABELS: Record<OnboardingStepId, string> = {
  provider: '第 1 步：选择供应商',
  key: '第 2 步：填写密钥',
  environment: '第 3 步：检测环境',
  example: '第 4 步：打开示例题',
};

export default function DiagnosticsView() {
  const navigate = useNavigate();
  const [results, setResults] = useState<Record<DiagnosticCategory, CategoryResult>>(() =>
    Object.fromEntries(DIAGNOSTIC_CATEGORIES.map((category) => [category, UNCHECKED])) as Record<
      DiagnosticCategory,
      CategoryResult
    >
  );
  const [running, setRunning] = useState(false);
  const [provenance, setProvenance] = useState<KernelProvenance>(NO_PROVENANCE);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [gitSource, setGitSource] = useState<CheckpointGitSource | null>(null);
  const migrationFailures = useCredentialMigrationFailures();

  useEffect(() => {
    const off = window.electron.onDiagnosticsProgress((category, result) => {
      setResults((previous) => ({ ...previous, [category]: result }));
    });
    return off;
  }, []);

  useEffect(() => {
    window.electron.kernelProvenance().then(setProvenance).catch(() => setProvenance(NO_PROVENANCE));
    Promise.resolve()
      .then(() => window.electron.checkpointGitSource())
      .then(setGitSource)
      .catch(() => setGitSource(null));
    window.electron
      .getSetting('onboarding')
      .then((value) => setOnboarding(value ?? null))
      .catch(() => setOnboarding(null));
  }, []);

  const runDiagnostics = useCallback(async () => {
    setRunning(true);
    setResults(
      Object.fromEntries(
        DIAGNOSTIC_CATEGORIES.map((category) => [category, checkingResult()])
      ) as Record<DiagnosticCategory, CategoryResult>
    );
    try {
      const final = await window.electron.diagnosticsRun();
      setResults(final);
    } catch {
      // A total failure marks every category abnormal; the UI stays consistent.
      setResults((previous) =>
        Object.fromEntries(
          DIAGNOSTIC_CATEGORIES.map((category) => [
            category,
            { ...previous[category], state: '异常' as const, reason: '检测失败' },
          ])
        ) as Record<DiagnosticCategory, CategoryResult>
      );
    } finally {
      setRunning(false);
    }
  }, []);

  const exportReport = useCallback(async () => {
    const save = await window.electron.showSaveDialog({
      title: '导出诊断报告',
      defaultPath: 'modelforge-diagnostics.txt',
      filters: [{ name: '文本文件', extensions: ['txt'] }],
    });
    if (save.canceled || !save.filePath) {
      return;
    }
    const report: DiagnosticReport = { results, provenance };
    const result = await window.electron.diagnosticsExport(save.filePath, report);
    if (!result.ok) {
      window.electron.showMessageBox({
        type: 'error',
        title: '导出失败',
        message: `诊断报告写入失败：${result.error}`,
      });
    }
  }, [results, provenance]);

  const skipped = onboarding
    ? (Object.keys(onboarding.steps) as OnboardingStepId[]).filter(
        (step) => onboarding.steps[step] === 'skipped'
      )
    : [];

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto p-6">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-medium">诊断中心</h1>
          <div className="flex gap-2">
            <Button variant="outline" onClick={exportReport}>
              导出诊断报告
            </Button>
            <Button onClick={runDiagnostics} disabled={running}>
              {running ? '检测中…' : '一键检测'}
            </Button>
          </div>
        </div>

        <section className="space-y-3">
          {DIAGNOSTIC_CATEGORIES.map((category) => {
            const result = results[category];
            return (
              <div key={category} className="rounded-lg border border-border-default p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{CATEGORY_LABELS[category]}</span>
                  <span
                    className={
                      result.state === '正常'
                        ? 'text-green-600'
                        : result.state === '异常'
                          ? 'text-red-600'
                          : 'text-text-muted'
                    }
                  >
                    {STATE_TEXT[result.state]}
                  </span>
                </div>
                <div className="mt-1 text-sm text-text-muted">
                  版本：{result.version}
                  {result.checkedAt ? ` · 检测时间：${result.checkedAt}` : ''}
                </div>
                {result.reason && <div className="mt-1 text-sm text-red-600">原因：{result.reason}</div>}
                {result.fixes.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-sm text-text-secondary">
                    {result.fixes.map((fix, index) => (
                      <li key={index}>{fix.label}</li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>

        <section className="rounded-lg border border-border-default p-4">
          <h2 className="font-medium">构建来源</h2>
          {provenance.state === '正常' ? (
            <div className="mt-1 text-sm text-text-secondary">
              <div>commit：{provenance.commit}</div>
              <div>version：{provenance.version}</div>
              <div>dirty：{provenance.dirty ? 'true' : 'false'}</div>
              <div>features：{provenance.features.join(', ')}</div>
              {provenance.differences.length > 0 && (
                <div className="mt-1 text-red-600">不一致：{provenance.differences.join('；')}</div>
              )}
            </div>
          ) : (
            <div className="mt-1 text-sm text-text-muted">不可追溯{provenance.reason ? `（${provenance.reason}）` : ''}</div>
          )}
        </section>

        {/* Plaintext header migrations that failed at Kernel startup (requirement 1.9). */}
        {migrationFailures.length > 0 && <CredentialMigrationNotice failures={migrationFailures} />}

        <section className="rounded-lg border border-border-default p-4">
          <h2 className="font-medium">自动快照使用的 git</h2>
          <div className="mt-1 text-sm text-text-secondary">
            {gitSource === null ? (
              '检测中…'
            ) : gitSource.source ? (
              <>
                {gitSource.source === 'bundled' ? '随包 MinGit' : '系统 PATH 中的 git'}
                {gitSource.path ? `（${gitSource.path}）` : ''}
              </>
            ) : (
              <span className="text-red-600">
                {gitSource.errorCode}：未找到可用的 git，自动快照无法创建，写入文件的工具会被拒绝执行。
              </span>
            )}
          </div>
        </section>

        {skipped.length > 0 && (
          <section className="rounded-lg border border-border-default p-4">
            <h2 className="font-medium">补做向导步骤</h2>
            <div className="mt-2 flex flex-wrap gap-2">
              {skipped.map((step) => (
                <Button key={step} variant="outline" onClick={() => navigate(`/onboarding?step=${step}`)}>
                  {STEP_LABELS[step]}
                </Button>
              ))}
            </div>
          </section>
        )}

        <section className="rounded-lg border border-border-default p-4">
          <h2 className="font-medium">可选运行时</h2>
          <div className="mt-2 space-y-2">
            {OPTIONAL_RUNTIMES.map((runtime) => (
              <div key={runtime.id} className="text-sm">
                <span className="font-medium">{runtime.name}</span>
                <span className="text-text-muted"> · {runtime.purpose}</span>
                <div className="text-text-muted">依赖功能：{runtime.dependentFeatures.join('、')}</div>
                <a
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    window.electron.openExternal(runtime.installGuideUrl);
                  }}
                  className="underline"
                >
                  安装指引
                </a>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

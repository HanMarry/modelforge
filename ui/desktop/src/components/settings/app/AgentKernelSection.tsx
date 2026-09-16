import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import { Input } from '../../ui/input';
import { defineMessages, useIntl } from '../../../i18n';
import {
  defaultSettings,
  type AgentKernelId,
  type AgentKernelSettings,
} from '../../../utils/settings';
import type { AgentKernelStatus } from '../../../utils/agentKernel';
import { AppEvents } from '../../../constants/events';

const i18n = defineMessages({
  title: {
    id: 'agentKernelSection.title',
    defaultMessage: 'Agent Kernel',
  },
  description: {
    id: 'agentKernelSection.description',
    defaultMessage:
      'Choose the agent loop that runs your chats. The built-in kernel works out of the box; Claude Code and Codex run on the API configured in ModelForge through a local adapter.',
  },
  builtinTitle: {
    id: 'agentKernelSection.builtinTitle',
    defaultMessage: 'Built-in kernel',
  },
  builtinDescription: {
    id: 'agentKernelSection.builtinDescription',
    defaultMessage: 'ModelForge own agent loop. No extra runtime needed.',
  },
  claudeCodeTitle: {
    id: 'agentKernelSection.claudeCodeTitle',
    defaultMessage: 'Claude Code kernel',
  },
  claudeCodeDescription: {
    id: 'agentKernelSection.claudeCodeDescription',
    defaultMessage: 'Runs the Claude Code agent loop on the API you configured.',
  },
  codexTitle: {
    id: 'agentKernelSection.codexTitle',
    defaultMessage: 'Codex kernel',
  },
  codexDescription: {
    id: 'agentKernelSection.codexDescription',
    defaultMessage: 'Runs the OpenAI Codex agent loop on the API you configured.',
  },
  statusTitle: {
    id: 'agentKernelSection.statusTitle',
    defaultMessage: 'Kernel status',
  },
  statusBuiltin: {
    id: 'agentKernelSection.statusBuiltin',
    defaultMessage: 'The built-in kernel is active.',
  },
  statusReady: {
    id: 'agentKernelSection.statusReady',
    defaultMessage: 'Ready · {baseUrl} · model {model} · local adapter {shimUrl}',
  },
  statusIncomplete: {
    id: 'agentKernelSection.statusIncomplete',
    defaultMessage: 'Not ready yet',
  },
  activeBadge: {
    id: 'agentKernelSection.activeBadge',
    defaultMessage: 'Active',
  },
  usingProvider: {
    id: 'agentKernelSection.usingProvider',
    defaultMessage: 'Provider: {providerId}',
  },
  keySource: {
    id: 'agentKernelSection.keySource',
    defaultMessage: 'API key source: {source}',
  },
  keySourceKernel: {
    id: 'agentKernelSection.keySourceKernel',
    defaultMessage: 'entered for the kernel',
  },
  keySourceProvider: {
    id: 'agentKernelSection.keySourceProvider',
    defaultMessage: 'captured from the provider settings',
  },
  keySourceEnv: {
    id: 'agentKernelSection.keySourceEnv',
    defaultMessage: 'environment variable {name}',
  },
  keySourceNone: {
    id: 'agentKernelSection.keySourceNone',
    defaultMessage: 'not set',
  },
  apiKeyLabel: {
    id: 'agentKernelSection.apiKeyLabel',
    defaultMessage: 'API key for the kernel (optional)',
  },
  apiKeyPlaceholder: {
    id: 'agentKernelSection.apiKeyPlaceholder',
    defaultMessage: 'Leave blank to reuse the key saved in the provider settings',
  },
  apiKeyHelp: {
    id: 'agentKernelSection.apiKeyHelp',
    defaultMessage:
      'Stored encrypted on this device. goose never hands the provider key back to the app, so save it here once if the kernel reports the key is missing.',
  },
  saveKey: {
    id: 'agentKernelSection.saveKey',
    defaultMessage: 'Save key',
  },
  clearKey: {
    id: 'agentKernelSection.clearKey',
    defaultMessage: 'Forget saved key',
  },
  keySaved: {
    id: 'agentKernelSection.keySaved',
    defaultMessage: 'Key saved.',
  },
  restartNote: {
    id: 'agentKernelSection.restartNote',
    defaultMessage:
      'Model, key, window and prices apply right away. Switching the kernel itself needs a restart.',
  },
  restartRequired: {
    id: 'agentKernelSection.restartRequired',
    defaultMessage: 'Kernel changed — restart ModelForge to provision it.',
  },
  restartNow: {
    id: 'agentKernelSection.restartNow',
    defaultMessage: 'Restart now',
  },
  pricingTitle: {
    id: 'agentKernelSection.pricingTitle',
    defaultMessage: 'Model pricing (optional)',
  },
  pricingHelp: {
    id: 'agentKernelSection.pricingHelp',
    defaultMessage:
      'Per 1M tokens, used to estimate what the kernel spends on your model. The kernel reports its own tokens; goose has no price for it.',
  },
  inputPrice: {
    id: 'agentKernelSection.inputPrice',
    defaultMessage: 'Input / 1M',
  },
  outputPrice: {
    id: 'agentKernelSection.outputPrice',
    defaultMessage: 'Output / 1M',
  },
  currency: {
    id: 'agentKernelSection.currency',
    defaultMessage: 'Currency',
  },
  contextWindowTitle: {
    id: 'agentKernelSection.contextWindowTitle',
    defaultMessage: 'Context window of {model}',
  },
  contextWindowHelp: {
    id: 'agentKernelSection.contextWindowHelp',
    defaultMessage:
      'Windows differ per model, so this applies to {model} only. The context bar and its warnings use this value instead of the kernel’s own (usually larger) window.',
  },
  contextWindowSourceOverride: {
    id: 'agentKernelSection.contextWindowSourceOverride',
    defaultMessage: 'Using the window you entered.',
  },
  contextWindowSourceProvider: {
    id: 'agentKernelSection.contextWindowSourceProvider',
    defaultMessage: 'Using the window the provider declares for this model.',
  },
  contextWindowSourceUnknown: {
    id: 'agentKernelSection.contextWindowSourceUnknown',
    defaultMessage:
      'The provider declares no window for this model, so the bar cannot warn you in time — filling it in here is recommended.',
  },
  keyNotSavedNoProvider: {
    id: 'agentKernelSection.keyNotSavedNoProvider',
    defaultMessage: 'Provider not resolved — save the provider settings first.',
  },
  keyButtonDisabledReason: {
    id: 'agentKernelSection.keyButtonDisabledReason',
    defaultMessage: 'Save provider settings before adding a key',
  },
  apiKeyCopyMissing: {
    id: 'agentKernelSection.apiKeyCopyMissing',
    defaultMessage:
      'If the key is already saved in the provider settings, goose keeps it in the system credential store and never hands it back to the app — the external kernel needs its own copy. Enter the key once below; the kernel starts right away.',
  },
});

const KERNEL_OPTIONS: {
  id: AgentKernelId;
  title: keyof typeof i18n;
  description: keyof typeof i18n;
}[] = [
  { id: 'builtin', title: 'builtinTitle', description: 'builtinDescription' },
  { id: 'claude-code', title: 'claudeCodeTitle', description: 'claudeCodeDescription' },
  { id: 'codex', title: 'codexTitle', description: 'codexDescription' },
];

export default function AgentKernelSection() {
  const intl = useIntl();
  const [kernel, setKernel] = useState<AgentKernelSettings>(defaultSettings.agentKernel);
  const [status, setStatus] = useState<AgentKernelStatus | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const refreshStatus = useCallback(async () => {
    try {
      // refresh (not the cached status) so a key captured elsewhere takes effect on open:
      // it re-resolves the key and re-provisions the kernel when nothing is running yet.
      setStatus(await window.electron.refreshAgentKernel());
    } catch (error) {
      console.error('Failed to refresh agent kernel status', error);
    }
  }, []);

  useEffect(() => {
    window.electron
      .getSetting('agentKernel')
      .then((value) => setKernel(value ?? defaultSettings.agentKernel))
      .catch((error) => console.error('Failed to read agent kernel settings', error));
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const onKernelChanged = () => void refreshStatus();
    window.addEventListener(AppEvents.AGENT_KERNEL_CHANGED, onKernelChanged);
    return () => window.removeEventListener(AppEvents.AGENT_KERNEL_CHANGED, onKernelChanged);
  }, [refreshStatus]);

  const selectKernel = async (runtime: AgentKernelId) => {
    const next = { ...kernel, runtime };
    setKernel(next);
    setNotice(null);
    setIsBusy(true);
    try {
      await window.electron.setSetting('agentKernel', next);
      setStatus(await window.electron.refreshAgentKernel());
    } catch (error) {
      console.error('Failed to switch agent kernel', error);
    } finally {
      setIsBusy(false);
    }
  };

  const saveKey = async () => {
    if (!apiKey.trim()) {
      return;
    }
    if (!status?.providerId) {
      setNotice(intl.formatMessage(i18n.keyNotSavedNoProvider));
      return;
    }
    setIsBusy(true);
    try {
      await window.electron.setAgentKernelKey(status.providerId, apiKey.trim());
      setApiKey('');
      setNotice(intl.formatMessage(i18n.keySaved));
      setStatus(await window.electron.refreshAgentKernel());
    } catch (error) {
      console.error('Failed to save the agent kernel API key', error);
    } finally {
      setIsBusy(false);
    }
  };

  const clearKey = async () => {
    if (!status?.providerId) {
      return;
    }
    setIsBusy(true);
    try {
      await window.electron.clearAgentKernelKey(status.providerId);
      setStatus(await window.electron.refreshAgentKernel());
    } catch (error) {
      console.error('Failed to clear the agent kernel API key', error);
    } finally {
      setIsBusy(false);
    }
  };

  const keySourceLabel = (current: AgentKernelStatus): string => {
    switch (current.apiKeySource) {
      case 'kernel':
        return intl.formatMessage(i18n.keySourceKernel);
      case 'provider':
        return intl.formatMessage(i18n.keySourceProvider);
      case 'env':
        return intl.formatMessage(i18n.keySourceEnv, { name: current.apiKeyEnv });
      default:
        return intl.formatMessage(i18n.keySourceNone);
    }
  };

  const savePrices = async (patch: Partial<AgentKernelSettings>) => {
    const next = { ...kernel, ...patch };
    setKernel(next);
    try {
      await window.electron.setSetting('agentKernel', next);
      window.dispatchEvent(new CustomEvent(AppEvents.AGENT_KERNEL_CHANGED));
    } catch (error) {
      console.error('Failed to save the kernel model prices', error);
    }
  };

  const priceValue = (value: number | null): string => (value === null ? '' : String(value));

  const parsePrice = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  };

  /** The window belongs to the model, so the override is keyed by the kernel's model name. */
  const contextLimitValue = status?.model
    ? (kernel.contextLimits?.[status.model]?.toString() ?? '')
    : '';

  const saveContextLimit = async (raw: string) => {
    if (!status?.model) {
      return;
    }
    const limits = { ...(kernel.contextLimits ?? {}) };
    const parsed = parsePrice(raw);
    if (parsed === null || parsed === 0) {
      delete limits[status.model];
    } else {
      limits[status.model] = parsed;
    }
    await savePrices({ contextLimits: limits });
    setStatus(await window.electron.refreshAgentKernel());
  };

  const isExternal = kernel.runtime !== 'builtin';

  return (
    <section id="agent-kernel" className="space-y-4 pr-4 mt-1">
      <Card className="pb-2">
        <CardHeader className="pb-0">
          <CardTitle>{intl.formatMessage(i18n.title)}</CardTitle>
          <CardDescription>{intl.formatMessage(i18n.description)}</CardDescription>
        </CardHeader>
        <CardContent className="pt-4 space-y-3 px-4">
          {KERNEL_OPTIONS.map((option) => {
            const selected = kernel.runtime === option.id;
            return (
              <button
                key={option.id}
                type="button"
                disabled={isBusy}
                onClick={() => void selectKernel(option.id)}
                className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                  selected
                    ? 'border-blue-400 bg-background-muted'
                    : 'border-border-default hover:border-blue-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <h3 className="text-text-primary text-xs">
                    {intl.formatMessage(i18n[option.title])}
                  </h3>
                  {selected && (
                    <span className="text-xs text-text-secondary">
                      {intl.formatMessage(i18n.activeBadge)}
                    </span>
                  )}
                </div>
                <p className="text-xs text-text-secondary mt-[2px]">
                  {intl.formatMessage(i18n[option.description])}
                </p>
              </button>
            );
          })}
        </CardContent>
      </Card>

      <Card className="pb-2">
        <CardHeader className="pb-0">
          <CardTitle>{intl.formatMessage(i18n.statusTitle)}</CardTitle>
          <CardDescription>
            {!isExternal
              ? intl.formatMessage(i18n.statusBuiltin)
              : status?.error
                ? status.error
                : status
                  ? intl.formatMessage(i18n.statusReady, {
                      baseUrl: status.baseUrl,
                      model: status.model,
                      shimUrl: status.shimUrl ?? '-',
                    })
                  : intl.formatMessage(i18n.statusIncomplete)}
          </CardDescription>
        </CardHeader>
        {isExternal && (
          <CardContent className="pt-4 space-y-3 px-4">
            {status && (
              <p className="text-xs text-text-secondary">
                {intl.formatMessage(i18n.usingProvider, { providerId: status.providerId || '-' })}
                {' · '}
                {intl.formatMessage(i18n.keySource, { source: keySourceLabel(status) })}
              </p>
            )}

            <div>
              <h3 className="text-text-primary text-xs mb-1">
                {intl.formatMessage(i18n.apiKeyLabel)}
              </h3>
              <div className="flex items-center gap-2">
                <Input
                  type="password"
                  value={apiKey}
                  placeholder={intl.formatMessage(i18n.apiKeyPlaceholder)}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                />
                <button
                  type="button"
                  disabled={isBusy || !apiKey.trim() || !status?.providerId}
                  onClick={() => void saveKey()}
                  title={!status?.providerId ? intl.formatMessage(i18n.keyButtonDisabledReason) : ''}
                  className="rounded-md border border-border-default px-3 py-2 text-xs text-text-primary hover:border-blue-400 disabled:opacity-50"
                >
                  {intl.formatMessage(i18n.saveKey)}
                </button>
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => void clearKey()}
                  className="rounded-md border border-border-default px-3 py-2 text-xs text-text-primary hover:border-blue-400 disabled:opacity-50"
                >
                  {intl.formatMessage(i18n.clearKey)}
                </button>
              </div>
              <p className="text-xs text-text-secondary mt-[2px]">
                {intl.formatMessage(i18n.apiKeyHelp)}
              </p>
              {status?.error && status.apiKeySource === 'none' && (
                <p className="text-xs text-text-secondary mt-[2px]">
                  {intl.formatMessage(i18n.apiKeyCopyMissing)}
                </p>
              )}
              {notice && <p className="text-xs text-text-secondary mt-[2px]">{notice}</p>}
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-text-secondary max-w-md">
                {status?.restartRequired
                  ? intl.formatMessage(i18n.restartRequired)
                  : intl.formatMessage(i18n.restartNote)}
              </p>
              <button
                type="button"
                onClick={() => window.electron.restartApp()}
                className={
                  status?.restartRequired
                    ? 'rounded-md border border-blue-400 bg-background-tertiary px-3 py-2 text-xs text-text-primary'
                    : 'rounded-md border border-border-default px-3 py-2 text-xs text-text-primary hover:border-blue-400'
                }
              >
                {intl.formatMessage(i18n.restartNow)}
              </button>
            </div>
          </CardContent>
        )}
      </Card>

      {isExternal && (
        <Card className="pb-2">
          <CardHeader className="pb-0">
            <CardTitle>{intl.formatMessage(i18n.pricingTitle)}</CardTitle>
            <CardDescription>{intl.formatMessage(i18n.pricingHelp)}</CardDescription>
          </CardHeader>
          <CardContent className="pt-4 px-4 space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.inputPrice)}
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="h-8 w-32 text-sm"
                  value={priceValue(kernel.inputTokenCost)}
                  onChange={(event) =>
                    void savePrices({ inputTokenCost: parsePrice(event.target.value) })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.outputPrice)}
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  className="h-8 w-32 text-sm"
                  value={priceValue(kernel.outputTokenCost)}
                  onChange={(event) =>
                    void savePrices({ outputTokenCost: parsePrice(event.target.value) })
                  }
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.currency)}
                <Input
                  className="h-8 w-20 text-sm"
                  maxLength={3}
                  value={kernel.currency}
                  onChange={(event) => void savePrices({ currency: event.target.value })}
                />
              </label>
            </div>
          </CardContent>
        </Card>
      )}

      {isExternal && status?.model && (
        <Card className="pb-2">
          <CardHeader className="pb-0">
            <CardTitle>
              {intl.formatMessage(i18n.contextWindowTitle, { model: status.model })}
            </CardTitle>
            <CardDescription>
              {intl.formatMessage(i18n.contextWindowHelp, { model: status.model })}
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4 px-4 space-y-2">
            <div className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                tokens
                <Input
                  type="number"
                  min="0"
                  step="1000"
                  className="h-8 w-40 text-sm"
                  value={contextLimitValue}
                  placeholder="128000"
                  onChange={(event) => void saveContextLimit(event.target.value)}
                />
              </label>
            </div>
            <p className="text-xs text-text-secondary">
              {status.contextLimitSource === 'override'
                ? intl.formatMessage(i18n.contextWindowSourceOverride)
                : status.contextLimitSource === 'provider'
                  ? intl.formatMessage(i18n.contextWindowSourceProvider)
                  : intl.formatMessage(i18n.contextWindowSourceUnknown)}
            </p>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Cpu } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../../ui/dropdown-menu';
import { acpListProviderModels } from '../../../acp/providers';
import { toastError, toastSuccess } from '../../../toasts';
import { defineMessages, useIntl } from '../../../i18n';
import { defaultSettings, type AgentKernelSettings } from '../../../utils/settings';
import type { AgentKernelStatus } from '../../../utils/agentKernel';

const i18n = defineMessages({
  title: {
    id: 'kernelModel.title',
    defaultMessage: 'Kernel model',
  },
  description: {
    id: 'kernelModel.description',
    defaultMessage:
      'The {kernel} kernel sends every request through the local adapter, which forwards it to the model below. Picking a model applies to the next request.',
  },
  provider: {
    id: 'kernelModel.provider',
    defaultMessage: 'Provider: {provider}',
  },
  loading: {
    id: 'kernelModel.loading',
    defaultMessage: 'Loading models…',
  },
  empty: {
    id: 'kernelModel.empty',
    defaultMessage: 'This provider has no models to choose from.',
  },
  notRunning: {
    id: 'kernelModel.notRunning',
    defaultMessage: 'The kernel is not running yet — check 应用 → 智能体内核.',
  },
  switched: {
    id: 'kernelModel.switched',
    defaultMessage: 'Kernel model switched to {model}',
  },
  switchFailed: {
    id: 'kernelModel.switchFailed',
    defaultMessage: 'Could not switch the kernel model',
  },
  readFailed: {
    id: 'kernelModel.readFailed',
    defaultMessage: 'Could not read the kernel state',
  },
});

const KERNEL_LABEL: Record<AgentKernelSettings['runtime'], string> = {
  builtin: 'ModelForge',
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/**
 * The external kernels run on their own model slot (`current`), so the model the user picks
 * here is what the app's adapter forwards upstream.
 */
export default function KernelModelCard() {
  const intl = useIntl();
  const [kernel, setKernel] = useState<AgentKernelSettings>(defaultSettings.agentKernel);
  const [status, setStatus] = useState<AgentKernelStatus | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const settings = await window.electron.getSetting('agentKernel');
      const kernelSettings = settings ?? defaultSettings.agentKernel;
      setKernel(kernelSettings);

      const kernelStatus = await window.electron.getAgentKernelStatus();
      setStatus(kernelStatus);

      if (!kernelStatus.providerId) {
        setModels([]);
        return;
      }
      const providerModels = await acpListProviderModels(kernelStatus.providerId);
      const names = providerModels
        .map((model) => model.id)
        .filter((id): id is string => Boolean(id));
      if (kernelStatus.model && !names.includes(kernelStatus.model)) {
        names.unshift(kernelStatus.model);
      }
      setModels(names);
    } catch (error) {
      console.error('Failed to read the kernel model state', error);
      toastError({ title: intl.formatMessage(i18n.readFailed), msg: String(error) });
    } finally {
      setIsLoading(false);
    }
  }, [intl]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectModel = async (model: string) => {
    try {
      const next = { ...kernel, model };
      await window.electron.setSetting('agentKernel', next);
      setKernel(next);
      setStatus(await window.electron.setAgentKernelModel(model));
      toastSuccess({
        title: intl.formatMessage(i18n.switched, { model }),
        msg: '',
      });
    } catch (error) {
      console.error('Failed to switch the kernel model', error);
      toastError({ title: intl.formatMessage(i18n.switchFailed), msg: String(error) });
    }
  };

  const currentModel = status?.model ?? '';
  const kernelName = KERNEL_LABEL[kernel.runtime];

  return (
    <Card className="pb-2 rounded-lg">
      <CardHeader className="pb-0">
        <CardTitle className="flex items-center gap-2">
          <Cpu className="h-4 w-4" />
          {intl.formatMessage(i18n.title)}
        </CardTitle>
        <CardDescription>
          {intl.formatMessage(i18n.description, { kernel: kernelName })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-4 px-4 space-y-2">
        {status?.error ? (
          <p className="text-xs text-text-danger">{status.error}</p>
        ) : !status?.shimUrl ? (
          <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.notRunning)}</p>
        ) : (
          <p className="text-xs text-text-secondary">
            {intl.formatMessage(i18n.provider, { provider: status.providerId })}
            {status.shimUrl ? ` · ${status.shimUrl}` : ''}
          </p>
        )}

        {isLoading ? (
          <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.loading)}</p>
        ) : models.length === 0 ? (
          <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
        ) : (
          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full max-w-[320px] items-center justify-between gap-2 rounded-md border border-border-primary bg-background-primary px-3 py-2 text-sm text-text-primary transition-colors hover:border-border-secondary">
              <span className="truncate">{currentModel || '—'}</span>
              <ChevronDown className="h-4 w-4 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[320px] w-[320px] overflow-y-auto">
              <DropdownMenuRadioGroup value={currentModel} onValueChange={selectModel}>
                {models.map((model) => (
                  <DropdownMenuRadioItem key={model} value={model}>
                    {model}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </CardContent>
    </Card>
  );
}

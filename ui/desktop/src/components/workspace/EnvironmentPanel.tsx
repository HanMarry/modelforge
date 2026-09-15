import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Terminal as TerminalIcon } from 'lucide-react';
import type { EnvironmentProbe } from '../../types/workspaceApi';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';
import TerminalView from './TerminalView';

const i18n = defineMessages({
  checking: {
    id: 'environmentPanel.checking',
    defaultMessage: 'Checking the environment…',
  },
  refresh: {
    id: 'environmentPanel.refresh',
    defaultMessage: 'Re-check',
  },
  missing: {
    id: 'environmentPanel.missing',
    defaultMessage: 'Not found',
  },
  workingDir: {
    id: 'environmentPanel.workingDir',
    defaultMessage: 'Working directory',
  },
  terminal: {
    id: 'environmentPanel.terminal',
    defaultMessage: 'Terminal',
  },
  probeFailed: {
    id: 'environmentPanel.probeFailed',
    defaultMessage: 'Could not probe the environment',
  },
});

interface EnvironmentPanelProps {
  workingDir: string;
}

export default function EnvironmentPanel({ workingDir }: EnvironmentPanelProps) {
  const intl = useIntl();
  const [probes, setProbes] = useState<EnvironmentProbe[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setProbes(await window.electron.workspaceProbeEnvironment());
    } catch (probeError) {
      setError(probeError instanceof Error ? probeError.message : String(probeError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const availableCount = probes.filter((probe) => probe.available).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border-primary px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary">
            {intl.formatMessage(i18n.workingDir)}: {workingDir}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px] text-text-secondary"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
            {intl.formatMessage(i18n.refresh)}
          </Button>
        </div>

        <div className="mt-1.5 flex flex-wrap gap-1">
          {loading && probes.length === 0 && (
            <span className="text-[11px] text-text-tertiary">
              {intl.formatMessage(i18n.checking)}
            </span>
          )}
          {error && <span className="text-[11px] text-red-500">{error}</span>}
          {probes.map((probe) => (
            <span
              key={probe.id}
              title={probe.version ?? probe.command}
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px]',
                probe.available
                  ? 'bg-background-tertiary text-text-primary'
                  : 'border border-border-secondary text-text-tertiary'
              )}
            >
              {probe.label}
              <span className="ml-1 font-mono">
                {probe.available
                  ? (probe.version ?? '').replace(/^[a-zA-Z ]+/, '').slice(0, 14)
                  : intl.formatMessage(i18n.missing)}
              </span>
            </span>
          ))}
        </div>
        {!loading && probes.length > 0 && (
          <p className="mt-1 text-[10px] text-text-tertiary">
            {availableCount}/{probes.length}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 border-b border-border-primary px-2 py-1">
        <TerminalIcon className="h-3.5 w-3.5 text-text-tertiary" />
        <span className="text-[10px] text-text-secondary">{intl.formatMessage(i18n.terminal)}</span>
      </div>

      <div className="min-h-0 flex-1">
        <TerminalView cwd={workingDir} />
      </div>
    </div>
  );
}

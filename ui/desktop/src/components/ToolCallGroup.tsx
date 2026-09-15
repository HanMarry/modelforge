import { useState } from 'react';
import { ChevronRight, Wrench } from 'lucide-react';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';

const i18n = defineMessages({
  summary: {
    id: 'toolCallGroup.summary',
    defaultMessage: '{count} operations',
  },
  running: {
    id: 'toolCallGroup.running',
    defaultMessage: 'running',
  },
  done: {
    id: 'toolCallGroup.done',
    defaultMessage: 'completed',
  },
  expand: {
    id: 'toolCallGroup.expand',
    defaultMessage: 'Expand operations',
  },
  collapse: {
    id: 'toolCallGroup.collapse',
    defaultMessage: 'Collapse operations',
  },
});

interface ToolCallGroupProps {
  operationCount: number;
  isRunning: boolean;
  latestOperation: string | null;
  children: React.ReactNode;
}

export default function ToolCallGroup({
  operationCount,
  isRunning,
  latestOperation,
  children,
}: ToolCallGroupProps) {
  const intl = useIntl();
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? isRunning;

  return (
    <div className="my-2" data-testid="tool-call-group">
      <button
        type="button"
        onClick={() => setManualExpanded(!expanded)}
        title={intl.formatMessage(expanded ? i18n.collapse : i18n.expand)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border-primary bg-background-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-background-tertiary"
      >
        <Wrench className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0 font-medium text-text-primary">
          {intl.formatMessage(i18n.summary, { count: operationCount })}
        </span>
        <span
          className={cn(
            'shrink-0 rounded-full px-1.5 py-0.5 text-[10px]',
            isRunning
              ? 'bg-background-info/15 text-text-info'
              : 'bg-background-tertiary text-text-tertiary'
          )}
        >
          {intl.formatMessage(isRunning ? i18n.running : i18n.done)}
        </span>
        {latestOperation && (
          <span className="min-w-0 flex-1 truncate text-left" dir="auto">
            {latestOperation}
          </span>
        )}
        <ChevronRight
          className={cn(
            'h-3.5 w-3.5 shrink-0 transition-transform',
            expanded && 'rotate-90',
            !latestOperation && 'ml-auto'
          )}
        />
      </button>

      {expanded && (
        <div className="mt-2 flex flex-col gap-2 border-l border-border-primary pl-3">
          {children}
        </div>
      )}
    </div>
  );
}

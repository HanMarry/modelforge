import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Frame, RefreshCw, Wand2 } from 'lucide-react';
import type { WorkspaceEntry } from '../../types/workspaceApi';
import { AppEvents } from '../../constants/events';
import { usePanelAutoRefresh } from '../../hooks/usePanelAutoRefresh';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';

const i18n = defineMessages({
  empty: {
    id: 'diagramsPanel.empty',
    defaultMessage: 'No diagrams yet',
  },
  emptyHint: {
    id: 'diagramsPanel.emptyHint',
    defaultMessage:
      'Ask the agent for a technical roadmap or flow diagram; rendered .drawio / PNG output shows up here.',
  },
  generate: {
    id: 'diagramsPanel.generate',
    defaultMessage: 'Ask for a technical roadmap diagram',
  },
  refresh: {
    id: 'diagramsPanel.refresh',
    defaultMessage: 'Refresh',
  },
  openExternal: {
    id: 'diagramsPanel.openExternal',
    defaultMessage: 'Open with an external program',
  },
  count: {
    id: 'diagramsPanel.count',
    defaultMessage: '{count} diagrams',
  },
});

const DIAGRAM_PROMPT = [
  '请为当前项目画一张技术路线图（流程图）：',
  '',
  '要求：用 paper-diagram 技能（或可用的 drawio 工具）产出 .drawio 源文件与 PNG/SVG 预览，',
  '落到当前项目的 diagrams/ 目录；节点文字用中文，层级清晰，不要改动其他地方的文件。',
  '',
  '我的流程要点：',
  '（把步骤写在这里）',
].join('\n');

function insertIntoComposer(text: string): void {
  window.dispatchEvent(new CustomEvent(AppEvents.COMPOSER_INSERT, { detail: { text } }));
}

interface DiagramsPanelProps {
  workingDir: string;
  isAgentActive?: boolean;
}

export default function DiagramsPanel({ workingDir, isAgentActive = false }: DiagramsPanelProps) {
  const intl = useIntl();
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const found = await window.electron.workspaceListDiagrams(workingDir);
      setEntries(found);

      const images = found.filter((entry) => /\.(png|svg)$/i.test(entry.name)).slice(0, 12);
      const loaded = await Promise.all(
        images.map(async (entry) => {
          const binary = await window.electron.workspaceReadBinary(entry.path);
          return [entry.path, binary.dataUrl ?? ''] as const;
        })
      );
      setPreviews(Object.fromEntries(loaded.filter(([, url]) => url)));
    } finally {
      setLoading(false);
    }
  }, [workingDir]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePanelAutoRefresh(isAgentActive, () => void refresh());

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">
          {intl.formatMessage(i18n.count, { count: entries.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.refresh)}
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {entries.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
            <Frame className="h-8 w-8 text-text-tertiary" />
            <p className="text-xs text-text-primary">{intl.formatMessage(i18n.empty)}</p>
            <p className="text-[11px] text-text-tertiary">{intl.formatMessage(i18n.emptyHint)}</p>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => insertIntoComposer(DIAGRAM_PROMPT)}
            >
              <Wand2 className="h-3.5 w-3.5" />
              {intl.formatMessage(i18n.generate)}
            </Button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {entries.map((entry) => (
            <div
              key={entry.path}
              className="group overflow-hidden rounded border border-border-primary bg-background-secondary/50"
            >
              <button
                type="button"
                onClick={() => void window.electron.workspaceOpenPath(entry.path)}
                className="flex h-24 w-full items-center justify-center overflow-hidden"
                title={intl.formatMessage(i18n.openExternal)}
              >
                {previews[entry.path] ? (
                  <img
                    src={previews[entry.path]}
                    alt={entry.name}
                    className="max-h-full max-w-full object-contain"
                  />
                ) : (
                  <Frame className="h-6 w-6 text-text-tertiary" />
                )}
              </button>
              <div className="flex items-center gap-1 border-t border-border-primary px-1.5 py-1">
                <span className="min-w-0 flex-1 truncate text-[10px] text-text-secondary">
                  {entry.name}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-text-tertiary hover:text-text-primary"
                  title={intl.formatMessage(i18n.openExternal)}
                  onClick={() => void window.electron.workspaceOpenPath(entry.path)}
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

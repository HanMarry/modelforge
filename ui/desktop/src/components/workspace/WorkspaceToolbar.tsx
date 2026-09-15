import {
  Columns2,
  ClipboardList,
  FileText,
  Frame,
  History,
  PanelRightClose,
  PanelRightOpen,
  Terminal,
  Wand2,
} from 'lucide-react';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import type { WorkspaceTab } from './WorkspacePanel';

const i18n = defineMessages({
  project: { id: 'workspaceToolbar.project', defaultMessage: 'Project' },
  editor: { id: 'workspaceToolbar.editor', defaultMessage: 'Editor view' },
  files: { id: 'workspaceToolbar.files', defaultMessage: 'Files' },
  environment: { id: 'workspaceToolbar.environment', defaultMessage: 'Environment' },
  versions: { id: 'workspaceToolbar.versions', defaultMessage: 'Versions' },
  figures: { id: 'workspaceToolbar.figures', defaultMessage: 'Figures' },
  diagrams: { id: 'workspaceToolbar.diagrams', defaultMessage: 'Diagrams' },
  open: { id: 'workspaceToolbar.open', defaultMessage: 'Open panel' },
  close: { id: 'workspaceToolbar.close', defaultMessage: 'Hide panel' },
});

interface WorkspaceToolbarProps {
  isOpen: boolean;
  isEditorOpen: boolean;
  activeTab: WorkspaceTab | null;
  onSelect: (tab: WorkspaceTab) => void;
  onToggleEditor: () => void;
  onToggle: () => void;
}

const BUTTONS: { id: WorkspaceTab; icon: typeof FileText; labelKey: keyof typeof i18n }[] = [
  { id: 'project', icon: ClipboardList, labelKey: 'project' },
  { id: 'files', icon: FileText, labelKey: 'files' },
  { id: 'environment', icon: Terminal, labelKey: 'environment' },
  { id: 'versions', icon: History, labelKey: 'versions' },
  { id: 'figures', icon: Wand2, labelKey: 'figures' },
  { id: 'diagrams', icon: Frame, labelKey: 'diagrams' },
];

export default function WorkspaceToolbar({
  isOpen,
  isEditorOpen,
  activeTab,
  onSelect,
  onToggleEditor,
  onToggle,
}: WorkspaceToolbarProps) {
  const intl = useIntl();

  return (
    <div className="no-drag flex flex-row items-center gap-0.5">
      <button
        type="button"
        title={intl.formatMessage(i18n.editor)}
        aria-label={intl.formatMessage(i18n.editor)}
        aria-pressed={isEditorOpen}
        onClick={onToggleEditor}
        className={cn(
          'flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors',
          isEditorOpen
            ? 'bg-background-tertiary text-text-primary'
            : 'text-text-secondary hover:bg-background-tertiary/60 hover:text-text-primary'
        )}
      >
        <Columns2 className="h-3.5 w-3.5" />
        <span className="hidden lg:inline">{intl.formatMessage(i18n.editor)}</span>
      </button>
      <span className="mx-0.5 h-4 w-px bg-border-primary" />

      {BUTTONS.map((entry) => {
        const Icon = entry.icon;
        const isActive = isOpen && activeTab === entry.id;
        return (
          <button
            key={entry.id}
            type="button"
            title={intl.formatMessage(i18n[entry.labelKey])}
            aria-label={intl.formatMessage(i18n[entry.labelKey])}
            aria-pressed={isActive}
            onClick={() => onSelect(entry.id)}
            className={cn(
              'flex items-center gap-1 rounded px-1.5 py-1 text-xs transition-colors',
              isActive
                ? 'bg-background-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-background-tertiary/60 hover:text-text-primary'
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{intl.formatMessage(i18n[entry.labelKey])}</span>
          </button>
        );
      })}
      <button
        type="button"
        title={intl.formatMessage(isOpen ? i18n.close : i18n.open)}
        aria-label={intl.formatMessage(isOpen ? i18n.close : i18n.open)}
        onClick={onToggle}
        className="rounded p-1 text-text-secondary transition-colors hover:bg-background-tertiary/60 hover:text-text-primary"
      >
        {isOpen ? (
          <PanelRightClose className="h-3.5 w-3.5" />
        ) : (
          <PanelRightOpen className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

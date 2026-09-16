import { ScrollArea } from '../ui/scroll-area';
import { Input } from '../ui/input';
import { View, ViewOptions } from '../../utils/navigationUtils';
import ModelsSection from './models/ModelsSection';
import ExternalBackendSection from './app/ExternalBackendSection';
import AppSettingsSection from './app/AppSettingsSection';
import ConfigSettings from './config/ConfigSettings';
import PromptsSettingsSection from './PromptsSettingsSection';
import ProfileSection from './profile/ProfileSection';
import type { ExtensionConfig } from '../../types/extensions';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import {
  ArrowLeft,
  Bot,
  FileText,
  HardDrive,
  Keyboard,
  KeyRound,
  MessageSquare,
  Monitor,
  Search,
  Share2,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState, useEffect, useRef } from 'react';
import ChatSettingsSection from './chat/ChatSettingsSection';
import KeyboardShortcutsSection from './keyboard/KeyboardShortcutsSection';
import AuthSettingsSection from './auth/AuthSettingsSection';
import LocalInferenceSection from './localInference/LocalInferenceSection';
import { CONFIGURATION_ENABLED } from '../../updates';
import { trackSettingsTabViewed } from '../../utils/analytics';
import { useFeatures } from '../../contexts/FeaturesContext';
import { defineMessages, useIntl } from '../../i18n';
import type { MessageDescriptor } from 'react-intl';
import { PROFILE_MESSAGE } from '../../hooks/useNavigationItems';
import { cn } from '../../utils';

const i18n = defineMessages({
  title: {
    id: 'settingsView.title',
    defaultMessage: 'Settings',
  },
  backToApp: {
    id: 'settingsView.backToApp',
    defaultMessage: 'Back to app',
  },
  searchSettings: {
    id: 'settingsView.searchSettings',
    defaultMessage: 'Search settings',
  },
  tabModels: {
    id: 'settingsView.tabModels',
    defaultMessage: 'Models',
  },
  tabLocalInference: {
    id: 'settingsView.tabLocalInference',
    defaultMessage: 'Local Inference',
  },
  tabChat: {
    id: 'settingsView.tabChat',
    defaultMessage: 'Chat',
  },
  tabExternalBackend: {
    id: 'settingsView.tabExternalBackend',
    defaultMessage: 'External Backend',
  },
  tabPrompts: {
    id: 'settingsView.tabPrompts',
    defaultMessage: 'Prompts',
  },
  tabKeyboard: {
    id: 'settingsView.tabKeyboard',
    defaultMessage: 'Keyboard',
  },
  tabAuth: {
    id: 'settingsView.tabAuth',
    defaultMessage: 'Auth',
  },
  tabApp: {
    id: 'settingsView.tabApp',
    defaultMessage: 'App',
  },
});

export type SettingsViewOptions = {
  deepLinkConfig?: ExtensionConfig;
  showEnvVars?: boolean;
  section?: string;
};

type SectionId =
  | 'profile'
  | 'models'
  | 'local-inference'
  | 'chat'
  | 'prompts'
  | 'external-backend'
  | 'keyboard'
  | 'auth'
  | 'app';

interface Section {
  id: SectionId;
  icon: LucideIcon;
  label: MessageDescriptor;
}

const SECTIONS: Section[] = [
  { id: 'profile', icon: UserRound, label: PROFILE_MESSAGE },
  { id: 'models', icon: Bot, label: i18n.tabModels },
  { id: 'local-inference', icon: HardDrive, label: i18n.tabLocalInference },
  { id: 'chat', icon: MessageSquare, label: i18n.tabChat },
  { id: 'prompts', icon: FileText, label: i18n.tabPrompts },
  { id: 'external-backend', icon: Share2, label: i18n.tabExternalBackend },
  { id: 'keyboard', icon: Keyboard, label: i18n.tabKeyboard },
  { id: 'auth', icon: KeyRound, label: i18n.tabAuth },
  { id: 'app', icon: Monitor, label: i18n.tabApp },
];

/** Deep links and older callers still speak in the previous tab names. */
const SECTION_ALIASES: Record<string, SectionId> = {
  profile: 'profile',
  models: 'models',
  providers: 'models',
  'local-inference': 'local-inference',
  chat: 'chat',
  modes: 'chat',
  styles: 'chat',
  tools: 'chat',
  prompts: 'prompts',
  sharing: 'external-backend',
  'external-backend': 'external-backend',
  keyboard: 'keyboard',
  auth: 'auth',
  app: 'app',
  update: 'app',
};

/** Remembers where the user was, so the gear reopens the same section. */
let lastVisitedSection: SectionId = 'profile';

export default function SettingsView({
  onClose,
  setView,
  viewOptions,
}: {
  onClose: () => void;
  setView: (view: View, viewOptions?: ViewOptions) => void;
  viewOptions: SettingsViewOptions;
}) {
  const [activeSection, setActiveSection] = useState<SectionId>(lastVisitedSection);
  const [query, setQuery] = useState('');
  const hasTrackedInitialSection = useRef(false);
  const { localInference } = useFeatures();
  const intl = useIntl();

  const handleSectionChange = (section: SectionId) => {
    lastVisitedSection = section;
    setActiveSection(section);
    trackSettingsTabViewed(section);
  };

  useEffect(() => {
    const target = viewOptions.section ? SECTION_ALIASES[viewOptions.section] : undefined;
    if (target && (target !== 'local-inference' || localInference)) {
      lastVisitedSection = target;
      setActiveSection(target);
    }
  }, [viewOptions.section, localInference]);

  // Reset the selection if local inference becomes unavailable
  useEffect(() => {
    if (!localInference && activeSection === 'local-inference') {
      setActiveSection('profile');
    }
  }, [localInference, activeSection]);

  useEffect(() => {
    if (!hasTrackedInitialSection.current) {
      trackSettingsTabViewed(activeSection);
      hasTrackedInitialSection.current = true;
    }
  }, [activeSection]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const sections = useMemo(
    () => SECTIONS.filter((section) => section.id !== 'local-inference' || localInference),
    [localInference]
  );

  const visibleSections = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return sections;
    }
    return sections.filter((section) =>
      intl.formatMessage(section.label).toLowerCase().includes(needle)
    );
  }, [sections, query, intl]);

  const activeLabel = intl.formatMessage(
    (sections.find((section) => section.id === activeSection) ?? SECTIONS[0]).label
  );

  const renderSection = () => {
    switch (activeSection) {
      case 'profile':
        return <ProfileSection />;
      case 'models':
        return <ModelsSection setView={setView} />;
      case 'local-inference':
        return <LocalInferenceSection />;
      case 'chat':
        return <ChatSettingsSection />;
      case 'prompts':
        return <PromptsSettingsSection />;
      case 'external-backend':
        return (
          <div className="space-y-8 pb-8">
            <ExternalBackendSection />
          </div>
        );
      case 'keyboard':
        return <KeyboardShortcutsSection />;
      case 'auth':
        return <AuthSettingsSection />;
      case 'app':
        return (
          <div className="space-y-8">
            {CONFIGURATION_ENABLED && <ConfigSettings />}
            <AppSettingsSection scrollToSection={viewOptions.section} />
          </div>
        );
    }
  };

  return (
    <MainPanelLayout>
      <div className="flex flex-1 min-h-0 h-full">
        <aside className="flex w-[248px] flex-shrink-0 flex-col border-r border-border-primary">
          <div className="px-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-text-secondary transition-colors hover:bg-background-secondary hover:text-text-primary"
            >
              <ArrowLeft className="h-4 w-4" />
              {intl.formatMessage(i18n.backToApp)}
            </button>
          </div>

          <h2 className="px-5 pb-2 pt-4 text-xs font-medium uppercase tracking-wide text-text-tertiary">
            {intl.formatMessage(i18n.title)}
          </h2>

          <div className="px-3 pb-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={intl.formatMessage(i18n.searchSettings)}
                aria-label={intl.formatMessage(i18n.searchSettings)}
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto px-2 pb-3">
            {visibleSections.map((section) => {
              const Icon = section.icon;
              const selected = section.id === activeSection;
              return (
                <button
                  key={section.id}
                  type="button"
                  data-testid={`settings-${section.id}-tab`}
                  aria-current={selected ? 'page' : undefined}
                  onClick={() => handleSectionChange(section.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors',
                    selected
                      ? 'bg-background-tertiary text-text-primary'
                      : 'text-text-secondary hover:bg-background-secondary hover:text-text-primary'
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{intl.formatMessage(section.label)}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="flex-1 min-w-0 overflow-hidden">
          <ScrollArea className="h-full">
            <div className="mx-auto w-full max-w-4xl px-8 pb-12 pt-16">
              <h1 className="mb-6 text-3xl font-light text-text-primary">{activeLabel}</h1>
              {renderSection()}
            </div>
          </ScrollArea>
        </div>
      </div>
    </MainPanelLayout>
  );
}

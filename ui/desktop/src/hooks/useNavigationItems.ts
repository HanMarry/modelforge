import {
  AppWindow,
  ChartNoAxesCombined,
  Clock,
  FileText,
  History,
  ListTree,
  MessageSquarePlus,
  Plug,
  Puzzle,
  Settings,
  Shapes,
  UserRound,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { defineMessages, type IntlShape, type MessageDescriptor } from 'react-intl';

export interface NavItem {
  id: string;
  path: string;
  label: string;
  icon: LucideIcon;
  getTag?: () => string;
  tagAlign?: 'left' | 'right';
}

/** A top-level item that expands into sub-items (currently only 扩展). */
export interface NavGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Returns true when the current path belongs to this group. */
  isActive: (pathname: string) => boolean;
  children: NavItem[];
}

/** Sub-items under 扩展, mirroring the product's 技能 / 模板 / 算法 / 插件 / 连接器. */
export const CATALOG_SUB_ITEMS: NavItem[] = [
  { id: 'catalog-skills', path: '/skills', label: '技能', icon: Zap },
  { id: 'catalog-templates', path: '/paper', label: '模板', icon: Shapes },
  { id: 'catalog-algorithms', path: '/algorithms', label: '算法', icon: ListTree },
  { id: 'catalog-plugins', path: '/extensions', label: '插件', icon: Puzzle },
  { id: 'catalog-connectors', path: '/connectors', label: '连接器', icon: Plug },
];

export const CATALOG_GROUP: NavGroup = {
  id: 'catalog',
  label: '扩展',
  icon: Puzzle,
  isActive: (pathname) =>
    ['/skills', '/paper', '/algorithms', '/extensions', '/connectors'].includes(pathname),
  children: CATALOG_SUB_ITEMS,
};

/** Top-level items, in sidebar order. */
export const NAV_ITEMS: NavItem[] = [
  { id: 'home', path: '/', label: '新建会话', icon: MessageSquarePlus },
  { id: 'figures', path: '/figures', label: '科研绘图', icon: ChartNoAxesCombined },
  { id: 'paper', path: '/paper', label: '论文模板', icon: FileText },
  { id: 'apps', path: '/apps', label: '应用', icon: AppWindow },
  { id: 'scheduler', path: '/schedules', label: '自动化', icon: Clock },
  { id: 'sessions', path: '/sessions', label: '会话历史', icon: History },
];

/** Settings is rendered separately, pinned to the bottom of the sidebar. */
export const SETTINGS_NAV_ITEM: NavItem = {
  id: 'settings',
  path: '/settings',
  label: '设置',
  icon: Settings,
};

export const PROFILE_NAV_ITEM: NavItem = {
  id: 'profile',
  path: '/profile',
  label: '个人信息',
  icon: UserRound,
};

/**
 * Translation descriptors for nav labels. Kept here next to the items so the two
 * stay in sync; the returned label is localised at render time.
 */
const navItemMessages = defineMessages({
  home: { id: 'navigation.itemHome', defaultMessage: 'New Session' },
  figures: { id: 'navigation.itemFigures', defaultMessage: 'Figures' },
  paper: { id: 'navigation.itemPaper', defaultMessage: 'Paper Templates' },
  apps: { id: 'navigation.itemApps', defaultMessage: 'Apps' },
  scheduler: { id: 'navigation.itemScheduler', defaultMessage: 'Automation' },
  sessions: { id: 'navigation.itemSessions', defaultMessage: 'Session History' },
  settings: { id: 'navigation.itemSettings', defaultMessage: 'Settings' },
  profile: { id: 'navigation.itemProfile', defaultMessage: 'Profile' },
  catalog: { id: 'navigation.itemCatalog', defaultMessage: 'Extensions' },
  catalogSkills: { id: 'navigation.catalogSkills', defaultMessage: 'Skills' },
  catalogTemplates: { id: 'navigation.catalogTemplates', defaultMessage: 'Templates' },
  catalogAlgorithms: { id: 'navigation.catalogAlgorithms', defaultMessage: 'Algorithms' },
  catalogPlugins: { id: 'navigation.catalogPlugins', defaultMessage: 'Plugins' },
  catalogConnectors: { id: 'navigation.catalogConnectors', defaultMessage: 'Connectors' },
});

/** Message id per nav item id. */
const MESSAGE_ID_BY_ITEM: Record<string, keyof typeof navItemMessages> = {
  home: 'home',
  figures: 'figures',
  paper: 'paper',
  apps: 'apps',
  scheduler: 'scheduler',
  sessions: 'sessions',
  settings: 'settings',
  profile: 'profile',
  'catalog-skills': 'catalogSkills',
  'catalog-templates': 'catalogTemplates',
  'catalog-algorithms': 'catalogAlgorithms',
  'catalog-plugins': 'catalogPlugins',
  'catalog-connectors': 'catalogConnectors',
};

export const NAV_GROUP_MESSAGE: MessageDescriptor = navItemMessages.catalog;

/** The account section of the settings page (profile and settings share one page). */
export const PROFILE_MESSAGE: MessageDescriptor = navItemMessages.profile;

/** Localised label for a nav item, falling back to the literal label. */
export function getNavItemLabel(item: NavItem, intl: IntlShape): string {
  const key = MESSAGE_ID_BY_ITEM[item.id];
  return key ? intl.formatMessage(navItemMessages[key]) : item.label;
}

/** Localised label for the 扩展 group. */
export function navGroupLabel(intl: IntlShape, group: NavGroup): string {
  return group.id === 'catalog' ? intl.formatMessage(navItemMessages.catalog) : group.label;
}

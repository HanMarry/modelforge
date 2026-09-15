import { useMemo, useState } from 'react';
import { ExternalLink, PackagePlus, Play } from 'lucide-react';
import {
  ALGORITHM_CATALOG,
  ALGORITHM_CATEGORIES,
  ALGORITHM_CATEGORY_MESSAGES,
  type AlgorithmCategory,
  type AlgorithmEntry,
} from '../catalog/algorithms';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import { Button } from './ui/button';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';
import { useNavigation } from '../hooks/useNavigation';
import { useConfig } from './ConfigContext';
import { createSession } from '../sessions';
import { getInitialWorkingDir } from '../utils/workingDir';
import { AppEvents } from '../constants/events';
import { toastError } from '../toasts';
import { errorMessage } from '../utils/conversionUtils';

const i18n = defineMessages({
  title: { id: 'algorithmsView.title', defaultMessage: 'Methods and algorithms' },
  subtitle: {
    id: 'algorithmsView.subtitle',
    defaultMessage: 'Ready-made method cards: pick one and let the agent install dependencies and write the code.',
  },
  searchPlaceholder: {
    id: 'algorithmsView.searchPlaceholder',
    defaultMessage: 'Search methods or packages, e.g. PSO, scikit-learn',
  },
  all: { id: 'algorithmsView.all', defaultMessage: 'All' },
  needsInstall: { id: 'algorithmsView.needsInstall', defaultMessage: 'Needs install' },
  useWhen: { id: 'algorithmsView.useWhen', defaultMessage: 'When to use it' },
  dataNeeded: { id: 'algorithmsView.dataNeeded', defaultMessage: 'What data it needs' },
  outputs: { id: 'algorithmsView.outputs', defaultMessage: 'What you get back' },
  notSuitableFor: { id: 'algorithmsView.notSuitableFor', defaultMessage: 'When not to use it' },
  entrypoint: { id: 'algorithmsView.entrypoint', defaultMessage: 'Entry point' },
  dependencies: { id: 'algorithmsView.dependencies', defaultMessage: 'Dependencies' },
  homepage: { id: 'algorithmsView.homepage', defaultMessage: 'Upstream docs' },
  license: { id: 'algorithmsView.license', defaultMessage: 'Licence' },
  empty: { id: 'algorithmsView.empty', defaultMessage: 'No methods match that search.' },
  useInSession: { id: 'algorithmsView.useInSession', defaultMessage: 'Try it in a session' },
  sessionFailed: {
    id: 'algorithmsView.sessionFailed',
    defaultMessage: 'Could not start a session for this method',
  },
});

/**
 * Seeds a session that starts by checking dependencies, then asks the agent to write and
 * run a minimal script for this method. The dependency check comes first because the
 * catalogue records packages that are frequently absent, and a failed import halfway
 * through a solve is a confusing way to find that out.
 */
export function methodRequest(entry: AlgorithmEntry): string {
  const lines = [
    `请用「${entry.name}」在当前项目里做一次可运行的测试。`,
    '',
    `调用入口：${entry.entrypoint}`,
  ];
  if (entry.dependencies.length > 0) {
    lines.push(
      `依赖：${entry.dependencies.join('、')}。先检查是否已安装，缺了就装进项目虚拟环境` +
        '（不要动系统 Python），并记录版本。'
    );
  } else {
    lines.push('该方法不需要第三方依赖（自实现或仅用标准科学计算栈）。');
  }
  lines.push(
    `适用场景：${entry.useWhen}`,
    `不适合：${entry.notSuitableFor}`,
    '',
    '请固定随机种子，写一个最小可运行脚本并真的跑出结果；报告每次运行的原始结果与统计量' +
      '（中位数、四分位距、可行率等），不要只给一个最佳值。',
    '',
    '我的问题与数据：',
    '（把问题描述或数据路径写在这里）'
  );
  return lines.join('\n');
}

export default function AlgorithmsView() {
  const intl = useIntl();
  const setView = useNavigation();
  const { extensionsList } = useConfig();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<AlgorithmCategory | 'all'>('all');
  const [selectedId, setSelectedId] = useState(ALGORITHM_CATALOG[0]?.id ?? '');
  const [starting, setStarting] = useState(false);

  const startSession = async (entry: AlgorithmEntry) => {
    setStarting(true);
    try {
      const session = await createSession(getInitialWorkingDir(), {
        allExtensions: extensionsList,
      });
      const initialMessage = { msg: methodRequest(entry), images: [] };
      window.dispatchEvent(new CustomEvent(AppEvents.SESSION_CREATED, { detail: { session } }));
      window.dispatchEvent(
        new CustomEvent(AppEvents.ADD_ACTIVE_SESSION, {
          detail: { sessionId: session.id, initialMessage },
        })
      );
      setView('pair', {
        disableAnimation: true,
        resumeSessionId: session.id,
        initialMessage,
      });
    } catch (error) {
      toastError({
        title: intl.formatMessage(i18n.sessionFailed),
        msg: errorMessage(error, intl.formatMessage(i18n.sessionFailed)),
      });
      setStarting(false);
    }
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return ALGORITHM_CATALOG.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (!needle) return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.summary.toLowerCase().includes(needle) ||
        entry.dependencies.some((dep) => dep.toLowerCase().includes(needle)) ||
        entry.entrypoint.toLowerCase().includes(needle)
      );
    });
  }, [query, category]);

  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0">
        <div className="w-[340px] flex-shrink-0 border-r border-border-secondary flex flex-col min-h-0">
          <div className="px-4 pt-4 pb-3 space-y-3">
            <div>
              <h1 className="text-sm font-medium text-text-primary">
                {intl.formatMessage(i18n.title)}
              </h1>
              <p className="mt-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.subtitle)}
              </p>
            </div>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={intl.formatMessage(i18n.searchPlaceholder)}
              className="w-full rounded-lg border border-border-secondary bg-background-primary px-3 py-1.5 text-sm text-text-primary outline-none focus:border-border-primary"
            />
            <div className="flex flex-wrap gap-1.5">
              <CategoryChip
                label={intl.formatMessage(i18n.all)}
                active={category === 'all'}
                onClick={() => setCategory('all')}
              />
              {ALGORITHM_CATEGORIES.map((value) => (
                <CategoryChip
                  key={value}
                  label={ALGORITHM_CATEGORY_MESSAGES[value]}
                  active={category === value}
                  onClick={() => setCategory(value)}
                />
              ))}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 space-y-1">
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-xs text-text-secondary">
                {intl.formatMessage(i18n.empty)}
              </p>
            )}
            {filtered.map((entry) => (
              <button
                key={entry.id}
                onClick={() => setSelectedId(entry.id)}
                className={cn(
                  'w-full rounded-lg border px-3 py-2 text-left transition-colors',
                  selected?.id === entry.id
                    ? 'border-border-primary bg-background-tertiary'
                    : 'border-transparent hover:bg-background-tertiary/60'
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-sm text-text-primary">{entry.name}</span>
                  <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-secondary bg-background-secondary">
                    {ALGORITHM_CATEGORY_MESSAGES[entry.category]}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-text-secondary">{entry.summary}</p>
                {entry.dependencies.length > 0 && (
                  <div className="mt-1.5 flex items-center gap-1 text-[10px] text-text-warning">
                    <PackagePlus className="w-3 h-3" />
                    <span>{intl.formatMessage(i18n.needsInstall)}</span>
                    <span className="font-mono text-text-tertiary">
                      {entry.dependencies.join(' · ')}
                    </span>
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <article className="px-8 py-6 max-w-3xl">
              <header className="flex items-start gap-3">
                <div className="flex-1">
                  <h2 className="text-xl font-medium text-text-primary">{selected.name}</h2>
                  <p className="mt-1 text-sm text-text-secondary">{selected.summary}</p>
                </div>
                {selected.homepage.startsWith('http') && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.open(selected.homepage, '_blank')}
                  >
                    <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                    {intl.formatMessage(i18n.homepage)}
                  </Button>
                )}
                <Button
                  variant="default"
                  size="sm"
                  disabled={starting}
                  onClick={() => startSession(selected)}
                >
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                  {intl.formatMessage(i18n.useInSession)}
                </Button>
              </header>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.dependencies)}:</dt>
                  <dd className="font-mono text-text-primary">
                    {selected.dependencies.join(', ') || '—'}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.license)}:</dt>
                  <dd className="text-text-primary">{selected.license}</dd>
                </div>
              </dl>

              <div className="mt-5 rounded-xl border border-border-secondary p-4">
                <p className="text-xs text-text-secondary">
                  {intl.formatMessage(i18n.entrypoint)}
                </p>
                <code className="mt-1 block break-all font-mono text-sm text-text-primary">
                  {selected.entrypoint}
                </code>
              </div>

              <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
                <DetailList
                  title={intl.formatMessage(i18n.useWhen)}
                  items={selected.useWhen}
                  marker="·"
                />
                <DetailList
                  title={intl.formatMessage(i18n.dataNeeded)}
                  items={selected.dataNeeded}
                  marker="·"
                />
                <DetailList
                  title={intl.formatMessage(i18n.outputs)}
                  items={selected.outputs}
                  marker="·"
                />
                <DetailList
                  title={intl.formatMessage(i18n.notSuitableFor)}
                  items={selected.notSuitableFor}
                  marker="·"
                />
              </div>
            </article>
          ) : null}
        </div>
      </div>
    </MainPanelLayout>
  );
}

function CategoryChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
        active
          ? 'border-border-primary bg-background-tertiary text-text-primary'
          : 'border-border-secondary text-text-secondary hover:text-text-primary'
      )}
    >
      {label}
    </button>
  );
}

function DetailList({
  title,
  items,
  marker,
}: {
  title: string;
  items: string[];
  marker: string;
}) {
  return (
    <section className="rounded-xl border border-border-secondary p-4">
      <h3 className="text-xs font-medium text-text-primary">{title}</h3>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-sm text-text-secondary">
            <span className="text-text-tertiary">{marker}</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { useMemo, useState } from 'react';
import { Search, Wand2 } from 'lucide-react';
import {
  FIGURE_CATALOG,
  FIGURE_CATEGORIES,
  FIGURE_CATEGORY_LABELS,
  type FigureCategory,
} from '../../catalog/figures';
import { figureTemplateRequest } from '../../utils/figureTemplateRequest';
import { AppEvents } from '../../constants/events';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  search: {
    id: 'figuresPanel.search',
    defaultMessage: 'Search templates',
  },
  all: { id: 'figuresPanel.all', defaultMessage: 'All' },
  insert: { id: 'figuresPanel.insert', defaultMessage: 'Fill the prompt' },
  empty: { id: 'figuresPanel.empty', defaultMessage: 'No matching template' },
  hint: {
    id: 'figuresPanel.hint',
    defaultMessage: 'Picking a template fills the composer; nothing is sent until you press send.',
  },
});

function insertIntoComposer(text: string): void {
  window.dispatchEvent(new CustomEvent(AppEvents.COMPOSER_INSERT, { detail: { text } }));
}

export default function FiguresPanel() {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<FigureCategory | 'all'>('all');

  const categoryLabel = (value: FigureCategory): string => {
    const [zh, en] = FIGURE_CATEGORY_LABELS[value];
    return intl.locale.toLowerCase().startsWith('zh') ? zh : en;
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return FIGURE_CATALOG.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (!needle) return true;
      return (
        entry.title.toLowerCase().includes(needle) ||
        entry.id.toLowerCase().includes(needle) ||
        entry.skill.toLowerCase().includes(needle)
      );
    });
  }, [category, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border-primary px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={intl.formatMessage(i18n.search)}
            className="w-full rounded border border-border-secondary bg-background-primary py-1 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
          />
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button
            type="button"
            onClick={() => setCategory('all')}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] transition-colors',
              category === 'all'
                ? 'bg-background-tertiary text-text-primary'
                : 'text-text-secondary hover:bg-background-tertiary/60'
            )}
          >
            {intl.formatMessage(i18n.all)}
          </button>
          {FIGURE_CATEGORIES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setCategory(value)}
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] transition-colors',
                category === value
                  ? 'bg-background-tertiary text-text-primary'
                  : 'text-text-secondary hover:bg-background-tertiary/60'
              )}
            >
              {categoryLabel(value)}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {filtered.length === 0 && (
          <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
        )}
        <div className="grid grid-cols-1 gap-1">
          {filtered.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => insertIntoComposer(figureTemplateRequest(entry))}
              title={intl.formatMessage(i18n.insert)}
              className="group flex items-start gap-2 rounded border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border-primary hover:bg-background-tertiary/50"
            >
              <Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-tertiary group-hover:text-text-info" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-text-primary">{entry.title}</span>
                <span className="block truncate text-[10px] text-text-tertiary">
                  {entry.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <p className="border-t border-border-primary px-2 py-1 text-[10px] text-text-tertiary">
        {intl.formatMessage(i18n.hint)}
      </p>
    </div>
  );
}

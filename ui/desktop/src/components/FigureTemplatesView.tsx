import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ImageIcon, Wand2 } from 'lucide-react';
import {
  FIGURE_CATALOG,
  FIGURE_CATEGORIES,
  FIGURE_CATEGORY_LABELS,
  figurePreview,
  type FigureCategory,
} from '../catalog/figures';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';
import { seedComposer } from '../utils/composerSeed';
import { figureTemplateRequest } from '../utils/figureTemplateRequest';

const i18n = defineMessages({
  title: { id: 'figuresView.title', defaultMessage: 'Research figures' },
  subtitle: {
    id: 'figuresView.subtitle',
    defaultMessage:
      'Pick a template and the agent writes the plotting script, draws the chart and exports vector PDF/SVG plus a PNG preview.',
  },
  all: { id: 'figuresView.all', defaultMessage: 'All' },
  placeholder: { id: 'figuresView.placeholder', defaultMessage: 'Template not added yet' },
  script: { id: 'figuresView.script', defaultMessage: 'Generating script' },
  depsValue: { id: 'figuresView.depsValue', defaultMessage: 'Requires {deps}' },
  empty: { id: 'figuresView.empty', defaultMessage: 'No templates in this category yet.' },
  total: { id: 'figuresView.total', defaultMessage: '{count} templates' },
  useTemplate: { id: 'figuresView.useTemplate', defaultMessage: 'Use this template' },
  useTemplateHint: {
    id: 'figuresView.useTemplateHint',
    defaultMessage:
      'Fills the home composer with a request for this template; nothing is sent yet.',
  },
  unavailable: {
    id: 'figuresView.unavailable',
    defaultMessage: 'No preview yet — this template needs extra geometry libraries.',
  },
});

export default function FigureTemplatesView() {
  const intl = useIntl();
  const navigate = useNavigate();
  const [category, setCategory] = useState<FigureCategory | 'all'>('all');
  const [selectedId, setSelectedId] = useState(FIGURE_CATALOG[0]?.id ?? '');

  // Category labels are the product's own Chinese headings with an English translation;
  // pick by the active locale rather than duplicating them as i18n messages.
  const categoryLabel = (value: FigureCategory): string => {
    const [zh, en] = FIGURE_CATEGORY_LABELS[value];
    return intl.locale.toLowerCase().startsWith('zh') ? zh : en;
  };

  const filtered = useMemo(
    () => FIGURE_CATALOG.filter((entry) => category === 'all' || entry.category === category),
    [category]
  );

  const selected = filtered.find((entry) => entry.id === selectedId) ?? filtered[0] ?? null;
  const availableCount = FIGURE_CATALOG.filter((entry) => entry.available).length;

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 flex-col">
        <header className="px-6 pt-4 pb-3">
          <h1 className="text-sm font-medium text-text-primary">
            {intl.formatMessage(i18n.title)}
          </h1>
          <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.subtitle)}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <Chip
              label={intl.formatMessage(i18n.all)}
              count={FIGURE_CATALOG.length}
              active={category === 'all'}
              onClick={() => setCategory('all')}
            />
            {FIGURE_CATEGORIES.map((value) => {
              const count = FIGURE_CATALOG.filter((entry) => entry.category === value).length;
              if (!count) return null;
              return (
                <Chip
                  key={value}
                  label={categoryLabel(value)}
                  count={count}
                  active={category === value}
                  onClick={() => setCategory(value)}
                />
              );
            })}
            <span className="ml-auto text-xs text-text-tertiary">
              {intl.formatMessage(i18n.total, { count: availableCount })}
            </span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            {filtered.length === 0 ? (
              <p className="py-6 text-sm text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {filtered.map((entry) => (
                  <button
                    key={entry.id}
                    onClick={() => setSelectedId(entry.id)}
                    className={cn(
                      'group flex flex-col overflow-hidden rounded-xl border text-left transition-colors',
                      selected?.id === entry.id
                        ? 'border-border-primary'
                        : 'border-border-secondary hover:border-border-primary'
                    )}
                  >
                    <Thumbnail
                      label={entry.title}
                      preview={figurePreview(entry)}
                      available={entry.available}
                      className="h-28"
                    />
                    <div className="flex flex-1 flex-col p-3">
                      <div className="flex items-center gap-2">
                        <span className="flex-1 truncate text-sm text-text-primary">
                          {entry.title}
                        </span>
                        <span className="flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] text-text-secondary bg-background-secondary">
                          {categoryLabel(entry.category)}
                        </span>
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-text-secondary">
                        {entry.description}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selected && (
            <aside className="w-[300px] flex-shrink-0 overflow-y-auto border-l border-border-secondary px-4 py-4">
              <h2 className="text-sm font-medium text-text-primary">{selected.title}</h2>
              <p className="mt-1 text-xs text-text-secondary">{selected.description}</p>

              <section className="mt-4">
                <h3 className="text-xs font-medium text-text-primary">
                  {intl.formatMessage(i18n.script)}
                </h3>
                <code className="mt-1.5 block break-all rounded-lg bg-background-secondary px-2 py-1.5 font-mono text-[11px] text-text-secondary">
                  {selected.script || intl.formatMessage(i18n.placeholder)}
                </code>
                {selected.script && (
                  <p className="mt-1.5 text-[11px] text-text-tertiary">
                    {selected.dependencies.length > 0
                      ? intl.formatMessage(i18n.depsValue, {
                          deps: ['matplotlib', ...selected.dependencies].join(', '),
                        })
                      : intl.formatMessage(i18n.depsValue, { deps: 'matplotlib' })}
                  </p>
                )}
              </section>

              <section className="mt-4">
                <button
                  type="button"
                  disabled={!selected.available}
                  onClick={() => {
                    seedComposer(
                      figureTemplateRequest(selected),
                      `figure-${selected.id}-${Date.now()}`
                    );
                    navigate('/');
                  }}
                  className={cn(
                    'flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors',
                    selected.available
                      ? 'border-border-primary text-text-primary hover:bg-background-tertiary'
                      : 'cursor-not-allowed border-border-secondary text-text-tertiary'
                  )}
                >
                  <Wand2 className="h-3.5 w-3.5" />
                  {intl.formatMessage(i18n.useTemplate)}
                </button>
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  {selected.available
                    ? intl.formatMessage(i18n.useTemplateHint)
                    : intl.formatMessage(i18n.unavailable)}
                </p>
              </section>
            </aside>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors',
        active
          ? 'border-border-primary bg-background-tertiary text-text-primary'
          : 'border-border-secondary text-text-secondary hover:text-text-primary'
      )}
    >
      <span>{label}</span>
      <span className="text-text-tertiary">{count}</span>
    </button>
  );
}

/**
 * Renders the template's own output as the thumbnail. Placeholders (no script yet)
 * fall back to a labelled block rather than a stand-in image.
 */
function Thumbnail({
  label,
  preview,
  available,
  className,
}: {
  label: string;
  preview: string;
  available: boolean;
  className?: string;
}) {
  const intl = useIntl();
  return (
    <div
      className={cn(
        'relative flex items-center justify-center overflow-hidden bg-background-secondary',
        className
      )}
    >
      {preview ? (
        <img
          src={preview}
          alt={label}
          loading="lazy"
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <div className="flex flex-col items-center gap-1 text-text-tertiary">
          <ImageIcon className="h-5 w-5" />
          <span className="px-2 text-center text-[11px]">{label}</span>
        </div>
      )}
      {!available && (
        <span className="absolute right-2 top-2 rounded bg-background-primary px-1.5 py-0.5 text-[10px] text-text-tertiary">
          {intl.formatMessage(i18n.placeholder)}
        </span>
      )}
    </div>
  );
}

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { CalendarClock, ExternalLink, Plus, Search, X } from 'lucide-react';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import {
  ALL_STATUSES,
  COMPETITION_CATALOG,
  filterCompetitions,
  formatDate,
  sortCompetitions,
  statusOf,
} from '../../catalog/competitionRules';
import type { CompetitionStatus, LocalDate } from '../../types/catalog';

const i18n = defineMessages({
  title: { id: 'competitions.title', defaultMessage: 'Competitions' },
  subtitle: { id: 'competitions.subtitle', defaultMessage: 'Contest dates and their paper templates' },
  updated: { id: 'competitions.updated', defaultMessage: 'Data updated' },
  status: { id: 'competitions.status', defaultMessage: 'Status' },
  keyword: { id: 'competitions.keyword', defaultMessage: 'Keyword' },
  keywordPlaceholder: { id: 'competitions.keywordPlaceholder', defaultMessage: 'Search by name' },
  empty: { id: 'competitions.empty', defaultMessage: 'No competitions match your filter' },
  clearFilter: { id: 'competitions.clearFilter', defaultMessage: 'Clear filters' },
  organizer: { id: 'competitions.organizer', defaultMessage: 'Organizer' },
  website: { id: 'competitions.website', defaultMessage: 'Website' },
  registration: { id: 'competitions.registration', defaultMessage: 'Registration' },
  contest: { id: 'competitions.contest', defaultMessage: 'Contest' },
  templates: { id: 'competitions.templates', defaultMessage: 'Paper templates' },
  examples: { id: 'competitions.examples', defaultMessage: 'Examples' },
  noTemplates: { id: 'competitions.noTemplates', defaultMessage: 'No matching template' },
  noExamples: { id: 'competitions.noExamples', defaultMessage: 'No examples yet' },
  genericTemplate: { id: 'competitions.genericTemplate', defaultMessage: 'Generic paper template' },
  startPrep: { id: 'competitions.startPrep', defaultMessage: 'Start preparing' },
  projectName: { id: 'competitions.projectName', defaultMessage: 'Project name' },
  projectNamePlaceholder: { id: 'competitions.projectNamePlaceholder', defaultMessage: '1–64 characters' },
  saveLocation: { id: 'competitions.saveLocation', defaultMessage: 'Save location' },
  chooseLocation: { id: 'competitions.chooseLocation', defaultMessage: 'Choose save location' },
  create: { id: 'competitions.create', defaultMessage: 'Create project' },
  cancel: { id: 'competitions.cancel', defaultMessage: 'Cancel' },
  toBeAnnounced: { id: 'competitions.toBeAnnounced', defaultMessage: 'To be announced' },
  statusNotStarted: { id: 'competitions.statusNotStarted', defaultMessage: 'Not started' },
  statusRegistering: { id: 'competitions.statusRegistering', defaultMessage: 'Registration open' },
  statusRunning: { id: 'competitions.statusRunning', defaultMessage: 'Running' },
  statusEnded: { id: 'competitions.statusEnded', defaultMessage: 'Ended' },
});

const STATUS_MESSAGES: Record<CompetitionStatus, { id: string }> = {
  未开始: { id: 'competitions.statusNotStarted' },
  报名中: { id: 'competitions.statusRegistering' },
  进行中: { id: 'competitions.statusRunning' },
  已结束: { id: 'competitions.statusEnded' },
};

function localToday(): LocalDate {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}` as LocalDate;
}

export default function CompetitionsView() {
  const intl = useIntl();
  const navigate = useNavigate();
  const today = localToday();

  const [selectedId, setSelectedId] = useState(COMPETITION_CATALOG.competitions[0]?.id ?? '');
  const [statuses, setStatuses] = useState<CompetitionStatus[]>([]);
  const [keyword, setKeyword] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () => sortCompetitions(filterCompetitions(COMPETITION_CATALOG.competitions, { statuses, keyword }, today), today),
    [statuses, keyword, today]
  );

  const selected = filtered.find((c) => c.id === selectedId) ?? filtered[0] ?? null;

  const toggleStatus = (status: CompetitionStatus): void => {
    setStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status]
    );
  };

  const clearFilters = (): void => {
    setStatuses([]);
    setKeyword('');
  };

  const chooseLocation = async (): Promise<void> => {
    const result = await window.electron.directoryChooser();
    if (!result.canceled && result.filePaths[0]) {
      setParentDir(result.filePaths[0]);
    }
  };

  const submit = async (): Promise<void> => {
    if (!selected) return;
    setCreating(true);
    setError(null);
    const result = await window.electron.projectCreateFromTemplate({
      competitionId: selected.id,
      name: name.trim(),
      parentDir,
    });
    setCreating(false);
    if (result.ok) {
      await window.electron.addRecentDir(result.data.projectDir);
      setDialogOpen(false);
      navigate('/');
    } else {
      setError(result.error.message);
    }
  };

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0">
        <div className="flex w-[340px] flex-shrink-0 flex-col border-r border-border-secondary min-h-0">
          <div className="space-y-3 px-4 pt-4 pb-3">
            <div>
              <h1 className="text-sm font-medium text-text-primary">{intl.formatMessage(i18n.title)}</h1>
              <p className="mt-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.updated)}：{COMPETITION_CATALOG.updatedAt}
              </p>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-text-tertiary">
                {intl.formatMessage(i18n.status)}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {ALL_STATUSES.map((status) => (
                  <button
                    key={status}
                    onClick={() => toggleStatus(status)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                      statuses.includes(status)
                        ? 'border-border-primary bg-background-tertiary text-text-primary'
                        : 'border-border-secondary text-text-secondary hover:text-text-primary'
                    )}
                  >
                    {intl.formatMessage(STATUS_MESSAGES[status])}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-[11px] uppercase tracking-wide text-text-tertiary">
                {intl.formatMessage(i18n.keyword)}
              </div>
              <div className="relative">
                <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-text-tertiary" />
                <input
                  type="text"
                  value={keyword}
                  maxLength={50}
                  placeholder={intl.formatMessage(i18n.keywordPlaceholder)}
                  onChange={(event) => setKeyword(event.target.value)}
                  className="w-full rounded-lg border border-border-secondary bg-background-primary py-1.5 pl-7 pr-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
                />
              </div>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {filtered.length === 0 && (
              <div className="px-3 py-6 text-center">
                <p className="text-xs text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
                <button
                  onClick={clearFilters}
                  className="mt-2 rounded-lg border border-border-secondary px-3 py-1 text-xs text-text-primary hover:bg-background-tertiary"
                >
                  {intl.formatMessage(i18n.clearFilter)}
                </button>
              </div>
            )}
            {filtered.map((competition) => (
              <button
                key={competition.id}
                onClick={() => setSelectedId(competition.id)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                  selected?.id === competition.id
                    ? 'border-border-primary bg-background-tertiary'
                    : 'border-transparent hover:bg-background-tertiary/60'
                )}
              >
                <CalendarClock className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm text-text-primary">{competition.name}</span>
                    <StatusBadge status={statusOf(competition, today)} />
                  </span>
                  <span className="mt-0.5 block text-xs text-text-secondary">
                    {formatDate(competition.contest.start)} – {formatDate(competition.contest.end)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected && (
            <article className="max-w-3xl px-8 py-6">
              <header className="flex items-start gap-3">
                <div className="flex-1">
                  <h2 className="text-xl font-medium text-text-primary">{selected.name}</h2>
                  <StatusBadge status={statusOf(selected, today)} />
                </div>
              </header>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.organizer)}:</dt>
                  <dd className="text-text-primary">{selected.organizer}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.registration)}:</dt>
                  <dd className="text-text-primary">
                    {formatDate(selected.registration.start)} – {formatDate(selected.registration.end)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.contest)}:</dt>
                  <dd className="text-text-primary">
                    {formatDate(selected.contest.start)} – {formatDate(selected.contest.end)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.website)}:</dt>
                  <dd className="text-text-primary">
                    {selected.website ? (
                      <button
                        onClick={() => window.electron.openExternal(selected.website as string)}
                        className="inline-flex items-center gap-1 text-text-primary underline underline-offset-2 hover:text-text-secondary"
                      >
                        {selected.website}
                        <ExternalLink className="h-3 w-3" />
                      </button>
                    ) : (
                      intl.formatMessage(i18n.toBeAnnounced)
                    )}
                  </dd>
                </div>
              </dl>

              <section className="mt-5 rounded-xl border border-border-secondary p-4">
                <h3 className="text-xs font-medium text-text-primary">{intl.formatMessage(i18n.templates)}</h3>
                {selected.templateIds.length > 0 ? (
                  <p className="mt-1.5 text-sm text-text-secondary">{selected.templateIds.join('、')}</p>
                ) : (
                  <p className="mt-1.5 text-sm text-text-secondary">{intl.formatMessage(i18n.noTemplates)}</p>
                )}
                <p className="mt-1 text-[11px] text-text-tertiary">{intl.formatMessage(i18n.genericTemplate)}</p>
              </section>

              <section className="mt-4 rounded-xl border border-border-secondary p-4">
                <h3 className="text-xs font-medium text-text-primary">{intl.formatMessage(i18n.examples)}</h3>
                {selected.exampleIds.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {selected.exampleIds.map((id) => (
                      <button
                        key={id}
                        onClick={() => navigate('/examples')}
                        className="rounded-full border border-border-secondary px-2.5 py-0.5 text-xs text-text-primary hover:bg-background-tertiary"
                      >
                        {id}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 text-sm text-text-secondary">{intl.formatMessage(i18n.noExamples)}</p>
                )}
              </section>

              <section className="mt-4">
                <button
                  type="button"
                  onClick={() => {
                    setName('');
                    setParentDir('');
                    setError(null);
                    setDialogOpen(true);
                  }}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-primary px-3 py-2 text-sm text-text-primary transition-colors hover:bg-background-tertiary"
                >
                  <Plus className="h-4 w-4" />
                  {intl.formatMessage(i18n.startPrep)}
                </button>
              </section>
            </article>
          )}
        </div>
      </div>

      {dialogOpen && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-[420px] rounded-xl border border-border-secondary bg-background-primary p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-text-primary">
                {intl.formatMessage(i18n.startPrep)} · {selected.name}
              </h3>
              <button onClick={() => setDialogOpen(false)} className="text-text-tertiary hover:text-text-primary">
                <X className="h-4 w-4" />
              </button>
            </div>
            <label className="mt-4 block">
              <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.projectName)}</span>
              <input
                type="text"
                value={name}
                maxLength={64}
                placeholder={intl.formatMessage(i18n.projectNamePlaceholder)}
                onChange={(event) => setName(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
              />
            </label>
            <div className="mt-3">
              <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.saveLocation)}</span>
              <div className="mt-1 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-lg border border-border-secondary bg-background-secondary px-2.5 py-1.5 text-xs text-text-secondary">
                  {parentDir || intl.formatMessage(i18n.toBeAnnounced)}
                </span>
                <button
                  onClick={chooseLocation}
                  className="rounded-lg border border-border-secondary px-3 py-1.5 text-xs text-text-primary hover:bg-background-tertiary"
                >
                  {intl.formatMessage(i18n.chooseLocation)}
                </button>
              </div>
            </div>
            {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setDialogOpen(false)}
                className="rounded-lg border border-border-secondary px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary"
              >
                {intl.formatMessage(i18n.cancel)}
              </button>
              <button
                disabled={!name.trim() || name.trim().length > 64 || !parentDir || creating}
                onClick={submit}
                className={cn(
                  'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                  name.trim() && name.trim().length <= 64 && parentDir && !creating
                    ? 'border-border-primary text-text-primary hover:bg-background-tertiary'
                    : 'cursor-not-allowed border-border-secondary text-text-tertiary'
                )}
              >
                {intl.formatMessage(i18n.create)}
              </button>
            </div>
          </div>
        </div>
      )}
    </MainPanelLayout>
  );
}

function StatusBadge({ status }: { status: CompetitionStatus }) {
  const intl = useIntl();
  const color: Record<CompetitionStatus, string> = {
    进行中: 'bg-green-500/15 text-green-600',
    报名中: 'bg-blue-500/15 text-blue-600',
    未开始: 'bg-background-secondary text-text-secondary',
    已结束: 'bg-background-secondary text-text-tertiary',
  };
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px]', color[status])}>
      {intl.formatMessage(STATUS_MESSAGES[status])}
    </span>
  );
}

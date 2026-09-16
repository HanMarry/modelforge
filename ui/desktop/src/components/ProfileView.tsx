import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Flame, FolderOpen, MessageSquare, RefreshCw, ScrollText, Server, Trophy } from 'lucide-react';
import { acpListRecentSessions, type SessionListItem } from '../acp/sessions';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import { Button } from './ui/button';
import { defineMessages, useIntl } from '../i18n';
import { cn } from '../utils';

const i18n = defineMessages({
  title: { id: 'profileView.title', defaultMessage: 'Profile' },
  subtitle: {
    id: 'profileView.subtitle',
    defaultMessage: 'Local usage on this machine, derived from your session list.',
  },
  refresh: { id: 'profileView.refresh', defaultMessage: 'Refresh' },
  loading: { id: 'profileView.loading', defaultMessage: 'Loading statistics…' },
  error: { id: 'profileView.error', defaultMessage: 'Could not load session statistics.' },
  statSessions: { id: 'profileView.statSessions', defaultMessage: 'Sessions' },
  statMessages: { id: 'profileView.statMessages', defaultMessage: 'Prompts' },
  statActiveDays: { id: 'profileView.statActiveDays', defaultMessage: 'Active days' },
  statProjects: { id: 'profileView.statProjects', defaultMessage: 'Projects' },
  statStreakCurrent: { id: 'profileView.statStreakCurrent', defaultMessage: 'Current streak' },
  statStreakLongest: { id: 'profileView.statStreakLongest', defaultMessage: 'Longest streak' },
  daysValue: { id: 'profileView.daysValue', defaultMessage: '{count} days' },
  modelUsage: { id: 'profileView.modelUsage', defaultMessage: 'Model usage' },
  modelUsageHint: {
    id: 'profileView.modelUsageHint',
    defaultMessage: 'Share of sessions per model.',
  },
  statSpan: { id: 'profileView.statSpan', defaultMessage: 'History span' },
  spanValue: { id: 'profileView.spanValue', defaultMessage: '{days} days' },
  spanUnknown: { id: 'profileView.spanUnknown', defaultMessage: '—' },
  activity: { id: 'profileView.activity', defaultMessage: 'Activity' },
  activityHint: {
    id: 'profileView.activityHint',
    defaultMessage: 'Prompts per day over the last year.',
  },
  less: { id: 'profileView.less', defaultMessage: 'Less' },
  more: { id: 'profileView.more', defaultMessage: 'More' },
  providers: { id: 'profileView.providers', defaultMessage: 'Most used providers' },
  models: { id: 'profileView.models', defaultMessage: 'Most used models' },
  projects: { id: 'profileView.projects', defaultMessage: 'Most used projects' },
  recipes: { id: 'profileView.recipes', defaultMessage: 'Sessions using a recipe' },
  none: { id: 'profileView.none', defaultMessage: 'No data yet' },
  tokensNote: {
    id: 'profileView.tokensNote',
    defaultMessage:
      'Token and cost totals are per session — open a chat to see its usage. Aggregating them across every session needs a local usage store, which this build does not have yet.',
  },
  countValue: { id: 'profileView.countValue', defaultMessage: '{count}' },
});

/** How many sessions to pull when computing the statistics. */
const SESSION_SAMPLE = 500;

interface Stats {
  sessions: number;
  prompts: number;
  projects: string[];
  providers: [string, number][];
  models: [string, number][];
  recipeSessions: number;
  activeDays: Map<string, number>;
  firstDay: string | null;
  lastDay: string | null;
  providerReported: number;
  currentStreak: number;
  longestStreak: number;
}

const dayKeyFromDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;

const dayKey = (value: string | undefined): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return dayKeyFromDate(date);
};

/**
 * Consecutive active days. The current streak counts back from today, but a day with no
 * activity yet does not break it — otherwise every streak would read 0 until the user
 * sends their first prompt of the day.
 */
function streaks(activeDays: Map<string, number>): { current: number; longest: number } {
  const days = [...activeDays.entries()]
    .filter(([, count]) => count > 0)
    .map(([key]) => key)
    .sort();
  if (days.length === 0) return { current: 0, longest: 0 };

  let longest = 1;
  let run = 1;
  for (let index = 1; index < days.length; index++) {
    const previous = new Date(`${days[index - 1]}T00:00:00`).getTime();
    const current = new Date(`${days[index]}T00:00:00`).getTime();
    run = current - previous === 86_400_000 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  const active = new Set(days);
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  if (!active.has(dayKeyFromDate(cursor))) cursor.setDate(cursor.getDate() - 1);
  let current = 0;
  while (active.has(dayKeyFromDate(cursor))) {
    current++;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { current, longest };
}

const tally = (values: Array<string | undefined>): [string, number][] => {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
};

function computeStats(sessions: SessionListItem[]): Stats {
  const activeDays = new Map<string, number>();
  let prompts = 0;
  let recipeSessions = 0;
  let providerReported = 0;
  const projects = new Set<string>();
  const days: string[] = [];

  for (const session of sessions) {
    prompts += session.messageCount ?? 0;
    if (session.hasRecipe) recipeSessions++;
    if (session.providerId) providerReported++;
    if (session.workingDir) projects.add(session.workingDir);

    // A session's prompts are attributed to the day it was last active, which is
    // the only per-day signal the session list carries.
    const key = dayKey(session.lastMessageAt ?? session.updatedAt ?? session.createdAt);
    if (key) {
      activeDays.set(key, (activeDays.get(key) ?? 0) + (session.messageCount ?? 0));
      days.push(key);
    }
  }

  days.sort();
  const { current: currentStreak, longest: longestStreak } = streaks(activeDays);
  return {
    sessions: sessions.length,
    prompts,
    projects: [...projects].sort(),
    providers: tally(sessions.map((s) => s.providerId)),
    models: tally(sessions.map((s) => s.modelId)),
    recipeSessions,
    activeDays,
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
    providerReported,
    currentStreak,
    longestStreak,
  };
}

export default function ProfileView() {
  const intl = useIntl();
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const list = await acpListRecentSessions(SESSION_SAMPLE);
      setSessions(list);
    } catch (loadError) {
      console.error('Failed to load sessions for profile:', loadError);
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => (sessions ? computeStats(sessions) : null), [sessions]);

  const spanDays = useMemo(() => {
    if (!stats?.firstDay || !stats.lastDay) return null;
    const from = new Date(`${stats.firstDay}T00:00:00`).getTime();
    const to = new Date(`${stats.lastDay}T00:00:00`).getTime();
    return Math.max(1, Math.round((to - from) / 86_400_000) + 1);
  }, [stats]);

  return (
    <MainPanelLayout>
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-6">
          <header className="flex items-start gap-3">
            <div className="flex-1">
              <h1 className="text-xl font-medium text-text-primary">
                {intl.formatMessage(i18n.title)}
              </h1>
              <p className="mt-1 text-sm text-text-secondary">
                {intl.formatMessage(i18n.subtitle)}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn('mr-1.5 h-3.5 w-3.5', loading && 'animate-spin')} />
              {intl.formatMessage(i18n.refresh)}
            </Button>
          </header>

          {loading && !stats && (
            <p className="mt-8 text-sm text-text-secondary">
              {intl.formatMessage(i18n.loading)}
            </p>
          )}

          {error && (
            <p className="mt-8 text-sm text-text-danger">{intl.formatMessage(i18n.error)}</p>
          )}

          {stats && (
            <>
              <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatCard
                  icon={<MessageSquare className="h-4 w-4" />}
                  label={intl.formatMessage(i18n.statSessions)}
                  value={String(stats.sessions)}
                />
                <StatCard
                  icon={<ScrollText className="h-4 w-4" />}
                  label={intl.formatMessage(i18n.statMessages)}
                  value={String(stats.prompts)}
                />
                <StatCard
                  icon={<CalendarDays className="h-4 w-4" />}
                  label={intl.formatMessage(i18n.statActiveDays)}
                  value={String(stats.activeDays.size)}
                />
                <StatCard
                  icon={<Flame className="h-4 w-4" />}
                  label={intl.formatMessage(i18n.statStreakCurrent)}
                  value={intl.formatMessage(i18n.daysValue, { count: stats.currentStreak })}
                />
                <StatCard
                  icon={<Trophy className="h-4 w-4" />}
                  label={intl.formatMessage(i18n.statStreakLongest)}
                  value={intl.formatMessage(i18n.daysValue, { count: stats.longestStreak })}
                />
                <StatCard
                  icon={<FolderOpen className="h-4 w-4" />}
                  label={intl.formatMessage(i18n.statProjects)}
                  value={String(stats.projects.length)}
                />
              </div>

              <section className="mt-6 rounded-xl border border-border-secondary p-4">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-medium text-text-primary">
                    {intl.formatMessage(i18n.activity)}
                  </h2>
                  <span className="text-xs text-text-tertiary">
                    {intl.formatMessage(i18n.activityHint)}
                  </span>
                  <span className="ml-auto text-xs text-text-secondary">
                    {spanDays
                      ? intl.formatMessage(i18n.spanValue, { days: spanDays })
                      : intl.formatMessage(i18n.spanUnknown)}
                  </span>
                </div>
                <Heatmap activeDays={stats.activeDays} />
              </section>

              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <RankList
                  icon={<Server className="h-3.5 w-3.5" />}
                  title={intl.formatMessage(i18n.providers)}
                  entries={stats.providers}
                  emptyLabel={intl.formatMessage(i18n.none)}
                />
                <RankList
                  icon={<ScrollText className="h-3.5 w-3.5" />}
                  title={intl.formatMessage(i18n.models)}
                  entries={stats.models}
                  emptyLabel={intl.formatMessage(i18n.none)}
                />
                <RankList
                  icon={<FolderOpen className="h-3.5 w-3.5" />}
                  title={intl.formatMessage(i18n.projects)}
                  entries={stats.projects.slice(0, 8).map((path) => [path, 0])}
                  emptyLabel={intl.formatMessage(i18n.none)}
                  hideCount
                />
                <RankList
                  icon={<ScrollText className="h-3.5 w-3.5" />}
                  title={intl.formatMessage(i18n.recipes)}
                  entries={[]}
                  emptyLabel={intl.formatMessage(i18n.countValue, {
                    count: stats.recipeSessions,
                  })}
                  summaryValue={String(stats.recipeSessions)}
                />
              </div>

              <section className="mt-4 rounded-xl border border-border-secondary p-4">
                <div className="flex items-baseline gap-2">
                  <h2 className="text-sm font-medium text-text-primary">
                    {intl.formatMessage(i18n.modelUsage)}
                  </h2>
                  <span className="text-xs text-text-tertiary">
                    {intl.formatMessage(i18n.modelUsageHint)}
                  </span>
                </div>
                {stats.models.length === 0 ? (
                  <p className="mt-2 text-xs text-text-tertiary">
                    {intl.formatMessage(i18n.none)}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {stats.models.slice(0, 6).map(([name, count]) => {
                      const share = stats.models.reduce((sum, [, value]) => sum + value, 0);
                      const percent = share ? (count / share) * 100 : 0;
                      return (
                        <li key={name}>
                          <div className="flex items-baseline gap-2 text-xs">
                            <span className="min-w-0 flex-1 truncate text-text-secondary" title={name}>
                              {name}
                            </span>
                            <span className="flex-shrink-0 tabular-nums text-text-primary">
                              {percent.toFixed(1)}%
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-background-secondary">
                            <div
                              className="h-full rounded-full bg-text-secondary"
                              style={{ width: `${Math.max(2, percent)}%` }}
                            />
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>

              <p className="mt-4 text-xs text-text-tertiary">
                {intl.formatMessage(i18n.tokensNote)}
              </p>
            </>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-border-secondary p-3">
      <div className="flex items-center gap-1.5 text-text-tertiary">
        {icon}
        <span className="text-[11px]">{label}</span>
      </div>
      <p className="mt-1.5 text-2xl font-light tabular-nums text-text-primary">{value}</p>
    </div>
  );
}

function RankList({
  icon,
  title,
  entries,
  emptyLabel,
  hideCount = false,
  summaryValue,
}: {
  icon: React.ReactNode;
  title: string;
  entries: [string, number][];
  emptyLabel: string;
  hideCount?: boolean;
  summaryValue?: string;
}) {
  return (
    <section className="rounded-xl border border-border-secondary p-4">
      <h2 className="flex items-center gap-1.5 text-xs font-medium text-text-primary">
        {icon}
        {title}
        {summaryValue && (
          <span className="ml-auto text-sm font-normal tabular-nums text-text-primary">
            {summaryValue}
          </span>
        )}
      </h2>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-text-tertiary">{emptyLabel}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {entries.map(([name, count]) => (
            <li key={name} className="flex items-baseline gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-text-secondary" title={name}>
                {name}
              </span>
              {!hideCount && (
                <span className="flex-shrink-0 tabular-nums text-text-primary">{count}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One column per week for the trailing year. Sessions are attributed to a single
 * day, so a cell reflects prompts recorded on that day rather than hourly detail.
 */
function Heatmap({ activeDays }: { activeDays: Map<string, number> }) {
  const intl = useIntl();
  const { weeks, monthLabels, counts } = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const totalDays = 364;
    // Start on the Sunday on or before (today - 364 days) so rows line up with weekdays.
    const start = new Date(today);
    start.setDate(start.getDate() - totalDays);
    start.setDate(start.getDate() - start.getDay());

    const columns: Array<Array<{ key: string; count: number; future: boolean }>> = [];
    const labels: Array<{ index: number; text: string }> = [];
    const values: number[] = [];
    let lastMonth = -1;

    const cursor = new Date(start);
    while (cursor <= today) {
      const column: Array<{ key: string; count: number; future: boolean }> = [];
      for (let weekday = 0; weekday < 7; weekday++) {
        const key = dayKey(cursor.toISOString());
        const count = key ? (activeDays.get(key) ?? 0) : 0;
        const future = cursor > today;
        column.push({ key: key ?? '', count, future });
        if (!future) values.push(count);
        cursor.setDate(cursor.getDate() + 1);
      }
      if (column.some((cell) => !cell.future)) {
        const first = column.find((cell) => !cell.future);
        if (first) {
          const month = new Date(`${first.key}T00:00:00`).getMonth();
          if (month !== lastMonth) {
            labels.push({ index: columns.length, text: `${month + 1}月` });
            lastMonth = month;
          }
        }
      }
      columns.push(column);
    }

    return { weeks: columns, monthLabels: labels, counts: values };
  }, [activeDays]);

  const max = Math.max(1, ...counts);
  const level = (count: number) => {
    if (count <= 0) return 0;
    const ratio = count / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };

  const levels = [
    'bg-background-tertiary',
    'bg-green-100/30',
    'bg-green-100/50',
    'bg-green-200/70',
    'bg-green-200',
  ];

  return (
    <div className="mt-3">
      <div className="overflow-x-auto">
        <div className="inline-block">
          <div className="mb-1 flex gap-[3px]">
            {weeks.map((_, index) => {
              const label = monthLabels.find((entry) => entry.index === index);
              return (
                <span key={index} className="w-[10px] text-[9px] leading-3 text-text-tertiary">
                  {label ? label.text : ''}
                </span>
              );
            })}
          </div>
          <div className="flex gap-[3px]">
            {weeks.map((column, columnIndex) => (
              <div key={columnIndex} className="flex flex-col gap-[3px]">
                {column.map((cell) =>
                  cell.future ? (
                    <span key={cell.key} className="h-[10px] w-[10px]" />
                  ) : (
                    <span
                      key={cell.key}
                      title={`${cell.key}: ${cell.count}`}
                      className={cn('h-[10px] w-[10px] rounded-[2px]', levels[level(cell.count)])}
                    />
                  )
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-text-tertiary">
        <span>{intl.formatMessage(i18n.less)}</span>
        {levels.map((className, index) => (
          <span key={index} className={cn('h-[10px] w-[10px] rounded-[2px]', className)} />
        ))}
        <span>{intl.formatMessage(i18n.more)}</span>
      </div>
    </div>
  );
}

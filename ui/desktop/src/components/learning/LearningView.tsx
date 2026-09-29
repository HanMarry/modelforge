import { useCallback, useEffect, useMemo, useState } from 'react';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { Button } from '../ui/button';
import { defineMessages, useIntl } from '../../i18n';
import { cn } from '../../utils';
import type { LearningCatalog, LearningExercise } from '../../types/learningApi';
import { progressByGroup, type ExerciseRecord } from '../../utils/learning/progress';
import { ExerciseStatusBadge } from './ExerciseStatusBadge';
import LearningExercisePage from './LearningExercisePage';
import LearningProgressPanel from './LearningProgressPanel';

const i18n = defineMessages({
  title: { id: 'learning.title', defaultMessage: 'Learning Path' },
  subtitle: {
    id: 'learning.view.subtitle',
    defaultMessage:
      'Five course groups, each with exercises that are checked when you submit your results.',
  },
  tabs: { id: 'learning.view.tabs', defaultMessage: 'Learning path sections' },
  tabCourses: { id: 'learning.view.tabCourses', defaultMessage: 'Courses' },
  tabProfile: { id: 'learning.view.tabProfile', defaultMessage: 'My progress' },
  loading: { id: 'learning.view.loading', defaultMessage: 'Loading the learning path…' },
  loadFailed: {
    id: 'learning.view.loadFailed',
    defaultMessage: 'Could not load the learning path: {message}',
  },
  retry: { id: 'learning.view.retry', defaultMessage: 'Try again' },
  groupProgress: {
    id: 'learning.view.groupProgress',
    defaultMessage: '{completed} / {total} completed',
  },
  objectives: { id: 'learning.view.objectives', defaultMessage: 'Learning objectives' },
  skills: { id: 'learning.view.skills', defaultMessage: 'Linked skills' },
  exercises: { id: 'learning.view.exercises', defaultMessage: 'Exercises' },
});

type Tab = 'courses' | 'profile';

type LoadState =
  | { phase: 'loading' }
  | { phase: 'failed'; message: string }
  | { phase: 'ready'; catalog: LearningCatalog };

function findExercise(catalog: LearningCatalog, id: string): LearningExercise | undefined {
  for (const group of catalog.groups) {
    for (const course of group.courses) {
      const exercise = course.exercises.find((entry) => entry.id === id);
      if (exercise) return exercise;
    }
  }
  return undefined;
}

function withRecord(records: readonly ExerciseRecord[], record: ExerciseRecord): ExerciseRecord[] {
  const others = records.filter((entry) => entry.exerciseId !== record.exerciseId);
  return [...others, record];
}

/**
 * Learning path page at `/learning` (requirement 20, task 27.6): the course groups with their
 * courses and exercises, one exercise at a time, and the profile page with the progress of each
 * group. Records come from `userData/learning-progress.json` through the main process, so they
 * survive restarts.
 */
export default function LearningView() {
  const intl = useIntl();
  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  const [records, setRecords] = useState<ExerciseRecord[]>([]);
  const [tab, setTab] = useState<Tab>('courses');
  const [openExerciseId, setOpenExerciseId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoad({ phase: 'loading' });
    try {
      const [catalog, progress] = await Promise.all([
        window.electron.learningCatalog(),
        window.electron.learningProgressGet(),
      ]);
      if (!catalog.ok) {
        setLoad({ phase: 'failed', message: catalog.error.message });
      } else if (!progress.ok) {
        setLoad({ phase: 'failed', message: progress.error.message });
      } else {
        setRecords(progress.data);
        setLoad({ phase: 'ready', catalog: catalog.data });
      }
    } catch (error) {
      setLoad({ phase: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const recordById = useMemo(
    () => new Map(records.map((record) => [record.exerciseId, record])),
    [records]
  );
  const updateRecord = useCallback((record: ExerciseRecord) => {
    setRecords((current) => withRecord(current, record));
  }, []);

  const catalog = load.phase === 'ready' ? load.catalog : null;
  const openExercise = catalog && openExerciseId ? findExercise(catalog, openExerciseId) : undefined;
  const groupProgress = useMemo(
    () => (catalog ? new Map(progressByGroup(records, catalog).map((p) => [p.groupId, p])) : null),
    [catalog, records]
  );

  const tabButton = (value: Tab, label: string) => (
    <button
      role="tab"
      id={`learning-tab-${value}`}
      aria-selected={tab === value}
      aria-controls={`learning-panel-${value}`}
      onClick={() => setTab(value)}
      className={cn(
        'rounded-lg px-3 py-1.5 text-xs transition-colors',
        tab === value
          ? 'bg-background-tertiary text-text-primary'
          : 'text-text-secondary hover:text-text-primary'
      )}
    >
      {label}
    </button>
  );

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-4 pt-4 pb-3">
          <h1 className="text-sm font-medium text-text-primary">
            {intl.formatMessage(i18n.title)}
          </h1>
          <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.subtitle)}</p>
          <div
            role="tablist"
            aria-label={intl.formatMessage(i18n.tabs)}
            className="mt-3 flex gap-1"
          >
            {tabButton('courses', intl.formatMessage(i18n.tabCourses))}
            {tabButton('profile', intl.formatMessage(i18n.tabProfile))}
          </div>
        </div>

        <div
          role="tabpanel"
          id={`learning-panel-${tab}`}
          aria-labelledby={`learning-tab-${tab}`}
          className="min-h-0 flex-1 overflow-y-auto border-t border-border-secondary"
        >
          {load.phase === 'loading' && (
            <p className="px-6 py-5 text-xs text-text-secondary">
              {intl.formatMessage(i18n.loading)}
            </p>
          )}
          {load.phase === 'failed' && (
            <div role="alert" className="flex items-center gap-3 px-6 py-5">
              <p className="text-xs text-red-500">
                {intl.formatMessage(i18n.loadFailed, { message: load.message })}
              </p>
              <Button variant="outline" size="sm" onClick={() => void reload()}>
                {intl.formatMessage(i18n.retry)}
              </Button>
            </div>
          )}

          {catalog && tab === 'profile' && (
            <LearningProgressPanel catalog={catalog} records={records} />
          )}

          {catalog && tab === 'courses' && openExercise && (
            <LearningExercisePage
              key={openExercise.id}
              exercise={openExercise}
              record={recordById.get(openExercise.id)}
              onRecordChange={updateRecord}
              onClose={() => setOpenExerciseId(null)}
            />
          )}

          {catalog && tab === 'courses' && !openExercise && (
            <div className="max-w-3xl space-y-6 px-6 py-5">
              {catalog.groups.map((group) => {
                const progress = groupProgress?.get(group.id);
                return (
                  <section key={group.id} aria-labelledby={`learning-group-${group.id}`}>
                    <div className="flex items-baseline justify-between gap-3">
                      <h2
                        id={`learning-group-${group.id}`}
                        className="text-sm font-medium text-text-primary"
                      >
                        {group.title}
                      </h2>
                      {progress && (
                        <span className="text-xs text-text-secondary">
                          {intl.formatMessage(i18n.groupProgress, {
                            completed: progress.completed,
                            total: progress.total,
                          })}
                        </span>
                      )}
                    </div>
                    <div className="mt-2 space-y-3">
                      {group.courses.map((course) => (
                        <div
                          key={course.id}
                          className="rounded-xl border border-border-secondary px-4 py-3"
                        >
                          <h3 className="text-sm text-text-primary">{course.title}</h3>
                          <p className="mt-2 text-xs font-medium text-text-secondary">
                            {intl.formatMessage(i18n.objectives)}
                          </p>
                          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-text-primary">
                            {course.objectives.map((objective) => (
                              <li key={objective}>{objective}</li>
                            ))}
                          </ul>
                          <p className="mt-2 text-xs font-medium text-text-secondary">
                            {intl.formatMessage(i18n.skills)}
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {course.skills.map((skill) => (
                              <span
                                key={skill}
                                className="rounded bg-background-secondary px-1.5 py-0.5 font-mono text-[11px] text-text-secondary"
                              >
                                {skill}
                              </span>
                            ))}
                          </div>
                          <p className="mt-2 text-xs font-medium text-text-secondary">
                            {intl.formatMessage(i18n.exercises)}
                          </p>
                          <ul className="mt-1 space-y-1">
                            {course.exercises.map((exercise) => (
                              <li key={exercise.id}>
                                <button
                                  onClick={() => setOpenExerciseId(exercise.id)}
                                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-sm text-text-primary hover:border-border-secondary hover:bg-background-tertiary/60"
                                >
                                  <span className="min-w-0 flex-1 truncate">{exercise.title}</span>
                                  <ExerciseStatusBadge record={recordById.get(exercise.id)} />
                                </button>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}

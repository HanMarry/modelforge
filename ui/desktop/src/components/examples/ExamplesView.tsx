import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { BookOpen, ExternalLink, FolderOpen, X } from 'lucide-react';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import type { ExampleEntry } from '../../types/catalog';
import { requestOpenProject } from '../../utils/pendingProject';

const i18n = defineMessages({
  title: { id: 'examples.title', defaultMessage: 'Example library' },
  subtitle: { id: 'examples.subtitle', defaultMessage: 'Pick an example and follow it through' },
  category: { id: 'examples.category', defaultMessage: 'Category' },
  source: { id: 'examples.source', defaultMessage: 'Source' },
  license: { id: 'examples.license', defaultMessage: 'License' },
  open: { id: 'examples.open', defaultMessage: 'Open' },
  download: { id: 'examples.download', defaultMessage: 'Download required' },
  officialSource: { id: 'examples.officialSource', defaultMessage: 'Official source' },
  downloadHint: { id: 'examples.downloadHint', defaultMessage: 'Download the statement and attachments to get started' },
  solution: { id: 'examples.solution', defaultMessage: 'Reference approach' },
  chooseLocation: { id: 'examples.chooseLocation', defaultMessage: 'Choose save location' },
  create: { id: 'examples.create', defaultMessage: 'Create and open' },
  cancel: { id: 'examples.cancel', defaultMessage: 'Cancel' },
  empty: { id: 'examples.empty', defaultMessage: 'No examples available' },
  loading: { id: 'examples.loading', defaultMessage: 'Loading…' },
});

export default function ExamplesView() {
  const intl = useIntl();
  const navigate = useNavigate();
  // A home card names the problem it stands for, so arriving from one selects it.
  const requestedId = (useLocation().state as { exampleId?: string } | null)?.exampleId ?? null;
  const [entries, setEntries] = useState<ExampleEntry[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(requestedId);
  const [parentDir, setParentDir] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [solution, setSolution] = useState<{ question: string; content: string }[] | null>(null);
  const [solutionOpen, setSolutionOpen] = useState(false);

  useEffect(() => {
    window.electron
      .examplesList()
      .then((list) => {
        setEntries(list);
        setSelectedId((current) => current ?? list[0]?.manifest.id ?? null);
      })
      .catch(() => setEntries([]));
  }, []);

  const selected = entries?.find((e) => e.manifest.id === selectedId) ?? null;

  const chooseLocation = async (): Promise<void> => {
    const result = await window.electron.directoryChooser();
    if (!result.canceled && result.filePaths[0]) {
      setParentDir(result.filePaths[0]);
    }
  };

  const openExample = async (): Promise<void> => {
    if (!selected) return;
    setChoosing(true);
    setError(null);
    const result = await window.electron.projectCreateFromExample({
      exampleId: selected.manifest.id,
      name: selected.manifest.title,
      parentDir,
    });
    setChoosing(false);
    if (result.ok) {
      await window.electron.addRecentDir(result.data.projectDir);
      requestOpenProject(result.data.projectDir);
      navigate('/');
    } else {
      setError(result.error.message);
    }
  };

  const openSolution = async (): Promise<void> => {
    if (!selected) return;
    const result = await window.electron.exampleOpenSolution(selected.manifest.id);
    if (result.ok) {
      setSolution(result.data.sections);
      setSolutionOpen(true);
    }
  };

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0">
        <div className="flex w-[340px] flex-shrink-0 flex-col border-r border-border-secondary min-h-0">
          <div className="px-4 pt-4 pb-3">
            <h1 className="text-sm font-medium text-text-primary">{intl.formatMessage(i18n.title)}</h1>
            <p className="mt-1 text-xs text-text-secondary">{intl.formatMessage(i18n.subtitle)}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {entries === null && (
              <p className="px-3 py-4 text-xs text-text-secondary">{intl.formatMessage(i18n.loading)}</p>
            )}
            {entries?.length === 0 && (
              <p className="px-3 py-4 text-xs text-text-secondary">{intl.formatMessage(i18n.empty)}</p>
            )}
            {entries?.map((entry) => (
              <button
                key={entry.manifest.id}
                onClick={() => setSelectedId(entry.manifest.id)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                  selected?.manifest.id === entry.manifest.id
                    ? 'border-border-primary bg-background-tertiary'
                    : 'border-transparent hover:bg-background-tertiary/60'
                )}
              >
                <BookOpen className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-text-primary">{entry.manifest.title}</span>
                  <span className="mt-0.5 block text-xs text-text-secondary">{entry.manifest.category}</span>
                  {entry.needsDownload && (
                    <span className="mt-1 inline-block rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                      {intl.formatMessage(i18n.download)}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected && (
            <article className="max-w-3xl px-8 py-6">
              <h2 className="text-xl font-medium text-text-primary">{selected.manifest.title}</h2>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.category)}:</dt>
                  <dd className="text-text-primary">{selected.manifest.category}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.source)}:</dt>
                  <dd className="text-text-primary">{selected.manifest.source}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.license)}:</dt>
                  <dd className="text-text-primary">{selected.manifest.license.type}</dd>
                </div>
              </dl>

              <p className="mt-3 text-xs text-text-secondary">{selected.manifest.license.note}</p>

              {selected.needsDownload ? (
                <section className="mt-5 rounded-xl border border-border-secondary p-4">
                  <h3 className="text-xs font-medium text-text-primary">{intl.formatMessage(i18n.officialSource)}</h3>
                  {selected.manifest.officialUrl ? (
                    <button
                      onClick={() => window.electron.openExternal(selected.manifest?.officialUrl as string)}
                      className="mt-1.5 inline-flex items-center gap-1 text-sm text-text-primary underline underline-offset-2 hover:text-text-secondary"
                    >
                      {selected.manifest.officialUrl}
                      <ExternalLink className="h-3 w-3" />
                    </button>
                  ) : (
                    <p className="mt-1.5 text-sm text-text-secondary">—</p>
                  )}
                  <p className="mt-2 text-xs text-text-secondary">{intl.formatMessage(i18n.downloadHint)}</p>
                </section>
              ) : (
                <section className="mt-5 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate rounded-lg border border-border-secondary bg-background-secondary px-2.5 py-1.5 text-xs text-text-secondary">
                      {parentDir || intl.formatMessage(i18n.chooseLocation)}
                    </span>
                    <button
                      onClick={chooseLocation}
                      className="rounded-lg border border-border-secondary px-3 py-1.5 text-xs text-text-primary hover:bg-background-tertiary"
                    >
                      <FolderOpen className="mr-1 inline h-3.5 w-3.5" />
                      {intl.formatMessage(i18n.chooseLocation)}
                    </button>
                  </div>
                  {error && <p className="text-xs text-red-500">{error}</p>}
                  <button
                    disabled={!parentDir || choosing}
                    onClick={openExample}
                    className={cn(
                      'flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                      parentDir && !choosing
                        ? 'border-border-primary text-text-primary hover:bg-background-tertiary'
                        : 'cursor-not-allowed border-border-secondary text-text-tertiary'
                    )}
                  >
                    {intl.formatMessage(i18n.create)}
                  </button>
                </section>
              )}

              <section className="mt-4">
                <button
                  onClick={openSolution}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-secondary px-3 py-2 text-sm text-text-secondary transition-colors hover:border-border-primary hover:text-text-primary"
                >
                  <BookOpen className="h-4 w-4" />
                  {intl.formatMessage(i18n.solution)}
                </button>
              </section>
            </article>
          )}
        </div>
      </div>

      {solutionOpen && solution && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="flex max-h-[80vh] w-[560px] flex-col rounded-xl border border-border-secondary bg-background-primary">
            <div className="flex items-center justify-between border-b border-border-secondary px-5 py-3">
              <h3 className="text-sm font-medium text-text-primary">{intl.formatMessage(i18n.solution)}</h3>
              <button onClick={() => setSolutionOpen(false)} className="text-text-tertiary hover:text-text-primary">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {solution.map((section, index) => (
                <section key={index} className="mb-4">
                  <h4 className="text-sm font-medium text-text-primary">{section.question}</h4>
                  <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-text-secondary">{section.content}</pre>
                </section>
              ))}
            </div>
          </div>
        </div>
      )}
    </MainPanelLayout>
  );
}

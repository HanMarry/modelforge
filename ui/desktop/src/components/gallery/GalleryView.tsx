import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Download, RefreshCw, Upload } from 'lucide-react';
import type { GalleryResult, GalleryWork } from '../../utils/gallery/galleryService';
import { truncateText } from '../../utils/textTruncate';
import { defineMessages, useIntl } from '../../i18n';
import GalleryPdfThumb from './GalleryPdfThumb';

const TITLE_LIMIT = 200;
const ABSTRACT_LIMIT = 300;

const i18n = defineMessages({
  title: { id: 'gallery.title', defaultMessage: 'Gallery' },
  empty: { id: 'gallery.empty', defaultMessage: 'No works yet' },
  import: { id: 'gallery.import', defaultMessage: 'Import' },
  refresh: { id: 'gallery.refresh', defaultMessage: 'Refresh' },
  remoteLabel: { id: 'gallery.remoteLabel', defaultMessage: 'Remote works source' },
  remoteUnreachable: { id: 'gallery.remoteUnreachable', defaultMessage: 'Remote service unreachable' },
  notFilled: { id: 'gallery.notFilled', defaultMessage: 'Not filled in' },
  localSource: { id: 'gallery.localSource', defaultMessage: 'Local' },
  importedSource: { id: 'gallery.importedSource', defaultMessage: 'Local import' },
  remoteSource: { id: 'gallery.remoteSource', defaultMessage: 'Remote' },
  export: { id: 'gallery.export', defaultMessage: 'Export share package' },
  noPdf: { id: 'gallery.noPdf', defaultMessage: 'No exportable paper PDF' },
  exportSaved: { id: 'gallery.exportSaved', defaultMessage: 'Saved to {path}' },
  exportConfirm: { id: 'gallery.exportConfirm', defaultMessage: 'Export' },
  exportCancel: { id: 'gallery.exportCancel', defaultMessage: 'Cancel' },
  candidates: { id: 'gallery.candidates', defaultMessage: 'Files to include' },
  excludedNote: { id: 'gallery.excludedNote', defaultMessage: 'Some files are always excluded' },
  metadataTitle: { id: 'gallery.metadataTitle', defaultMessage: 'Title' },
  metadataCompetition: { id: 'gallery.metadataCompetition', defaultMessage: 'Competition' },
  metadataCategory: { id: 'gallery.metadataCategory', defaultMessage: 'Category' },
  metadataAbstract: { id: 'gallery.metadataAbstract', defaultMessage: 'Abstract' },
});

interface Candidates {
  candidates: string[];
  excluded: { path: string; reason: string }[];
}

function sourceLabel(work: GalleryWork, intl: ReturnType<typeof useIntl>): string {
  if (work.source === 'local') return intl.formatMessage(i18n.localSource);
  if (work.source === 'imported') return intl.formatMessage(i18n.importedSource);
  return work.sourceLabel ? `${intl.formatMessage(i18n.remoteSource)} · ${work.sourceLabel}` : intl.formatMessage(i18n.remoteSource);
}

function field(value: string | undefined, intl: ReturnType<typeof useIntl>): string {
  return value && value.trim() ? value : intl.formatMessage(i18n.notFilled);
}

function ExportDialog({ work, onClose }: { work: GalleryWork; onClose: () => void }) {
  const intl = useIntl();
  const [candidates, setCandidates] = useState<Candidates>({ candidates: [], excluded: [] });
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState(work.title ?? '');
  const [competition, setCompetition] = useState(work.competition ?? '');
  const [category, setCategory] = useState(work.category ?? '');
  const [abstract, setAbstract] = useState(work.abstract ?? '');
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [noPdf, setNoPdf] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!work.projectDir) return;
    void window.electron.galleryCandidates(work.projectDir).then((result) => {
      setCandidates(result);
      setChecked(new Set(result.candidates));
    });
  }, [work.projectDir]);

  const toggle = (path: string) => {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const submit = async () => {
    setNoPdf(false);
    setError(null);
    const result = await window.electron.galleryExport({
      projectDir: work.projectDir ?? '',
      title,
      competition,
      category,
      abstract,
      checked: [...checked],
      targetDir: work.projectDir ?? '',
      modelforgeVersion: window.electron.getVersion(),
    });
    if (result.ok) {
      setSavedPath(result.data.path);
    } else if (result.code === 'NO_PDF') {
      setNoPdf(true);
    } else {
      setError(result.reason ?? result.code);
    }
  };

  if (savedPath) {
    return (
      <DialogFrame onClose={onClose} title={intl.formatMessage(i18n.export)}>
        <p className="text-sm text-text-primary">
          {intl.formatMessage(i18n.exportSaved, { path: savedPath })}
        </p>
      </DialogFrame>
    );
  }

  return (
    <DialogFrame onClose={onClose} title={intl.formatMessage(i18n.export)}>
      {noPdf && <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">{intl.formatMessage(i18n.noPdf)}</p>}
      {error && <p role="alert" className="text-sm text-red-500">{error}</p>}

      <label className="block text-xs text-text-secondary">
        {intl.formatMessage(i18n.metadataTitle)}
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded border border-border-primary bg-background-secondary px-2 py-1 text-sm"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-xs text-text-secondary">
          {intl.formatMessage(i18n.metadataCompetition)}
          <input
            value={competition}
            onChange={(e) => setCompetition(e.target.value)}
            className="mt-1 w-full rounded border border-border-primary bg-background-secondary px-2 py-1 text-sm"
          />
        </label>
        <label className="block text-xs text-text-secondary">
          {intl.formatMessage(i18n.metadataCategory)}
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="mt-1 w-full rounded border border-border-primary bg-background-secondary px-2 py-1 text-sm"
          />
        </label>
      </div>
      <label className="block text-xs text-text-secondary">
        {intl.formatMessage(i18n.metadataAbstract)}
        <textarea
          value={abstract}
          onChange={(e) => setAbstract(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-border-primary bg-background-secondary px-2 py-1 text-sm"
        />
      </label>

      <div className="text-xs text-text-secondary">
        <div className="mb-1 font-medium">{intl.formatMessage(i18n.candidates)}</div>
        <div className="max-h-40 overflow-auto space-y-1">
          {candidates.excluded.map((excluded) => (
            <div key={excluded.path} className="flex items-center gap-2 text-text-tertiary">
              <input type="checkbox" disabled checked={false} readOnly />
              <span className="truncate">{excluded.path}</span>
              <span className="shrink-0">({excluded.reason})</span>
            </div>
          ))}
          {candidates.candidates
            .filter((candidate) => !candidates.excluded.some((e) => e.path === candidate))
            .map((candidate) => (
              <div key={candidate} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={checked.has(candidate)}
                  onChange={() => toggle(candidate)}
                />
                <span className="truncate">{candidate}</span>
              </div>
            ))}
        </div>
        {candidates.excluded.length > 0 && (
          <div className="mt-1 text-text-tertiary">{intl.formatMessage(i18n.excludedNote)}</div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-background-tertiary">
          {intl.formatMessage(i18n.exportCancel)}
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          className="rounded bg-background-info px-3 py-1 text-sm text-text-inverse hover:opacity-90"
        >
          {intl.formatMessage(i18n.exportConfirm)}
        </button>
      </div>
    </DialogFrame>
  );
}

function DialogFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex max-h-[80vh] w-[480px] max-w-[90vw] flex-col gap-3 overflow-y-auto rounded-2xl border border-border-primary bg-background-primary p-4">
        <div className="text-base font-medium text-text-primary">{title}</div>
        {children}
      </div>
      <button type="button" aria-label="close" onClick={onClose} className="fixed inset-0 -z-10" />
    </div>
  );
}

export default function GalleryView() {
  const intl = useIntl();
  const [works, setWorks] = useState<GalleryWork[]>([]);
  const [remoteWorks, setRemoteWorks] = useState<GalleryWork[]>([]);
  const [remoteUrl, setRemoteUrl] = useState('');
  const [remoteError, setRemoteError] = useState(false);
  const [exportTarget, setExportTarget] = useState<GalleryWork | null>(null);

  const load = useCallback(async () => {
    const result = await window.electron.galleryList();
    setWorks(result);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshRemote = useCallback(async () => {
    const url = remoteUrl.trim();
    if (!url) {
      setRemoteWorks([]);
      setRemoteError(false);
      return;
    }
    const result: GalleryResult<GalleryWork[]> = await window.electron.galleryRemote(url);
    if (result.ok) {
      setRemoteWorks(result.data);
      setRemoteError(false);
    } else {
      setRemoteWorks([]);
      setRemoteError(true);
    }
  }, [remoteUrl]);

  const importShare = async () => {
    await window.electron.galleryImport();
    await load();
  };

  const allWorks = [...works, ...remoteWorks];

  return (
    <div className="flex h-full flex-col bg-background-primary">
      <div className="flex items-center gap-2 border-b border-border-primary px-4 py-3">
        <h1 className="text-lg font-medium text-text-primary">{intl.formatMessage(i18n.title)}</h1>
        <button
          type="button"
          onClick={() => void importShare()}
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-background-tertiary"
        >
          <Upload className="h-3.5 w-3.5" />
          {intl.formatMessage(i18n.import)}
        </button>
        <button
          type="button"
          onClick={() => void refreshRemote()}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-secondary hover:bg-background-tertiary"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {intl.formatMessage(i18n.refresh)}
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-border-primary px-4 py-2">
        <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.remoteLabel)}</span>
        <input
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://…"
          className="min-w-0 flex-1 rounded border border-border-primary bg-background-secondary px-2 py-1 text-xs"
        />
      </div>

      {remoteError && (
        <div role="alert" className="border-b border-border-primary px-4 py-2 text-xs text-amber-600 dark:text-amber-400">
          {intl.formatMessage(i18n.remoteUnreachable)}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        {allWorks.length === 0 ? (
          <p className="text-sm text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {allWorks.map((work) => {
              const titleText = work.title ? truncateText(work.title, TITLE_LIMIT, { ellipsis: '…' }) : null;
              const abstractText = work.abstract ? truncateText(work.abstract, ABSTRACT_LIMIT) : null;
              return (
                <div key={work.id} className="overflow-hidden rounded-xl border border-border-primary bg-background-primary">
                  <GalleryPdfThumb pdfPath={work.pdfPath} />
                  <div className="space-y-1 p-3">
                    <div className="truncate text-sm font-medium text-text-primary">
                      {titleText ? titleText.text : intl.formatMessage(i18n.notFilled)}
                    </div>
                    <div className="text-xs text-text-secondary">
                      {field(work.competition, intl)} · {field(work.category, intl)}
                    </div>
                    <div className="line-clamp-3 text-xs text-text-secondary">
                      {abstractText ? abstractText.text : intl.formatMessage(i18n.notFilled)}
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-[10px] text-text-tertiary">{sourceLabel(work, intl)}</span>
                    </div>
                    {work.source === 'local' && (
                      <button
                        type="button"
                        onClick={() => setExportTarget(work)}
                        className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-primary hover:bg-background-tertiary"
                      >
                        <Download className="h-3.5 w-3.5" />
                        {intl.formatMessage(i18n.export)}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {exportTarget && <ExportDialog work={exportTarget} onClose={() => setExportTarget(null)} />}
    </div>
  );
}

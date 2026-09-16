import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Download,
  FolderInput,
  Pencil,
  Plus,
  Power,
  Search,
  Trash2,
  Upload,
  Zap,
} from 'lucide-react';
import type { SourceEntry } from '@aaif/goose-acp-client';
import { MainPanelLayout } from '../Layout/MainPanelLayout';
import MarkdownContent from '../MarkdownContent';
import { Button } from '../ui/button';
import { errorMessage } from '../../utils/conversionUtils';
import { getInitialWorkingDir } from '../../utils/workingDir';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';
import type { DisabledSkillRecord } from '../../utils/skillEnablement';
import {
  createSkillSource,
  deleteSkillSource,
  exportSkillSource,
  importSkillSources,
  listSkillSources,
  updateSkillSource,
} from '../../acp/sources';

const i18n = defineMessages({
  title: { id: 'skillsView.title', defaultMessage: 'Skills' },
  subtitle: {
    id: 'skillsView.subtitle',
    defaultMessage:
      'Method documents (SKILL.md) that teach the agent how to work. Enabled skills can be invoked from the composer with “/”.',
  },
  enabled: { id: 'skillsView.enabled', defaultMessage: 'Enabled' },
  disabled: { id: 'skillsView.disabled', defaultMessage: 'Disabled' },
  builtin: { id: 'skillsView.builtin', defaultMessage: 'Built-in' },
  globalSkill: { id: 'skillsView.globalSkill', defaultMessage: 'Global' },
  projectSkill: { id: 'skillsView.projectSkill', defaultMessage: 'Project' },
  searchPlaceholder: {
    id: 'skillsView.searchPlaceholder',
    defaultMessage: 'Search skills by name or description…',
  },
  total: { id: 'skillsView.total', defaultMessage: '{count} skills' },
  noSkills: { id: 'skillsView.noSkills', defaultMessage: 'No skills found' },
  noMatch: { id: 'skillsView.noMatch', defaultMessage: 'No skill matches that search.' },
  loadFailed: { id: 'skillsView.loadFailed', defaultMessage: 'Could not load skills' },
  tryAgain: { id: 'skillsView.tryAgain', defaultMessage: 'Try again' },
  status: { id: 'skillsView.status', defaultMessage: 'Status' },
  location: { id: 'skillsView.location', defaultMessage: 'Location' },
  source: { id: 'skillsView.source', defaultMessage: 'Source' },
  supportingFiles: { id: 'skillsView.supportingFiles', defaultMessage: 'Supporting files' },
  disabledAt: { id: 'skillsView.disabledAt', defaultMessage: 'Disabled at' },
  newSkill: { id: 'skillsView.newSkill', defaultMessage: 'New skill' },
  importFolder: { id: 'skillsView.importFolder', defaultMessage: 'Import folder' },
  importJson: { id: 'skillsView.importJson', defaultMessage: 'Import file' },
  edit: { id: 'skillsView.edit', defaultMessage: 'Edit' },
  remove: { id: 'skillsView.remove', defaultMessage: 'Delete' },
  exportSkill: { id: 'skillsView.exportSkill', defaultMessage: 'Export' },
  disable: { id: 'skillsView.disable', defaultMessage: 'Disable' },
  enable: { id: 'skillsView.enable', defaultMessage: 'Enable' },
  confirmDelete: { id: 'skillsView.confirmDelete', defaultMessage: 'Confirm delete' },
  cancel: { id: 'skillsView.cancel', defaultMessage: 'Cancel' },
  builtinCannotDisable: {
    id: 'skillsView.builtinCannotDisable',
    defaultMessage: 'Built-in skills ship with the app and cannot be disabled.',
  },
  readOnly: {
    id: 'skillsView.readOnly',
    defaultMessage: 'This skill is read-only and cannot be edited here.',
  },
  nameLabel: { id: 'skillsView.nameLabel', defaultMessage: 'Name' },
  namePlaceholder: { id: 'skillsView.namePlaceholder', defaultMessage: 'e.g. data-cleaning' },
  descriptionLabel: { id: 'skillsView.descriptionLabel', defaultMessage: 'One-line description' },
  descriptionPlaceholder: {
    id: 'skillsView.descriptionPlaceholder',
    defaultMessage: 'When should the agent load this skill?',
  },
  contentLabel: { id: 'skillsView.contentLabel', defaultMessage: 'SKILL.md body' },
  contentPlaceholder: {
    id: 'skillsView.contentPlaceholder',
    defaultMessage: '# What this skill does\n\nSteps the agent should follow…',
  },
  scopeLabel: { id: 'skillsView.scopeLabel', defaultMessage: 'Save to' },
  save: { id: 'skillsView.save', defaultMessage: 'Save' },
  saving: { id: 'skillsView.saving', defaultMessage: 'Saving…' },
  nameRequired: { id: 'skillsView.nameRequired', defaultMessage: 'A name is required.' },
  notToggled: {
    id: 'skillsView.notToggled',
    defaultMessage: 'Could not change the skill state',
  },
  imported: { id: 'skillsView.imported', defaultMessage: 'Imported {count} skill(s)' },
  exported: { id: 'skillsView.exported', defaultMessage: 'Exported to {path}' },
  runError: { id: 'skillsView.runError', defaultMessage: 'The action failed' },
});

/** The frontmatter is metadata; the panel shows the body the agent actually reads. */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return match ? content.slice(match[0].length) : content;
}

function isBuiltin(skill: SourceEntry): boolean {
  return skill.path.startsWith('builtin://');
}

function sourceLabelKey(skill: SourceEntry): 'builtin' | 'globalSkill' | 'projectSkill' {
  if (isBuiltin(skill)) return 'builtin';
  return skill.global ? 'globalSkill' : 'projectSkill';
}

interface EditorState {
  mode: 'create' | 'edit';
  path: string;
  name: string;
  description: string;
  content: string;
  scope: 'global' | 'project';
}

export default function SkillsView() {
  const intl = useIntl();
  const [skills, setSkills] = useState<SourceEntry[]>([]);
  const [disabledSkills, setDisabledSkills] = useState<DisabledSkillRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sources, disabled] = await Promise.all([
        listSkillSources(getInitialWorkingDir()),
        window.electron.listDisabledSkills(),
      ]);
      setSkills(sources);
      setDisabledSkills(disabled);
    } catch (err) {
      setError(errorMessage(err, 'Failed to load skills'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const matches = useCallback(
    (name: string, description: string) => {
      const term = search.trim().toLowerCase();
      if (!term) return true;
      return name.toLowerCase().includes(term) || description.toLowerCase().includes(term);
    },
    [search]
  );

  const visibleSkills = useMemo(
    () => skills.filter((skill) => matches(skill.name, skill.description)),
    [skills, matches]
  );
  const visibleDisabled = useMemo(
    () => disabledSkills.filter((record) => matches(record.name, record.originalPath)),
    [disabledSkills, matches]
  );

  const selectedSkill = skills.find((skill) => skill.path === selectedKey) ?? null;
  const selectedDisabled =
    disabledSkills.find((record) => record.name === selectedKey) ?? null;
  const activeSelection = selectedSkill ?? (selectedDisabled ? null : visibleSkills[0] ?? null);
  const activeDisabled =
    selectedDisabled ?? (selectedSkill ? null : visibleSkills.length ? null : visibleDisabled[0] ?? null);

  const select = (key: string) => {
    setSelectedKey(key);
    setConfirmingDelete(false);
    setEditor(null);
    setNotice(null);
  };

  const runAction = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await action());
      await load();
    } catch (err) {
      setNotice(errorMessage(err, intl.formatMessage(i18n.runError)));
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = (skill: SourceEntry | null, record: DisabledSkillRecord | null) => {
    const target = skill
      ? { name: skill.name, path: skill.path, enabled: false }
      : { name: record!.name, path: record!.originalPath, enabled: true };
    void runAction(async () => {
      const result = await window.electron.setSkillEnabled(target);
      if (!result.ok) throw new Error(result.error);
      return null;
    });
  };

  const removeSkill = (skill: SourceEntry) =>
    runAction(async () => {
      await deleteSkillSource(skill.path);
      return null;
    });

  const exportSkill = (skill: SourceEntry) =>
    runAction(async () => {
      const { json, filename } = await exportSkillSource(skill.path);
      const saved = await window.electron.showSaveDialog({ defaultPath: filename });
      if (saved.canceled || !saved.filePath) return null;
      await window.electron.writeFile(saved.filePath, json);
      return intl.formatMessage(i18n.exported, { path: saved.filePath });
    });

  const importFolder = () =>
    runAction(async () => {
      const result = await window.electron.importSkillFolder();
      if (result.canceled) return null;
      if (result.error) throw new Error(result.error);
      return intl.formatMessage(i18n.imported, { count: 1 });
    });

  const importFile = () =>
    runAction(async () => {
      const picked = await window.electron.selectSkillImportFile();
      if (!picked) return null;
      if (picked.error || !picked.json) throw new Error(picked.error ?? 'Empty file');
      const imported = await importSkillSources(picked.json, { scope: 'global' });
      return intl.formatMessage(i18n.imported, { count: imported.length });
    });

  const saveEditor = () =>
    runAction(async () => {
      if (!editor) return null;
      const draft = {
        name: editor.name.trim(),
        description: editor.description.trim(),
        content: editor.content,
      };
      if (!draft.name) throw new Error(intl.formatMessage(i18n.nameRequired));
      if (editor.mode === 'create') {
        await createSkillSource(
          draft,
          editor.scope === 'project'
            ? { scope: 'projectDir', projectDir: getInitialWorkingDir() }
            : { scope: 'global' }
        );
      } else {
        await updateSkillSource(editor.path, draft);
      }
      setEditor(null);
      return null;
    });

  const renderList = () => (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      {visibleSkills.length > 0 && (
        <section aria-label={intl.formatMessage(i18n.enabled)}>
          <GroupHeading label={intl.formatMessage(i18n.enabled)} count={visibleSkills.length} />
          {visibleSkills.map((skill) => (
            <SkillRow
              key={skill.path}
              name={skill.name}
              description={skill.description}
              badge={intl.formatMessage(i18n[sourceLabelKey(skill)])}
              active={activeSelection?.path === skill.path}
              onClick={() => select(skill.path)}
            />
          ))}
        </section>
      )}
      {visibleDisabled.length > 0 && (
        <section aria-label={intl.formatMessage(i18n.disabled)}>
          <GroupHeading label={intl.formatMessage(i18n.disabled)} count={visibleDisabled.length} />
          {visibleDisabled.map((record) => (
            <SkillRow
              key={record.name}
              name={record.name}
              description={record.originalPath}
              badge={intl.formatMessage(i18n.disabled)}
              muted
              active={activeDisabled?.name === record.name}
              onClick={() => select(record.name)}
            />
          ))}
        </section>
      )}
      {visibleSkills.length === 0 && visibleDisabled.length === 0 && (
        <p className="px-3 py-4 text-xs text-text-secondary">
          {intl.formatMessage(search.trim() ? i18n.noMatch : i18n.noSkills)}
        </p>
      )}
    </div>
  );

  return (
    <MainPanelLayout>
      <div className="flex h-full min-h-0">
        <div className="flex w-[340px] flex-shrink-0 flex-col border-r border-border-secondary min-h-0">
          <div className="space-y-3 px-4 pt-4 pb-3">
            <div>
              <h1 className="text-sm font-medium text-text-primary">
                {intl.formatMessage(i18n.title)}
              </h1>
              <p className="mt-1 text-xs text-text-secondary">
                {intl.formatMessage(i18n.subtitle)}
              </p>
            </div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={intl.formatMessage(i18n.searchPlaceholder)}
                className="w-full rounded-lg border border-border-secondary bg-background-primary py-1.5 pl-8 pr-2.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditor({
                    mode: 'create',
                    path: '',
                    name: '',
                    description: '',
                    content: '',
                    scope: 'global',
                  });
                  setSelectedKey('');
                  setNotice(null);
                }}
                className="flex items-center gap-1 rounded-full border border-border-secondary px-2.5 py-0.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <Plus className="h-3 w-3" />
                {intl.formatMessage(i18n.newSkill)}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={importFolder}
                className="flex items-center gap-1 rounded-full border border-border-secondary px-2.5 py-0.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <FolderInput className="h-3 w-3" />
                {intl.formatMessage(i18n.importFolder)}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={importFile}
                className="flex items-center gap-1 rounded-full border border-border-secondary px-2.5 py-0.5 text-xs text-text-secondary transition-colors hover:text-text-primary disabled:opacity-50"
              >
                <Upload className="h-3 w-3" />
                {intl.formatMessage(i18n.importJson)}
              </button>
            </div>
            <p className="text-[11px] text-text-tertiary">
              {intl.formatMessage(i18n.total, { count: skills.length })}
            </p>
          </div>
          {loading ? (
            <p className="px-4 py-3 text-xs text-text-secondary">…</p>
          ) : error ? (
            <div className="px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs text-text-secondary">
                <AlertCircle className="h-3.5 w-3.5" />
                {intl.formatMessage(i18n.loadFailed)}
              </p>
              <Button variant="outline" size="sm" className="mt-2" onClick={load}>
                {intl.formatMessage(i18n.tryAgain)}
              </Button>
            </div>
          ) : (
            renderList()
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {editor ? (
            <SkillEditor
              editor={editor}
              busy={busy}
              onChange={setEditor}
              onCancel={() => setEditor(null)}
              onSave={saveEditor}
            />
          ) : activeSelection ? (
            <article className="max-w-3xl px-8 py-6">
              <header className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-medium text-text-primary">
                      {activeSelection.name}
                    </h2>
                    <Badge label={intl.formatMessage(i18n.enabled)} tone="ok" />
                    <Badge
                      label={intl.formatMessage(i18n[sourceLabelKey(activeSelection)])}
                      tone="plain"
                    />
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">
                    {activeSelection.description}
                  </p>
                </div>
                <div className="flex flex-shrink-0 flex-wrap justify-end gap-1.5">
                  {isBuiltin(activeSelection) ? (
                    <span
                      className="max-w-[220px] text-right text-[11px] text-text-tertiary"
                      title={intl.formatMessage(i18n.builtinCannotDisable)}
                    >
                      {intl.formatMessage(i18n.builtinCannotDisable)}
                    </span>
                  ) : (
                    <ActionButton
                      icon={Power}
                      label={intl.formatMessage(i18n.disable)}
                      disabled={busy}
                      onClick={() => setEnabled(activeSelection, null)}
                    />
                  )}
                  {activeSelection.writable !== false && (
                    <>
                      <ActionButton
                        icon={Pencil}
                        label={intl.formatMessage(i18n.edit)}
                        disabled={busy}
                        onClick={() =>
                          setEditor({
                            mode: 'edit',
                            path: activeSelection.path,
                            name: activeSelection.name,
                            description: activeSelection.description,
                            content: activeSelection.content,
                            scope: activeSelection.global ? 'global' : 'project',
                          })
                        }
                      />
                      <ActionButton
                        icon={Download}
                        label={intl.formatMessage(i18n.exportSkill)}
                        disabled={busy}
                        onClick={() => exportSkill(activeSelection)}
                      />
                      <ActionButton
                        icon={Trash2}
                        label={
                          confirmingDelete
                            ? intl.formatMessage(i18n.confirmDelete)
                            : intl.formatMessage(i18n.remove)
                        }
                        danger
                        disabled={busy}
                        onClick={() =>
                          confirmingDelete ? removeSkill(activeSelection) : setConfirmingDelete(true)
                        }
                      />
                    </>
                  )}
                </div>
              </header>

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.source)}:</dt>
                  <dd className="text-text-primary">
                    {intl.formatMessage(i18n[sourceLabelKey(activeSelection)])}
                  </dd>
                </div>
                {activeSelection.supportingFiles && activeSelection.supportingFiles.length > 0 && (
                  <div className="flex gap-1.5">
                    <dt>{intl.formatMessage(i18n.supportingFiles)}:</dt>
                    <dd className="text-text-primary">{activeSelection.supportingFiles.length}</dd>
                  </div>
                )}
              </dl>

              <div className="mt-2 flex gap-2 text-xs">
                <span className="flex-shrink-0 text-text-secondary">
                  {intl.formatMessage(i18n.location)}:
                </span>
                <span className="min-w-0 break-all font-mono text-text-primary">
                  {activeSelection.path}
                </span>
              </div>

              {notice && <Notice text={notice} />}

              <section className="mt-5 rounded-xl border border-border-secondary p-4">
                <MarkdownContent
                  content={stripFrontmatter(activeSelection.content)}
                  className="text-sm"
                />
              </section>
            </article>
          ) : activeDisabled ? (
            <article className="max-w-3xl px-8 py-6">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-medium text-text-primary">{activeDisabled.name}</h2>
                <Badge label={intl.formatMessage(i18n.disabled)} tone="muted" />
              </div>
              <div className="mt-3 flex gap-2 text-xs">
                <span className="flex-shrink-0 text-text-secondary">
                  {intl.formatMessage(i18n.location)}:
                </span>
                <span className="min-w-0 break-all font-mono text-text-primary">
                  {activeDisabled.originalPath}
                </span>
              </div>
              {activeDisabled.disabledAt && (
                <div className="mt-1 flex gap-2 text-xs">
                  <span className="flex-shrink-0 text-text-secondary">
                    {intl.formatMessage(i18n.disabledAt)}:
                  </span>
                  <span className="text-text-primary">
                    {activeDisabled.disabledAt.slice(0, 19).replace('T', ' ')}
                  </span>
                </div>
              )}
              <div className="mt-4">
                <ActionButton
                  icon={Power}
                  label={intl.formatMessage(i18n.enable)}
                  disabled={busy}
                  onClick={() => setEnabled(null, activeDisabled)}
                />
              </div>
              {notice && <Notice text={notice} />}
              <p className="mt-4 text-xs text-text-tertiary">
                {intl.formatMessage(i18n.builtinCannotDisable)}
              </p>
            </article>
          ) : (
            <div className="px-8 py-6">
              <p className="text-sm text-text-secondary">
                {intl.formatMessage(search.trim() ? i18n.noMatch : i18n.noSkills)}
              </p>
            </div>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}

function GroupHeading({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-text-tertiary">
      <span>{label}</span>
      <span>{count}</span>
    </div>
  );
}

function SkillRow({
  name,
  description,
  badge,
  active,
  muted,
  onClick,
}: {
  name: string;
  description: string;
  badge: string;
  active: boolean;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
        active
          ? 'border-border-primary bg-background-tertiary'
          : 'border-transparent hover:bg-background-tertiary/60'
      )}
    >
      <Zap
        className={cn('mt-0.5 h-4 w-4 flex-shrink-0', muted ? 'text-text-tertiary' : 'text-text-secondary')}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span
            className={cn(
              'flex-1 truncate text-sm',
              muted ? 'text-text-secondary' : 'text-text-primary'
            )}
          >
            {name}
          </span>
          <span className="flex-shrink-0 rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">
            {badge}
          </span>
        </span>
        <span className="mt-0.5 block line-clamp-2 text-xs text-text-secondary">{description}</span>
      </span>
    </button>
  );
}

function Badge({ label, tone }: { label: string; tone: 'ok' | 'plain' | 'muted' }) {
  return (
    <span
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]',
        tone === 'ok' && 'bg-background-tertiary text-text-primary',
        tone === 'plain' && 'border border-border-secondary text-text-secondary',
        tone === 'muted' && 'bg-background-secondary text-text-tertiary'
      )}
    >
      {tone === 'ok' && <Check className="h-2.5 w-2.5" />}
      {label}
    </span>
  );
}

function ActionButton({
  icon: Icon,
  label,
  disabled,
  danger,
  onClick,
}: {
  icon: typeof Power;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:opacity-50',
        danger
          ? 'border-border-secondary text-text-secondary hover:border-red-500 hover:text-red-500'
          : 'border-border-secondary text-text-secondary hover:border-border-primary hover:text-text-primary'
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <p className="mt-3 rounded-lg border border-border-secondary bg-background-secondary px-3 py-2 text-xs text-text-secondary">
      {text}
    </p>
  );
}

function SkillEditor({
  editor,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  editor: EditorState;
  busy: boolean;
  onChange: (next: EditorState) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const intl = useIntl();
  const field =
    'mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none';

  return (
    <article className="max-w-3xl px-8 py-6">
      <h2 className="text-xl font-medium text-text-primary">
        {intl.formatMessage(editor.mode === 'create' ? i18n.newSkill : i18n.edit)}
      </h2>

      <label className="mt-4 block">
        <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.nameLabel)}</span>
        <input
          type="text"
          value={editor.name}
          placeholder={intl.formatMessage(i18n.namePlaceholder)}
          onChange={(event) => onChange({ ...editor, name: event.target.value })}
          className={field}
        />
      </label>

      <label className="mt-3 block">
        <span className="text-xs text-text-secondary">
          {intl.formatMessage(i18n.descriptionLabel)}
        </span>
        <input
          type="text"
          value={editor.description}
          placeholder={intl.formatMessage(i18n.descriptionPlaceholder)}
          onChange={(event) => onChange({ ...editor, description: event.target.value })}
          className={field}
        />
      </label>

      <label className="mt-3 block">
        <span className="text-xs text-text-secondary">
          {intl.formatMessage(i18n.contentLabel)}
        </span>
        <textarea
          rows={16}
          value={editor.content}
          placeholder={intl.formatMessage(i18n.contentPlaceholder)}
          onChange={(event) => onChange({ ...editor, content: event.target.value })}
          className={cn(field, 'font-mono leading-relaxed')}
        />
      </label>

      {editor.mode === 'create' && (
        <label className="mt-3 block">
          <span className="text-xs text-text-secondary">{intl.formatMessage(i18n.scopeLabel)}</span>
          <select
            value={editor.scope}
            onChange={(event) =>
              onChange({ ...editor, scope: event.target.value as EditorState['scope'] })
            }
            className={field}
          >
            <option value="global">{intl.formatMessage(i18n.globalSkill)}</option>
            <option value="project">{intl.formatMessage(i18n.projectSkill)}</option>
          </select>
        </label>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onSave}>
          {intl.formatMessage(busy ? i18n.saving : i18n.save)}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {intl.formatMessage(i18n.cancel)}
        </Button>
      </div>
    </article>
  );
}

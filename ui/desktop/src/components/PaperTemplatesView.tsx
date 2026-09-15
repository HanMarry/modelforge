import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Check, Filter, Languages, FileCode2, Pencil, Wand2 } from 'lucide-react';
import {
  PAPER_TEMPLATE_CATALOG,
  paperPreview,
  type PaperField,
  type PaperTemplateEntry,
} from '../catalog/papers';
type PaperLanguage = 'zh' | 'en';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';
import { seedComposer } from '../utils/composerSeed';

const i18n = defineMessages({
  title: { id: 'paperView.title', defaultMessage: 'Competition paper templates' },
  subtitle: {
    id: 'paperView.subtitle',
    defaultMessage:
      'Pick a contest template and the agent copies it into the project, then writes and compiles the paper from the entry file.',
  },
  all: { id: 'paperView.all', defaultMessage: 'All' },
  availableOnly: { id: 'paperView.availableOnly', defaultMessage: 'Available' },
  available: { id: 'paperView.available', defaultMessage: 'Bundled' },
  planned: { id: 'paperView.planned', defaultMessage: 'Not bundled yet' },
  language: { id: 'paperView.language', defaultMessage: 'Language' },
  source: { id: 'paperView.source', defaultMessage: 'Source' },
  license: { id: 'paperView.license', defaultMessage: 'Licence' },
  engine: { id: 'paperView.engine', defaultMessage: 'Engine' },
  contents: { id: 'paperView.contents', defaultMessage: 'Template contents' },
  templateDir: { id: 'paperView.templateDir', defaultMessage: 'Template folder' },
  entryFile: { id: 'paperView.entryFile', defaultMessage: 'Entry file' },
  usage: { id: 'paperView.usage', defaultMessage: 'How it is used' },
  previewCaption: {
    id: 'paperView.previewCaption',
    defaultMessage: 'First page of the compiled template (rendered by xelatex).',
  },
  usageBody: {
    id: 'paperView.usageBody',
    defaultMessage:
      'The agent copies the whole template folder into the project and starts from the entry file. Compile with the modeling extension (compile_latex).',
  },
  empty: { id: 'paperView.empty', defaultMessage: 'No templates match that filter.' },
  engineLatex: { id: 'paperView.engineLatex', defaultMessage: 'LaTeX' },
  engineTypst: { id: 'paperView.engineTypst', defaultMessage: 'Typst' },
  langZh: { id: 'paperView.langZh', defaultMessage: 'Chinese' },
  langEn: { id: 'paperView.langEn', defaultMessage: 'English' },
  coverFields: { id: 'paperView.coverFields', defaultMessage: 'Cover page inputs' },
  coverHint: {
    id: 'paperView.coverHint',
    defaultMessage:
      'Declared by the template itself (题号, 队号, 学校 …). Filled values are written into the request; leave a field empty and the agent will ask.',
  },
  optional: { id: 'paperView.optional', defaultMessage: 'optional' },
  useTemplate: { id: 'paperView.useTemplate', defaultMessage: 'Use this template' },
  useTemplateHint: {
    id: 'paperView.useTemplateHint',
    defaultMessage:
      'Fills the home composer with the template, entry file and cover values; nothing is sent yet.',
  },
  defaultFor: { id: 'paperView.defaultFor', defaultMessage: 'Default for' },
  groupBundled: { id: 'paperView.groupBundled', defaultMessage: 'Bundled · contest templates' },
  groupVendored: { id: 'paperView.groupVendored', defaultMessage: 'Upstream open source' },
  customize: { id: 'paperView.customize', defaultMessage: 'Customise from this template' },
  customizeHint: {
    id: 'paperView.customizeHint',
    defaultMessage:
      'Creates your own copy inside the project and adapts it, so the bundled template stays untouched.',
  },
  customizeName: { id: 'paperView.customizeName', defaultMessage: 'Name for your copy' },
  customizeNamePlaceholder: {
    id: 'paperView.customizeNamePlaceholder',
    defaultMessage: 'e.g. my-cumcm-2026',
  },
  customizeConfirm: { id: 'paperView.customizeConfirm', defaultMessage: 'Create the request' },
  customizeCancel: { id: 'paperView.customizeCancel', defaultMessage: 'Cancel' },
});

/** The copy the agent should make, and what it should leave alone. */
function customizeRequest(entry: PaperTemplateEntry, name: string): string {
  return [
    `请基于 math-paper 的内置模板「${entry.contest}」为我做一个自定义模板，自定义目录名用 \`${name}\`。`,
    '',
    '步骤：',
    `1. 把模板目录 math_paper/assets/templates/${entry.directory}/ 整体复制到当前项目的` +
      `.modelforge/templates/${name}/；`,
    '2. 在该副本上改造，**不要改动技能目录里的原件**；',
    '3. 改完说明改了哪些文件、入口文件叫什么，并写一份 README.md 记录这个自定义模板的用法与差异。',
    '',
    '我的改造要求：',
    '（写在这里，例如：换成本校的封面、去掉承诺书页、摘要页加英文摘要、正文改成两栏）',
  ].join('\n');
}

/** Builds the seeded request: template identity, copy rule, then the cover values. */
function templateRequest(entry: PaperTemplateEntry, values: Record<string, string>): string {
  const filled = [...entry.fields, ...entry.profileFields].filter((field) =>
    (values[field.id] ?? '').trim()
  );

  const lines = [
    `请用 math-paper 技能的内置模板「${entry.contest}」为我撰写竞赛论文。`,
    '',
    '先加载 math-modeling、math-paper、math-figure 技能。写作方式：把模板目录 ' +
      `math_paper/assets/templates/${entry.directory}/（入口 ${entry.entryFile}）整体复制到当前` +
      '工作目录，在副本上写作；不要改动技能目录里的原件，也不要覆盖我已有的论文。',
  ];

  if (filled.length > 0) {
    lines.push('', '封面/承诺书需要填写的信息：');
    for (const field of filled) {
      lines.push(`- ${field.label}：${values[field.id].trim()}`);
    }
  }

  lines.push(
    '',
    '论文要求：按 摘要/问题重述/问题分析/模型假设与符号说明/模型建立与求解/模型检验/' +
      '模型评价与推广/参考文献/附录 的结构写作；摘要最后写；每个数字都要来自真正跑过的脚本；' +
      '参考文献用 paper-search 核验真实存在；最后用 modeling 扩展的 compile_latex 编译出 PDF。',
    `排版引擎：${entry.engine === 'typst' ? 'typst（入口为 paper.typ）' : 'xelatex（中文模板必须用 xelatex）'}。`,
    '',
    '我的题目与附件：',
    '（把题目粘贴到这里，或写出附件文件的路径）'
  );
  return lines.join('\n');
}

export default function PaperTemplatesView() {
  const intl = useIntl();
  const navigate = useNavigate();
  const [availableOnly, setAvailableOnly] = useState(false);
  const [language, setLanguage] = useState<PaperLanguage | 'all'>('all');
  const [selectedId, setSelectedId] = useState(PAPER_TEMPLATE_CATALOG[0]?.directory ?? '');
  // Cover-page inputs, keyed by field id. Reset whenever the selection changes so a value
  // typed for one contest never leaks into another.
  const [coverValues, setCoverValues] = useState<Record<string, string>>({});
  const [customizing, setCustomizing] = useState(false);
  const [customName, setCustomName] = useState('');

  const filtered = useMemo(
    () =>
      PAPER_TEMPLATE_CATALOG.filter((entry) => {
        if (availableOnly && !entry.available) return false;
        if (language !== 'all' && entry.language !== language) return false;
        return true;
      }),
    [availableOnly, language]
  );

  const selected = filtered.find((entry) => entry.directory === selectedId) ?? filtered[0] ?? null;
  const availableCount = PAPER_TEMPLATE_CATALOG.filter((entry) => entry.available).length;

  useEffect(() => {
    setCoverValues({});
    setCustomizing(false);
    setCustomName('');
  }, [selected?.directory]);

  const coverFields: PaperField[] = selected
    ? [...selected.fields, ...selected.profileFields]
    : [];

  // Grouped like the reference: templates that ship with the app first, then the ones
  // vendored from upstream repositories, each with its own heading and count.
  const grouped = useMemo(() => {
    const order: Array<PaperTemplateEntry['kind']> = ['bundled', 'vendored'];
    return order
      .map((kind) => [kind, filtered.filter((entry) => entry.kind === kind)] as const)
      .filter(([, entries]) => entries.length > 0);
  }, [filtered]);

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
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setAvailableOnly(false)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  !availableOnly
                    ? 'border-border-primary bg-background-tertiary text-text-primary'
                    : 'border-border-secondary text-text-secondary hover:text-text-primary'
                )}
              >
                {intl.formatMessage(i18n.all)} {PAPER_TEMPLATE_CATALOG.length}
              </button>
              <button
                onClick={() => setAvailableOnly(true)}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  availableOnly
                    ? 'border-border-primary bg-background-tertiary text-text-primary'
                    : 'border-border-secondary text-text-secondary hover:text-text-primary'
                )}
              >
                <Check className="h-3 w-3" />
                {intl.formatMessage(i18n.availableOnly)} {availableCount}
              </button>
              <button
                onClick={() => setLanguage(language === 'zh' ? 'all' : 'zh')}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  language === 'zh'
                    ? 'border-border-primary bg-background-tertiary text-text-primary'
                    : 'border-border-secondary text-text-secondary hover:text-text-primary'
                )}
              >
                <Languages className="h-3 w-3" />
                {intl.formatMessage(i18n.langZh)}
              </button>
              <button
                onClick={() => setLanguage(language === 'en' ? 'all' : 'en')}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  language === 'en'
                    ? 'border-border-primary bg-background-tertiary text-text-primary'
                    : 'border-border-secondary text-text-secondary hover:text-text-primary'
                )}
              >
                {intl.formatMessage(i18n.langEn)}
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 pb-3">
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-xs text-text-secondary">
                {intl.formatMessage(i18n.empty)}
              </p>
            )}
            {grouped.map(([kind, groupEntries]) => (
              <section key={kind} aria-label={intl.formatMessage(i18n[kind === 'bundled' ? 'groupBundled' : 'groupVendored'])}>
                <div className="flex items-center gap-2 px-3 pb-1 pt-3 text-[11px] uppercase tracking-wide text-text-tertiary">
                  <span>
                    {intl.formatMessage(
                      i18n[kind === 'bundled' ? 'groupBundled' : 'groupVendored']
                    )}
                  </span>
                  <span>{groupEntries.length}</span>
                </div>
                {groupEntries.map((entry) => (
              <button
                key={entry.directory}
                onClick={() => setSelectedId(entry.directory)}
                className={cn(
                  'flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
                  selected?.directory === entry.directory
                    ? 'border-border-primary bg-background-tertiary'
                    : 'border-transparent hover:bg-background-tertiary/60'
                )}
              >
                <FileCode2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm text-text-primary">
                      {entry.contest}
                    </span>
                    <span className="flex-shrink-0 rounded bg-background-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">
                      {entry.language === 'zh'
                        ? intl.formatMessage(i18n.langZh)
                        : intl.formatMessage(i18n.langEn)}
                    </span>
                  </span>
                  <span className="mt-0.5 block line-clamp-2 text-xs text-text-secondary">
                    {entry.name}
                  </span>
                  {!entry.available && (
                    <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-text-tertiary">
                      <Filter className="h-2.5 w-2.5" />
                      {intl.formatMessage(i18n.planned)}
                    </span>
                  )}
                </span>
              </button>
                ))}
              </section>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected && (
            <article className="max-w-3xl px-8 py-6">
              <header className="flex items-start gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-xl font-medium text-text-primary">{selected.contest}</h2>
                    <span className="rounded border border-border-secondary px-1.5 py-0.5 text-[10px] text-text-secondary">
                      {selected.engine === 'xelatex'
                        ? intl.formatMessage(i18n.engineLatex)
                        : intl.formatMessage(i18n.engineTypst)}
                    </span>
                    {selected.available && (
                      <span className="flex items-center gap-1 rounded bg-background-tertiary px-1.5 py-0.5 text-[10px] text-text-primary">
                        <Check className="h-2.5 w-2.5" />
                        {intl.formatMessage(i18n.available)}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">{selected.name}</p>
                </div>
              </header>

              <p className="mt-4 text-sm text-text-secondary">{selected.description}</p>

              {paperPreview(selected) && (
                <div className="mt-4 overflow-hidden rounded-xl border border-border-secondary bg-background-secondary">
                  <img
                    src={paperPreview(selected)}
                    alt={selected.contest}
                    className="max-h-[520px] w-full object-contain object-top"
                  />
                  <p className="border-t border-border-secondary px-3 py-1.5 text-[11px] text-text-tertiary">
                    {intl.formatMessage(i18n.previewCaption)}
                  </p>
                </div>
              )}

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.language)}:</dt>
                  <dd className="text-text-primary">
                    {selected.language === 'zh'
                      ? intl.formatMessage(i18n.langZh)
                      : intl.formatMessage(i18n.langEn)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.source)}:</dt>
                  <dd className="text-text-primary">{selected.source}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.license)}:</dt>
                  <dd className="text-text-primary">{selected.license}</dd>
                </div>
                {selected.defaultFor.length > 0 && (
                  <div className="flex gap-1.5">
                    <dt>{intl.formatMessage(i18n.defaultFor)}:</dt>
                    <dd className="text-text-primary">{selected.defaultFor.join('、')}</dd>
                  </div>
                )}
              </dl>

              <section className="mt-5 rounded-xl border border-border-secondary p-4">
                <h3 className="text-xs font-medium text-text-primary">
                  {intl.formatMessage(i18n.contents)}
                </h3>
                <dl className="mt-2 space-y-1.5 text-xs">
                  <div className="flex gap-2">
                    <dt className="w-24 flex-shrink-0 text-text-secondary">
                      {intl.formatMessage(i18n.templateDir)}
                    </dt>
                    <dd className="min-w-0 break-all font-mono text-text-primary">
                      {selected.directory
                        ? `math_paper/assets/templates/${selected.directory}/`
                        : '—'}
                    </dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="w-24 flex-shrink-0 text-text-secondary">
                      {intl.formatMessage(i18n.entryFile)}
                    </dt>
                    <dd className="min-w-0 break-all font-mono text-text-primary">
                      {selected.entryFile}
                    </dd>
                  </div>
                </dl>
              </section>

              <section className="mt-4 rounded-xl border border-border-secondary p-4">
                <h3 className="text-xs font-medium text-text-primary">
                  {intl.formatMessage(i18n.usage)}
                </h3>
                <p className="mt-1.5 text-sm text-text-secondary">
                  {intl.formatMessage(i18n.usageBody)}
                </p>
              </section>

              {coverFields.length > 0 && (
                <section className="mt-4 rounded-xl border border-border-secondary p-4">
                  <h3 className="text-xs font-medium text-text-primary">
                    {intl.formatMessage(i18n.coverFields)}
                  </h3>
                  <p className="mt-1 text-[11px] text-text-tertiary">
                    {intl.formatMessage(i18n.coverHint)}
                  </p>
                  <div className="mt-3 space-y-2.5">
                    {coverFields.map((field) => (
                      <label key={field.id} className="block">
                        <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                          {field.label}
                          {!field.required && (
                            <span className="text-[10px] text-text-tertiary">
                              {intl.formatMessage(i18n.optional)}
                            </span>
                          )}
                        </span>
                        <input
                          type="text"
                          value={coverValues[field.id] ?? ''}
                          placeholder={field.placeholder}
                          onChange={(event) =>
                            setCoverValues((prev) => ({ ...prev, [field.id]: event.target.value }))
                          }
                          className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
                        />
                      </label>
                    ))}
                  </div>
                </section>
              )}

              <section className="mt-4">
                <button
                  type="button"
                  disabled={!selected.available}
                  onClick={() => {
                    seedComposer(
                      templateRequest(selected, coverValues),
                      `paper-${selected.directory}-${Date.now()}`
                    );
                    navigate('/');
                  }}
                  className={cn(
                    'flex w-full items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors',
                    selected.available
                      ? 'border-border-primary text-text-primary hover:bg-background-tertiary'
                      : 'cursor-not-allowed border-border-secondary text-text-tertiary'
                  )}
                >
                  <Wand2 className="h-4 w-4" />
                  {intl.formatMessage(i18n.useTemplate)}
                </button>
                <p className="mt-1.5 text-[11px] text-text-tertiary">
                  {intl.formatMessage(i18n.useTemplateHint)}
                </p>
              </section>

              <section className="mt-4">
                {customizing ? (
                  <div className="rounded-xl border border-border-secondary p-4">
                    <label className="block">
                      <span className="text-xs text-text-secondary">
                        {intl.formatMessage(i18n.customizeName)}
                      </span>
                      <input
                        type="text"
                        value={customName}
                        placeholder={intl.formatMessage(i18n.customizeNamePlaceholder)}
                        onChange={(event) => setCustomName(event.target.value)}
                        className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-2.5 py-1.5 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-primary focus:outline-none"
                      />
                    </label>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={!customName.trim()}
                        onClick={() => {
                          seedComposer(
                            customizeRequest(selected, customName.trim()),
                            `paper-custom-${selected.directory}-${Date.now()}`
                          );
                          navigate('/');
                        }}
                        className={cn(
                          'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                          customName.trim()
                            ? 'border-border-primary text-text-primary hover:bg-background-tertiary'
                            : 'cursor-not-allowed border-border-secondary text-text-tertiary'
                        )}
                      >
                        {intl.formatMessage(i18n.customizeConfirm)}
                      </button>
                      <button
                        type="button"
                        onClick={() => setCustomizing(false)}
                        className="rounded-lg border border-border-secondary px-3 py-1.5 text-xs text-text-secondary transition-colors hover:text-text-primary"
                      >
                        {intl.formatMessage(i18n.customizeCancel)}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setCustomizing(true)}
                      className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border-secondary px-3 py-2 text-sm text-text-secondary transition-colors hover:border-border-primary hover:text-text-primary"
                    >
                      <Pencil className="h-4 w-4" />
                      {intl.formatMessage(i18n.customize)}
                    </button>
                    <p className="mt-1.5 text-[11px] text-text-tertiary">
                      {intl.formatMessage(i18n.customizeHint)}
                    </p>
                  </>
                )}
              </section>
            </article>
          )}
        </div>
      </div>
    </MainPanelLayout>
  );
}

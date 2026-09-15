import { useMemo, useState } from 'react';
import { AlertCircle, Check, Download, ExternalLink, Loader2, Plug, Plus } from 'lucide-react';
import {
  INSTALLABLE_CONNECTORS,
  INSTALLED_CONNECTORS,
  PLANNED_CONNECTORS,
  toExtensionConfig,
  type ConnectorEntry,
  type ConnectorSecret,
} from '../catalog/connectors';
import { MainPanelLayout } from './Layout/MainPanelLayout';
import { Button } from './ui/button';
import { useConfig } from './ConfigContext';
import { toastError, toastSuccess } from '../toasts';
import { cn } from '../utils';
import { defineMessages, useIntl } from '../i18n';
import ExtensionModal from './settings/extensions/modal/ExtensionModal';
import { activateExtensionDefault } from './settings/extensions';
import {
  createExtensionConfig,
  getDefaultFormData,
  type ExtensionFormData,
} from './settings/extensions/utils';

const i18n = defineMessages({
  title: { id: 'connectorsView.title', defaultMessage: 'Connectors' },
  subtitle: {
    id: 'connectorsView.subtitle',
    defaultMessage:
      'Extend the assistant with MCP servers: literature search, web fetch and repositories.',
  },
  builtin: { id: 'connectorsView.builtin', defaultMessage: 'Built in' },
  builtinHint: {
    id: 'connectorsView.builtinHint',
    defaultMessage: 'Ships with the app; toggle it from Plugins.',
  },
  installable: { id: 'connectorsView.installable', defaultMessage: 'Available to connect' },
  planned: { id: 'connectorsView.planned', defaultMessage: 'Planned' },
  plannedHint: {
    id: 'connectorsView.plannedHint',
    defaultMessage: 'No server implemented yet — listed so the catalogue is complete.',
  },
  install: { id: 'connectorsView.install', defaultMessage: 'Install' },
  installing: { id: 'connectorsView.installing', defaultMessage: 'Installing…' },
  installedLabel: { id: 'connectorsView.installed', defaultMessage: 'Installed' },
  capabilities: { id: 'connectorsView.capabilities', defaultMessage: 'Capabilities' },
  transport: { id: 'connectorsView.transport', defaultMessage: 'Transport' },
  source: { id: 'connectorsView.source', defaultMessage: 'Package' },
  docs: { id: 'connectorsView.docs', defaultMessage: 'Documentation' },
  defaultOn: { id: 'connectorsView.defaultOn', defaultMessage: 'Enabled by default' },
  defaultOff: { id: 'connectorsView.defaultOff', defaultMessage: 'Disabled by default' },
  all: { id: 'connectorsView.all', defaultMessage: 'All' },
  addCustom: { id: 'connectorsView.addCustom', defaultMessage: 'Add a custom connector' },
  prerequisite: { id: 'connectorsView.prerequisite', defaultMessage: 'Before you start' },
  command: { id: 'connectorsView.command', defaultMessage: 'Runs as' },
  secretsTitle: { id: 'connectorsView.secretsTitle', defaultMessage: 'Credentials' },
  secretsHint: {
    id: 'connectorsView.secretsHint',
    defaultMessage:
      'Stored in the system keyring, never written into the config file. Leave blank to fill in later.',
  },
  optional: { id: 'connectorsView.optional', defaultMessage: 'optional' },
  cancel: { id: 'connectorsView.cancel', defaultMessage: 'Cancel' },
  confirmInstall: { id: 'connectorsView.confirmInstall', defaultMessage: 'Add connector' },
  installSuccess: { id: 'connectorsView.installSuccess', defaultMessage: 'Connector added' },
  installSuccessMsg: {
    id: 'connectorsView.installSuccessMsg',
    defaultMessage: '{name} is enabled. Its first call may take a moment while the package downloads.',
  },
  installFailed: { id: 'connectorsView.installFailed', defaultMessage: "Couldn't add the connector" },
  alreadyInstalled: {
    id: 'connectorsView.alreadyInstalled',
    defaultMessage: 'This connector is already in your extensions.',
  },
});

type Filter = 'all' | 'installed' | 'installable';

export default function ConnectorsView() {
  const intl = useIntl();
  const { addExtension, extensionsList } = useConfig();
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState(INSTALLED_CONNECTORS[0]?.id ?? '');
  const [pendingInstall, setPendingInstall] = useState<ConnectorEntry | null>(null);
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [installing, setInstalling] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  /**
   * Adding a connector the catalogue does not list reuses the extensions editor, so any
   * MCP server the user already knows about can be wired up without a code change.
   */
  const handleAddCustom = async (formData: ExtensionFormData) => {
    setShowAddModal(false);
    try {
      await activateExtensionDefault({
        addToConfig: addExtension,
        extensionConfig: createExtensionConfig(formData),
      });
      toastSuccess({
        title: intl.formatMessage(i18n.installSuccess),
        msg: intl.formatMessage(i18n.installSuccessMsg, { name: formData.name }),
      });
    } catch (error) {
      toastError({
        title: intl.formatMessage(i18n.installFailed),
        msg: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const all = [...INSTALLED_CONNECTORS, ...INSTALLABLE_CONNECTORS, ...PLANNED_CONNECTORS];
  const selected = all.find((entry) => entry.id === selectedId) ?? all[0] ?? null;

  /** Names already present in the user's extension config. */
  const configuredNames = useMemo(
    () => new Set((extensionsList ?? []).map((extension) => extension.name)),
    [extensionsList]
  );

  const sections: Array<{ key: Filter; label: string; hint: string; entries: ConnectorEntry[] }> = [
    {
      key: 'installed',
      label: intl.formatMessage(i18n.builtin),
      hint: intl.formatMessage(i18n.builtinHint),
      entries: INSTALLED_CONNECTORS,
    },
    {
      key: 'installable',
      label: intl.formatMessage(i18n.installable),
      hint: '',
      entries: INSTALLABLE_CONNECTORS,
    },
  ];

  const visibleSections = sections.filter((section) => filter === 'all' || filter === section.key);

  const openInstall = (entry: ConnectorEntry) => {
    setPendingInstall(entry);
    setSecretValues({});
  };

  const closeInstall = () => {
    setPendingInstall(null);
    setSecretValues({});
  };

  const confirmInstall = async () => {
    if (!pendingInstall) return;
    const name = pendingInstall.extensionName ?? pendingInstall.id;
    if (configuredNames.has(name)) {
      toastError({
        title: intl.formatMessage(i18n.installFailed),
        msg: intl.formatMessage(i18n.alreadyInstalled),
      });
      closeInstall();
      return;
    }

    setInstalling(true);
    try {
      const config = toExtensionConfig(pendingInstall, secretValues);
      await addExtension(name, config, true);
      toastSuccess({
        title: intl.formatMessage(i18n.installSuccess),
        msg: intl.formatMessage(i18n.installSuccessMsg, { name: pendingInstall.name }),
      });
      closeInstall();
    } catch (error) {
      console.error('Failed to add connector:', error);
      toastError({
        title: intl.formatMessage(i18n.installFailed),
        msg: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setInstalling(false);
    }
  };

  const renderRow = (entry: ConnectorEntry, dimmed = false) => {
    const name = entry.extensionName ?? entry.id;
    const isConfigured = entry.status === 'installed' || configuredNames.has(name);
    return (
      <button
        key={entry.id}
        onClick={() => setSelectedId(entry.id)}
        className={cn(
          'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors',
          selected?.id === entry.id
            ? 'border-border-primary bg-background-tertiary'
            : 'border-transparent hover:bg-background-tertiary/60'
        )}
      >
        <Plug
          className={cn('h-4 w-4 flex-shrink-0', dimmed ? 'text-text-tertiary' : 'text-text-secondary')}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                'flex-1 truncate text-sm',
                dimmed ? 'text-text-secondary' : 'text-text-primary'
              )}
            >
              {entry.name}
            </span>
            {isConfigured && <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-200" />}
          </span>
          {entry.package && (
            <span className="mt-0.5 block truncate font-mono text-[10px] text-text-tertiary">
              {entry.package}
            </span>
          )}
        </span>
      </button>
    );
  };

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
            <div className="flex gap-1.5">
              {(['all', 'installed', 'installable'] as Filter[]).map((value) => (
                <button
                  key={value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                    filter === value
                      ? 'border-border-primary bg-background-tertiary text-text-primary'
                      : 'border-border-secondary text-text-secondary hover:text-text-primary'
                  )}
                >
                  {value === 'all'
                    ? intl.formatMessage(i18n.all)
                    : value === 'installed'
                      ? intl.formatMessage(i18n.builtin)
                      : intl.formatMessage(i18n.installable)}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-1 rounded-full border border-border-secondary px-2.5 py-0.5 text-xs text-text-secondary transition-colors hover:border-border-primary hover:text-text-primary"
            >
              <Plus className="h-3 w-3" />
              {intl.formatMessage(i18n.addCustom)}
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {visibleSections.map((section) => (
              <div key={section.key} className="mb-2">
                <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-text-tertiary">
                  {section.label}
                </p>
                {section.entries.map((entry) => renderRow(entry))}
              </div>
            ))}

            {filter === 'all' && PLANNED_CONNECTORS.length > 0 && (
              <div className="mb-2">
                <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-text-tertiary">
                  {intl.formatMessage(i18n.planned)}
                </p>
                {PLANNED_CONNECTORS.map((entry) => renderRow(entry, true))}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selected && (
            <article className="max-w-3xl px-8 py-6">
              <header className="flex items-start gap-3">
                <div className="flex-1">
                  <h2 className="text-xl font-medium text-text-primary">{selected.name}</h2>
                  <p className="mt-1 text-sm text-text-secondary">{selected.description}</p>
                </div>
                <InstallAction
                  entry={selected}
                  configuredNames={configuredNames}
                  onInstall={() => openInstall(selected)}
                />
              </header>

              {selected.status === 'planned' && (
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-border-secondary px-3 py-2 text-xs text-text-secondary">
                  <AlertCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  {intl.formatMessage(i18n.plannedHint)}
                </p>
              )}

              {selected.prerequisite && (
                <section className="mt-4 rounded-xl border border-border-secondary p-4">
                  <h3 className="text-xs font-medium text-text-primary">
                    {intl.formatMessage(i18n.prerequisite)}
                  </h3>
                  <p className="mt-1.5 text-sm text-text-secondary">{selected.prerequisite}</p>
                </section>
              )}

              <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-secondary">
                <div className="flex gap-1.5">
                  <dt>{intl.formatMessage(i18n.transport)}:</dt>
                  <dd className="font-mono text-text-primary">
                    {selected.install?.type ?? '—'}
                  </dd>
                </div>
                {selected.package && (
                  <div className="flex gap-1.5">
                    <dt>{intl.formatMessage(i18n.source)}:</dt>
                    <dd className="font-mono text-text-primary">{selected.package}</dd>
                  </div>
                )}
                {selected.license && (
                  <div className="flex gap-1.5">
                    <dt>Licence:</dt>
                    <dd className="text-text-primary">{selected.license}</dd>
                  </div>
                )}
                {selected.status === 'installed' && (
                  <div className="flex gap-1.5">
                    <dt>{intl.formatMessage(i18n.installedLabel)}:</dt>
                    <dd className="text-text-primary">
                      {selected.defaultEnabled
                        ? intl.formatMessage(i18n.defaultOn)
                        : intl.formatMessage(i18n.defaultOff)}
                    </dd>
                  </div>
                )}
              </dl>

              {selected.install?.cmd && (
                <section className="mt-5 rounded-xl border border-border-secondary p-4">
                  <h3 className="text-xs font-medium text-text-primary">
                    {intl.formatMessage(i18n.command)}
                  </h3>
                  <code className="mt-1.5 block break-all font-mono text-xs text-text-primary">
                    {selected.install.cmd} {(selected.install.args ?? []).join(' ')}
                  </code>
                </section>
              )}

              <section className="mt-5 rounded-xl border border-border-secondary p-4">
                <h3 className="text-xs font-medium text-text-primary">
                  {intl.formatMessage(i18n.capabilities)}
                </h3>
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {selected.capabilities.map((capability) => (
                    <li
                      key={capability}
                      className="rounded-full border border-border-secondary px-2 py-0.5 text-[11px] text-text-secondary"
                    >
                      {capability}
                    </li>
                  ))}
                </ul>
              </section>

              {selected.homepage && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  onClick={() => window.open(selected.homepage, '_blank')}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  {intl.formatMessage(i18n.docs)}
                </Button>
              )}
            </article>
          )}
        </div>
      </div>

      {pendingInstall && (
        <SecretDialog
          entry={pendingInstall}
          values={secretValues}
          installing={installing}
          onChange={(key, value) => setSecretValues((prev) => ({ ...prev, [key]: value }))}
          onCancel={closeInstall}
          onConfirm={() => void confirmInstall()}
        />
      )}

      {showAddModal && (
        <ExtensionModal
          title={intl.formatMessage(i18n.addCustom)}
          initialData={getDefaultFormData()}
          onClose={() => setShowAddModal(false)}
          onSubmit={handleAddCustom}
          submitLabel={intl.formatMessage(i18n.install)}
          modalType="add"
        />
      )}
    </MainPanelLayout>
  );
}

function InstallAction({
  entry,
  configuredNames,
  onInstall,
}: {
  entry: ConnectorEntry;
  configuredNames: Set<string>;
  onInstall: () => void;
}) {
  const intl = useIntl();
  const name = entry.extensionName ?? entry.id;

  if (entry.status === 'installed') {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-background-tertiary px-3 py-1 text-xs text-text-primary">
        <Check className="h-3.5 w-3.5" />
        {intl.formatMessage(i18n.builtin)}
      </span>
    );
  }
  if (entry.status === 'planned') {
    return (
      <span className="rounded-full border border-border-secondary px-3 py-1 text-xs text-text-tertiary">
        {intl.formatMessage(i18n.planned)}
      </span>
    );
  }
  if (configuredNames.has(name)) {
    return (
      <span className="flex items-center gap-1.5 rounded-full bg-background-tertiary px-3 py-1 text-xs text-text-primary">
        <Check className="h-3.5 w-3.5" />
        {intl.formatMessage(i18n.installedLabel)}
      </span>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={onInstall}>
      <Download className="mr-1.5 h-3.5 w-3.5" />
      {intl.formatMessage(i18n.install)}
    </Button>
  );
}

function SecretDialog({
  entry,
  values,
  installing,
  onChange,
  onCancel,
  onConfirm,
}: {
  entry: ConnectorEntry;
  values: Record<string, string>;
  installing: boolean;
  onChange: (key: string, value: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const intl = useIntl();
  const secrets: ConnectorSecret[] = entry.install?.secrets ?? [];
  const requiredMissing = secrets.some((secret) => !secret.optional && !values[secret.key]?.trim());

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/30 p-6">
      <div className="w-full max-w-md rounded-xl border border-border-secondary bg-background-primary p-5">
        <h3 className="text-sm font-medium text-text-primary">
          {intl.formatMessage(i18n.install)}: {entry.name}
        </h3>

        {secrets.length === 0 ? (
          <p className="mt-2 text-sm text-text-secondary">{entry.description}</p>
        ) : (
          <>
            <p className="mt-1.5 text-xs text-text-secondary">
              {intl.formatMessage(i18n.secretsHint)}
            </p>
            <div className="mt-3 space-y-3">
              {secrets.map((secret) => (
                <label key={secret.key} className="block">
                  <span className="flex items-baseline gap-1.5 text-xs text-text-primary">
                    {secret.label}
                    {secret.optional && (
                      <span className="text-text-tertiary">
                        ({intl.formatMessage(i18n.optional)})
                      </span>
                    )}
                  </span>
                  <input
                    type="password"
                    value={values[secret.key] ?? ''}
                    onChange={(event) => onChange(secret.key, event.target.value)}
                    placeholder={secret.key}
                    className="mt-1 w-full rounded-lg border border-border-secondary bg-background-primary px-3 py-1.5 font-mono text-xs text-text-primary outline-none focus:border-border-primary"
                  />
                  <span className="mt-1 block text-[11px] text-text-tertiary">{secret.hint}</span>
                </label>
              ))}
            </div>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={installing}>
            {intl.formatMessage(i18n.cancel)}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onConfirm}
            disabled={installing || requiredMissing}
          >
            {installing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {installing
              ? intl.formatMessage(i18n.installing)
              : intl.formatMessage(i18n.confirmInstall)}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Kept for the planned-connector icon in the list. */

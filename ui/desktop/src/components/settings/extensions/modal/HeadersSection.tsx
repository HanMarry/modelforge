import React from 'react';
import { Button } from '../../../ui/button';
import { Plus, X } from 'lucide-react';
import { Input } from '../../../ui/input';
import { cn } from '../../../../utils';
import { defineMessages, useIntl } from '../../../../i18n';
import type { ExtensionHeaderRow } from '../utils';
import {
  isAuthHeaderName,
  SAVED_VALUE_MASK,
} from '../../providers/modal/subcomponents/forms/sensitiveHeaders';

const i18n = defineMessages({
  requestHeaders: {
    id: 'headersSection.requestHeaders',
    defaultMessage: 'Request Headers',
  },
  headersDescription: {
    id: 'headersSection.headersDescription',
    defaultMessage: 'Add custom HTTP headers to include in requests to the MCP server. Click the "+" button to add after filling both fields.',
  },
  headerName: {
    id: 'headersSection.headerName',
    defaultMessage: 'Header name',
  },
  value: {
    id: 'headersSection.value',
    defaultMessage: 'Value',
  },
  bothRequired: {
    id: 'headersSection.bothRequired',
    defaultMessage: 'Both header name and value must be entered',
  },
  noSpaces: {
    id: 'headersSection.noSpaces',
    defaultMessage: 'Header name cannot contain spaces',
  },
  duplicateHeader: {
    id: 'headersSection.duplicateHeader',
    defaultMessage: 'A header with this name already exists',
  },
  add: {
    id: 'headersSection.add',
    defaultMessage: 'Add',
  },
  sensitive: {
    id: 'headersSection.sensitive',
    defaultMessage: 'Sensitive',
  },
  markSensitive: {
    id: 'headersSection.markSensitive',
    defaultMessage: 'Mark {name} as sensitive',
  },
  markNewSensitive: {
    id: 'headersSection.markNewSensitive',
    defaultMessage: 'Mark the new header as sensitive',
  },
  sensitiveHint: {
    id: 'headersSection.sensitiveHint',
    defaultMessage:
      'Sensitive values are kept in the system credential store and are not shown again. Authorization, Proxy-Authorization, X-API-Key and api-key are always sensitive.',
  },
  savedValueLabel: {
    id: 'headersSection.savedValueLabel',
    defaultMessage: 'Saved value of {name} is hidden. Type a new value to replace it.',
  },
  reenterSavedValues: {
    id: 'headersSection.reenterSavedValues',
    defaultMessage:
      'Saved values are tied to the extension name. After renaming, enter them again: {names}',
  },
});

/** The header typed into the last row but not added yet. */
export interface PendingHeader {
  key: string;
  value: string;
  sensitive: boolean;
}

interface HeadersSectionProps {
  headers: ExtensionHeaderRow[];
  onAdd: (key: string, value: string, sensitive: boolean) => void;
  onRemove: (index: number) => void;
  onChange: (index: number, field: 'key' | 'value', value: string) => void;
  onSensitiveChange: (index: number, sensitive: boolean) => void;
  submitAttempted: boolean;
  /**
   * Saved values are stored under the extension name, so they cannot follow a renamed
   * extension and have to be typed again.
   */
  storedValuesNeedReentry?: boolean;
  onPendingInputChange: (hasPendingInput: boolean, pendingHeader: PendingHeader | null) => void;
}

/** Auth header names are always sensitive (requirement 1.1). */
function isRowSensitive(header: Pick<ExtensionHeaderRow, 'key' | 'sensitive'>): boolean {
  return Boolean(header.sensitive) || isAuthHeaderName(header.key);
}

export default function HeadersSection({
  headers,
  onAdd,
  onRemove,
  onChange,
  onSensitiveChange,
  submitAttempted,
  storedValuesNeedReentry = false,
  onPendingInputChange,
}: HeadersSectionProps) {
  const intl = useIntl();
  const [newKey, setNewKey] = React.useState('');
  const [newValue, setNewValue] = React.useState('');
  const [newSensitive, setNewSensitive] = React.useState(false);
  const [validationError, setValidationError] = React.useState<string | null>(null);
  const [invalidFields, setInvalidFields] = React.useState<{ key: boolean; value: boolean }>({
    key: false,
    value: false,
  });
  const newRowSensitive = newSensitive || isAuthHeaderName(newKey);

  // Notify parent when pending input changes
  React.useEffect(() => {
    const hasPendingInput = newKey.trim() !== '' || newValue.trim() !== '';
    const pendingHeader =
      newKey.trim() && newValue.trim()
        ? { key: newKey, value: newValue, sensitive: newRowSensitive }
        : null;
    onPendingInputChange(hasPendingInput, pendingHeader);
  }, [newKey, newValue, newRowSensitive, onPendingInputChange]);

  const handleAdd = () => {
    const keyEmpty = !newKey.trim();
    const valueEmpty = !newValue.trim();
    const keyHasSpaces = newKey.includes(' ');
    const normalizedNewKey = newKey.trim().toLowerCase();
    const isDuplicate = headers.some((h) => h.key.trim().toLowerCase() === normalizedNewKey);

    if (keyEmpty || valueEmpty) {
      setInvalidFields({
        key: keyEmpty,
        value: valueEmpty,
      });
      setValidationError(intl.formatMessage(i18n.bothRequired));
      return;
    }

    if (keyHasSpaces) {
      setInvalidFields({
        key: true,
        value: false,
      });
      setValidationError(intl.formatMessage(i18n.noSpaces));
      return;
    }

    if (isDuplicate) {
      setInvalidFields({
        key: true,
        value: false,
      });
      setValidationError(intl.formatMessage(i18n.duplicateHeader));
      return;
    }

    setValidationError(null);
    setInvalidFields({ key: false, value: false });
    onAdd(newKey, newValue, newRowSensitive);
    setNewKey('');
    setNewValue('');
    setNewSensitive(false);
  };

  const clearValidation = () => {
    setValidationError(null);
    setInvalidFields({ key: false, value: false });
  };

  /** A saved value counts as filled in unless the extension was renamed. */
  const keepsSavedValue = (header: ExtensionHeaderRow) =>
    Boolean(header.storedReference) && !storedValuesNeedReentry;

  const isFieldInvalid = (index: number, field: 'key' | 'value') => {
    if (!submitAttempted) return false;
    const header = headers[index];
    if (header[field].trim() !== '') return false;
    return field === 'key' || !keepsSavedValue(header);
  };

  const headersToReenter = storedValuesNeedReentry
    ? headers.filter((header) => header.storedReference && header.value.trim() === '')
    : [];

  return (
    <div>
      <div className="relative mb-2">
        <label className="text-sm font-medium text-text-primary mb-2 block">{intl.formatMessage(i18n.requestHeaders)}</label>
        <p className="text-xs text-text-secondary mb-4">
          {intl.formatMessage(i18n.headersDescription)}
        </p>
      </div>
      <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-center">
        {/* Existing headers */}
        {headers.map((header, index) => {
          const headerName = header.key.trim() || intl.formatMessage(i18n.headerName);
          const sensitive = isRowSensitive(header);
          // A saved sensitive value is never read back: the field stays empty and only shows
          // the mask until a new value is typed (requirement 1.11).
          const savedValueLabel = header.storedReference
            ? intl.formatMessage(i18n.savedValueLabel, { name: headerName })
            : undefined;
          return (
            <React.Fragment key={index}>
              <div className="relative">
                <Input
                  value={header.key}
                  onChange={(e) => onChange(index, 'key', e.target.value)}
                  placeholder={intl.formatMessage(i18n.headerName)}
                  className={cn(
                    'w-full text-text-primary border-border-primary hover:border-border-primary',
                    isFieldInvalid(index, 'key') && 'border-red-500 focus:border-red-500'
                  )}
                />
              </div>
              <div className="relative">
                <Input
                  type={sensitive ? 'password' : 'text'}
                  value={header.value}
                  onChange={(e) => onChange(index, 'value', e.target.value)}
                  placeholder={
                    header.storedReference ? SAVED_VALUE_MASK : intl.formatMessage(i18n.value)
                  }
                  aria-label={savedValueLabel}
                  title={savedValueLabel}
                  autoComplete="off"
                  className={cn(
                    'w-full text-text-primary border-border-primary hover:border-border-primary',
                    isFieldInvalid(index, 'value') && 'border-red-500 focus:border-red-500'
                  )}
                />
              </div>
              <label className="flex items-center gap-1 text-xs text-text-secondary whitespace-nowrap">
                <input
                  type="checkbox"
                  checked={sensitive}
                  disabled={isAuthHeaderName(header.key)}
                  onChange={(e) => onSensitiveChange(index, e.target.checked)}
                  aria-label={intl.formatMessage(i18n.markSensitive, { name: headerName })}
                  className="rounded border-border-primary"
                />
                {intl.formatMessage(i18n.sensitive)}
              </label>
              <Button
                onClick={() => onRemove(index)}
                variant="ghost"
                className="group p-2 h-auto text-iconSubtle hover:bg-transparent"
              >
                <X className="h-3 w-3 text-gray-400 group-hover:text-white group-hover:drop-shadow-sm transition-all" />
              </Button>
            </React.Fragment>
          );
        })}

        {/* Empty row with Add button */}
        <Input
          value={newKey}
          onChange={(e) => {
            setNewKey(e.target.value);
            clearValidation();
          }}
          placeholder={intl.formatMessage(i18n.headerName)}
          className={cn(
            'w-full text-text-primary border-border-primary hover:border-border-primary',
            invalidFields.key && 'border-red-500 focus:border-red-500'
          )}
        />
        <Input
          type={newRowSensitive ? 'password' : 'text'}
          value={newValue}
          onChange={(e) => {
            setNewValue(e.target.value);
            clearValidation();
          }}
          placeholder={intl.formatMessage(i18n.value)}
          autoComplete="off"
          className={cn(
            'w-full text-text-primary border-border-primary hover:border-border-primary',
            invalidFields.value && 'border-red-500 focus:border-red-500'
          )}
        />
        <label className="flex items-center gap-1 text-xs text-text-secondary whitespace-nowrap">
          <input
            type="checkbox"
            checked={newRowSensitive}
            disabled={isAuthHeaderName(newKey)}
            onChange={(e) => setNewSensitive(e.target.checked)}
            aria-label={intl.formatMessage(i18n.markNewSensitive)}
            className="rounded border-border-primary"
          />
          {intl.formatMessage(i18n.sensitive)}
        </label>
        <Button
          onClick={handleAdd}
          variant="ghost"
          className="flex items-center justify-start gap-1 px-2 pr-4 text-sm rounded-full text-text-primary bg-background-primary border border-border-primary hover:border-border-primary transition-colors min-w-[60px] h-9 [&>svg]:!size-4"
        >
          <Plus /> {intl.formatMessage(i18n.add)}
        </Button>
      </div>
      <p className="mt-2 text-xs text-text-secondary">{intl.formatMessage(i18n.sensitiveHint)}</p>
      {headersToReenter.length > 0 && (
        <div role="alert" className="mt-2 text-red-500 text-sm">
          {intl.formatMessage(i18n.reenterSavedValues, {
            names: headersToReenter.map((header) => header.key).join(', '),
          })}
        </div>
      )}
      {validationError && <div className="mt-2 text-red-500 text-sm">{validationError}</div>}
    </div>
  );
}

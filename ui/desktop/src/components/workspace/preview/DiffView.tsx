import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  empty: {
    id: 'diffView.empty',
    defaultMessage: 'No textual changes for this file',
  },
  truncated: {
    id: 'diffView.truncated',
    defaultMessage: 'Diff truncated',
  },
});

const MAX_LINES = 2000;

interface DiffLine {
  kind: 'add' | 'remove' | 'hunk' | 'meta' | 'context';
  text: string;
}

function classify(line: string): DiffLine['kind'] {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  return 'context';
}

const LINE_CLASS: Record<DiffLine['kind'], string> = {
  add: 'bg-[#e6ffec] text-[#0a7d3f] dark:bg-[#0f2f1b] dark:text-[#7ee2a8]',
  remove: 'bg-[#ffebe9] text-[#a40e26] dark:bg-[#3a1418] dark:text-[#ff9b9b]',
  hunk: 'bg-background-secondary text-text-tertiary',
  meta: 'text-text-tertiary',
  context: 'text-text-secondary',
};

interface DiffViewProps {
  diff: string;
}

/** Unified-diff renderer: green additions, red removals, muted hunk headers. */
export default function DiffView({ diff }: DiffViewProps) {
  const intl = useIntl();

  const lines: DiffLine[] = [];
  for (const raw of diff.split('\n')) {
    if (lines.length >= MAX_LINES) break;
    if (raw.startsWith('index ') || raw.startsWith('new file') || raw.startsWith('deleted file'))
      continue;
    lines.push({ kind: classify(raw), text: raw });
  }

  if (lines.length === 0) {
    return (
      <p className="px-2 py-1 text-[10px] text-text-tertiary">{intl.formatMessage(i18n.empty)}</p>
    );
  }

  return (
    <div className="max-h-72 overflow-auto rounded border border-border-primary bg-background-primary">
      <pre className="font-mono text-[11px] leading-5">
        {lines.map((line, index) => (
          <div
            key={index}
            className={`whitespace-pre-wrap break-words px-2 ${LINE_CLASS[line.kind]}`}
          >
            {line.text || ' '}
          </div>
        ))}
      </pre>
      {diff.split('\n').length > MAX_LINES && (
        <p className="px-2 py-1 text-[10px] text-text-tertiary">
          {intl.formatMessage(i18n.truncated)}
        </p>
      )}
    </div>
  );
}

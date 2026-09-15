import { useMemo } from 'react';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  header: {
    id: 'hexPreview.header',
    defaultMessage: 'Binary preview',
  },
  truncated: {
    id: 'hexPreview.truncated',
    defaultMessage: 'Showing the first {bytes} bytes of {size}',
  },
});

const PREVIEW_BYTES = 4096;
const BYTES_PER_ROW = 16;

interface HexPreviewProps {
  base64: string;
  size: number;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function decodeBase64(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export default function HexPreview({ base64, size }: HexPreviewProps) {
  const intl = useIntl();

  const rows = useMemo(() => {
    const bytes = decodeBase64(base64).subarray(0, PREVIEW_BYTES);
    const lines: { offset: string; hex: string; ascii: string }[] = [];
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
      const chunk = bytes.subarray(offset, offset + BYTES_PER_ROW);
      const hex = Array.from(chunk)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(' ');
      const ascii = Array.from(chunk)
        .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '·'))
        .join('');
      lines.push({
        offset: offset.toString(16).padStart(8, '0'),
        hex: hex.padEnd(BYTES_PER_ROW * 3 - 1, ' '),
        ascii,
      });
    }
    return lines;
  }, [base64]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <pre className="font-mono text-[11px] leading-5 text-text-secondary">
          {rows.map((row) => (
            <div key={row.offset} className="whitespace-pre">
              <span className="text-text-tertiary">{row.offset}</span>
              {'  '}
              {row.hex}
              {'  '}
              <span className="text-text-primary">{row.ascii}</span>
            </div>
          ))}
        </pre>
      </div>
      <div className="border-t border-border-primary px-2 py-1 text-[10px] text-text-tertiary">
        {intl.formatMessage(i18n.header)} ·{' '}
        {intl.formatMessage(i18n.truncated, {
          bytes: Math.min(PREVIEW_BYTES, size),
          size: formatSize(size),
        })}
      </div>
    </div>
  );
}

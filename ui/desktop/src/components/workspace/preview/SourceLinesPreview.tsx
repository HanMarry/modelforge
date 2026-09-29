import { useEffect, useMemo, useRef } from 'react';
import { cn } from '../../../utils';

/** Lines rendered on each side of the target in very long files. */
const WINDOW_LINES = 2000;

interface SourceLinesPreviewProps {
  content: string;
  /** 1-based line to scroll to and highlight. */
  line: number;
}

/**
 * Source text with line numbers, scrolled to `line` and highlighted. Used when a paper check or
 * review finding opens a source file at a line (layer-c-contract-desktop.md, paper branch).
 */
export default function SourceLinesPreview({ content, line }: SourceLinesPreviewProps) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const lines = useMemo(() => content.split(/\r\n|\r|\n/), [content]);
  const target = Math.min(Math.max(Math.trunc(line), 1), lines.length);
  const first = Math.max(1, target - WINDOW_LINES);
  const last = Math.min(lines.length, target + WINDOW_LINES);

  useEffect(() => {
    // jsdom has no scrollIntoView.
    targetRef.current?.scrollIntoView?.({ block: 'center' });
  }, [target, content]);

  return (
    <div className="h-full overflow-auto" data-testid="source-lines-preview">
      <div className="py-2 font-mono text-xs leading-5 text-text-primary">
        {lines.slice(first - 1, last).map((text, index) => {
          const number = first + index;
          const current = number === target;
          return (
            <div
              key={number}
              ref={current ? targetRef : undefined}
              data-line={number}
              aria-current={current ? 'location' : undefined}
              className={cn('flex', current && 'bg-background-info/20')}
            >
              <span className="w-12 shrink-0 select-none pr-3 text-right text-text-tertiary">
                {number}
              </span>
              <span className="min-w-0 whitespace-pre-wrap break-words pr-3">{text || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

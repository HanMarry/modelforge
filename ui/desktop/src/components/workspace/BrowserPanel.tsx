import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import type { BrowserNavState } from '../../utils/browser/browserPanelHost';
import { cn } from '../../utils';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  address: { id: 'browserPanel.address', defaultMessage: 'Search or enter URL' },
  back: { id: 'browserPanel.back', defaultMessage: 'Back' },
  forward: { id: 'browserPanel.forward', defaultMessage: 'Forward' },
  reload: { id: 'browserPanel.reload', defaultMessage: 'Reload' },
  schemeRejected: { id: 'browserPanel.schemeRejected', defaultMessage: 'URL protocol not supported' },
  loadFailed: { id: 'browserPanel.loadFailed', defaultMessage: 'Could not load the page' },
  retry: { id: 'browserPanel.retry', defaultMessage: 'Retry' },
});

interface BrowserPanelProps {
  active: boolean;
}

export default function BrowserPanel({ active }: BrowserPanelProps) {
  const intl = useIntl();
  const [state, setState] = useState<BrowserNavState | null>(null);
  const [address, setAddress] = useState('');
  const [lastSubmitted, setLastSubmitted] = useState('');
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const listener = (_event: unknown, ...args: unknown[]) => {
      const next = args[0] as BrowserNavState;
      setState(next);
      setAddress((current) => (current === lastSubmitted ? next.url : current));
    };
    window.electron.on('browser-state', listener);
    return () => window.electron.off('browser-state', listener);
  }, [lastSubmitted]);

  useEffect(() => {
    if (!active || !contentRef.current) return undefined;
    const report = () => {
      const rect = contentRef.current?.getBoundingClientRect();
      if (!rect) return;
      window.electron.browserSetBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(contentRef.current);
    return () => {
      observer.disconnect();
      window.electron.browserSetBounds(null);
    };
  }, [active]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const target = address.trim();
    if (!target) return;
    setLastSubmitted(target);
    window.electron.browserNavigate(target);
  };

  const retry = () => {
    if (lastSubmitted) window.electron.browserNavigate(lastSubmitted);
    else window.electron.browserReload();
  };

  const error = state?.error ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={submit}
        className="flex items-center gap-1 border-b border-border-primary px-2 py-1.5"
      >
        <button
          type="button"
          title={intl.formatMessage(i18n.back)}
          aria-label={intl.formatMessage(i18n.back)}
          disabled={!state?.canGoBack}
          onClick={() => window.electron.browserBack()}
          className="rounded p-1 text-text-secondary transition-colors hover:bg-background-tertiary disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={intl.formatMessage(i18n.forward)}
          aria-label={intl.formatMessage(i18n.forward)}
          disabled={!state?.canGoForward}
          onClick={() => window.electron.browserForward()}
          className="rounded p-1 text-text-secondary transition-colors hover:bg-background-tertiary disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title={intl.formatMessage(i18n.reload)}
          aria-label={intl.formatMessage(i18n.reload)}
          onClick={() => window.electron.browserReload()}
          className="rounded p-1 text-text-secondary transition-colors hover:bg-background-tertiary"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
        <input
          type="text"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          placeholder={intl.formatMessage(i18n.address)}
          className="ml-1 min-w-0 flex-1 rounded border border-border-primary bg-background-secondary px-2 py-1 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
      </form>

      {error && (
        <div role="alert" className="flex items-center gap-2 border-b border-border-primary px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-xs text-amber-600 dark:text-amber-400">
            {error.kind === 'scheme'
              ? intl.formatMessage(i18n.schemeRejected)
              : intl.formatMessage(i18n.loadFailed)}
          </span>
          {error.kind === 'load' && (
            <button
              type="button"
              onClick={retry}
              className="rounded px-2 py-0.5 text-xs text-text-primary hover:bg-background-tertiary"
            >
              {intl.formatMessage(i18n.retry)}
            </button>
          )}
        </div>
      )}

      <div ref={contentRef} className={cn('relative min-h-0 flex-1')}>
        {state?.loading && <div className="text-xs text-text-tertiary">…</div>}
      </div>
    </div>
  );
}

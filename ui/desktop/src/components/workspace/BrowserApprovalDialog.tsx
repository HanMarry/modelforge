import { useEffect, useState } from 'react';
import type { BrowserApprovalRequest } from '../../utils/browser/browserPanelHost';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  title: { id: 'browserApproval.title', defaultMessage: 'Browser action needs approval' },
  click: { id: 'browserApproval.click', defaultMessage: 'Click' },
  type: { id: 'browserApproval.type', defaultMessage: 'Type' },
  target: { id: 'browserApproval.target', defaultMessage: 'Target element' },
  text: { id: 'browserApproval.text', defaultMessage: 'Text to type' },
  currentUrl: { id: 'browserApproval.currentUrl', defaultMessage: 'Current page' },
  approve: { id: 'browserApproval.approve', defaultMessage: 'Approve' },
  deny: { id: 'browserApproval.deny', defaultMessage: 'Deny' },
});

/**
 * Approval dialog for Kernel-initiated `browser_click` / `browser_type` (requirement 12.3). It is
 * mounted once at the app root and listens for `browser-approval-request`; the main process holds
 * the pending tool call until the user responds.
 */
export default function BrowserApprovalDialog() {
  const intl = useIntl();
  const [request, setRequest] = useState<BrowserApprovalRequest | null>(null);

  useEffect(() => {
    const listener = (_event: unknown, ...args: unknown[]) =>
      setRequest(args[0] as BrowserApprovalRequest);
    window.electron.on('browser-approval-request', listener);
    return () => window.electron.off('browser-approval-request', listener);
  }, []);

  if (!request) return null;

  const respond = (approved: boolean) => {
    window.electron.browserApprovalRespond(request.id, approved);
    setRequest(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[420px] max-w-[90vw] overflow-hidden rounded-2xl border border-border-primary bg-background-primary">
        <div className="bg-background-secondary px-4 py-2 text-text-primary">
          {intl.formatMessage(i18n.title)}
        </div>
        <div className="space-y-2 px-4 py-3 text-sm">
          <div>
            <div className="text-text-tertiary">{intl.formatMessage(i18n.target)}</div>
            <div className="break-words text-text-primary">{request.description}</div>
          </div>
          {request.action === 'type' && (
            <div>
              <div className="text-text-tertiary">{intl.formatMessage(i18n.text)}</div>
              <div className="break-words text-text-primary">{request.text}</div>
            </div>
          )}
          <div>
            <div className="text-text-tertiary">{intl.formatMessage(i18n.currentUrl)}</div>
            <div className="break-words text-text-secondary">{request.url}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border-primary px-4 py-3">
          <button
            type="button"
            onClick={() => respond(false)}
            className="rounded px-3 py-1 text-sm text-text-secondary hover:bg-background-tertiary"
          >
            {intl.formatMessage(i18n.deny)}
          </button>
          <button
            type="button"
            onClick={() => respond(true)}
            className="rounded bg-background-info px-3 py-1 text-sm text-text-inverse hover:opacity-90"
          >
            {intl.formatMessage(i18n.approve)}
          </button>
        </div>
      </div>
    </div>
  );
}

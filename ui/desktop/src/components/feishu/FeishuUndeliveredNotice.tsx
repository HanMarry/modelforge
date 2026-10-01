import { useEffect, useState } from 'react';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  undelivered: {
    id: 'feishu.undeliveredNotice',
    defaultMessage: '飞书回复未送达（{time}），结果仍保留在本会话中。',
  },
});

/**
 * Session-page notice for a Feishu-driven session whose result could not be delivered to the
 * chat after the retries (requirement 15.2). The mark comes from the main process and is
 * pushed again whenever another reply fails.
 */
export default function FeishuUndeliveredNotice({ sessionId }: { sessionId: string }) {
  const intl = useIntl();
  const [markedAt, setMarkedAt] = useState<string | null>(null);

  useEffect(() => {
    setMarkedAt(null);
    const electron = window.electron;
    // Older preloads and test doubles may not have the Feishu channels.
    if (
      typeof electron?.feishuUndelivered !== 'function' ||
      typeof electron.onFeishuUndelivered !== 'function'
    ) {
      return undefined;
    }
    let active = true;
    electron.feishuUndelivered(sessionId).then(
      (result) => {
        if (active && result.ok && result.data) {
          setMarkedAt(result.data.markedAt);
        }
      },
      () => {}
    );
    const unsubscribe = electron.onFeishuUndelivered((event) => {
      if (event.sessionId === sessionId) {
        setMarkedAt(event.markedAt);
      }
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [sessionId]);

  if (!markedAt) {
    return null;
  }
  return (
    <div role="status" className="mx-4 mb-2 text-sm text-text-warning">
      {intl.formatMessage(i18n.undelivered, {
        time: intl.formatDate(markedAt, { dateStyle: 'short', timeStyle: 'short' }),
      })}
    </div>
  );
}

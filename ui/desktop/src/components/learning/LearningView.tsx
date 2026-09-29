import { MainPanelLayout } from '../Layout/MainPanelLayout';
import { defineMessages, useIntl } from '../../i18n';

const i18n = defineMessages({
  title: { id: 'learning.title', defaultMessage: 'Learning Path' },
});

/**
 * Learning path page at `/learning` (requirement 20, task 27.6). C0 placeholder:
 * `mp/s2-c1-learning` replaces the body with the course groups, exercises and progress.
 */
export default function LearningView() {
  const intl = useIntl();

  return (
    <MainPanelLayout>
      <div className="px-4 pt-4 pb-3">
        <h1 className="text-sm font-medium text-text-primary">{intl.formatMessage(i18n.title)}</h1>
      </div>
    </MainPanelLayout>
  );
}

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useModelAndProvider } from '../ModelAndProviderContext';
import { acpListProviderDetails, acpReadDefaults } from '../../acp/providers';
import { ModelForgeMark } from '../icons/ModelForge';
import { Button } from '../ui/button';
import OnboardingWizard from './OnboardingWizard';
import { defineMessages, useIntl } from '../../i18n';
import type { OnboardingState } from '../../utils/settings';

const i18n = defineMessages({
  welcomeTitle: {
    id: 'onboardingGuard.welcomeTitle',
    defaultMessage: 'Welcome to ModelForge',
  },
  welcomeDescription: {
    id: 'onboardingGuard.welcomeDescription',
    defaultMessage: 'Your local AI agent. Connect an AI model provider to get started.',
  },
  checkProviderErrorTitle: {
    id: 'onboardingGuard.checkProviderErrorTitle',
    defaultMessage: 'Unable to connect to ModelForge server',
  },
  checkProviderErrorDescription: {
    id: 'onboardingGuard.checkProviderErrorDescription',
    defaultMessage: 'The server may be starting up or temporarily unavailable.',
  },
  retry: {
    id: 'onboardingGuard.retry',
    defaultMessage: 'Retry',
  },
});

interface OnboardingGuardProps {
  children: React.ReactNode;
}

/**
 * First-boot gate (requirement 5.1): when no provider is configured and there is no
 * "completed" record, the four-step wizard renders instead of the app. Skipped steps are
 * later offered as "补做" entries from the diagnostics centre.
 */
export default function OnboardingGuard({ children }: OnboardingGuardProps) {
  const intl = useIntl();
  const navigate = useNavigate();
  const { getFallbackModelAndProvider } = useModelAndProvider();

  const [isCheckingProvider, setIsCheckingProvider] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const [checkProviderError, setCheckProviderError] = useState(false);

  const checkProvider = async () => {
    setIsCheckingProvider(true);
    setCheckProviderError(false);
    try {
      const onboarding = (await window.electron.getSetting('onboarding')) as OnboardingState | null;
      if (onboarding?.completed) {
        setShowWizard(false);
        setIsCheckingProvider(false);
        return;
      }

      const providers = await acpListProviderDetails();
      const configured = providers.filter((provider) => provider.is_configured);
      if (configured.length > 0) {
        setShowWizard(false);
        setIsCheckingProvider(false);
        return;
      }

      // Fall back to the default provider, which covers providers configured outside the
      // inventory (the same check the previous onboarding flow used).
      const { providerId } = await acpReadDefaults();
      if (providerId?.trim()) {
        setShowWizard(false);
        setIsCheckingProvider(false);
        return;
      }

      const fallback = await getFallbackModelAndProvider();
      if (fallback.provider?.trim()) {
        setShowWizard(false);
        setIsCheckingProvider(false);
        return;
      }

      setShowWizard(true);
      setIsCheckingProvider(false);
    } catch (error) {
      console.error('Error checking provider:', error);
      setCheckProviderError(true);
      setIsCheckingProvider(false);
    }
  };

  useEffect(() => {
    checkProvider();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isCheckingProvider) {
    return null;
  }

  if (checkProviderError) {
    return (
      <div className="h-screen w-full bg-background-default flex flex-col items-center justify-center">
        <div className="text-center max-w-md">
          <div className="mb-4">
            <ModelForgeMark className="size-8 mx-auto" />
          </div>
          <h1 className="text-xl font-light mb-3">{intl.formatMessage(i18n.checkProviderErrorTitle)}</h1>
          <p className="text-text-muted mb-6">{intl.formatMessage(i18n.checkProviderErrorDescription)}</p>
          <Button onClick={() => checkProvider()}>{intl.formatMessage(i18n.retry)}</Button>
        </div>
      </div>
    );
  }

  if (!showWizard) {
    return <>{children}</>;
  }

  return (
    <div className="h-screen w-full bg-background-default overflow-hidden">
      <div className="h-full overflow-y-auto">
        <div className="flex flex-col items-center p-4 pt-[12vh]">
          <div className="max-w-xl w-full mx-auto text-left">
            <div className="mb-4">
              <ModelForgeMark className="size-8" />
            </div>
            <h1 className="mb-3 text-2xl font-light sm:text-4xl">
              {intl.formatMessage(i18n.welcomeTitle)}
            </h1>
            <p className="mb-8 text-base text-text-muted sm:text-lg">
              {intl.formatMessage(i18n.welcomeDescription)}
            </p>
            <OnboardingWizard onComplete={() => navigate('/', { replace: true })} />
          </div>
        </div>
      </div>
    </div>
  );
}

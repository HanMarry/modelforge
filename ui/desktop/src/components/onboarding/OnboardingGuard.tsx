import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { useModelAndProvider } from '../ModelAndProviderContext';
import { acpReadConfig } from '../../acp/config';
import {
  acpListProviderDetails,
  acpListProviderSecrets,
  acpReadDefaults,
} from '../../acp/providers';
import { ModelForgeMark } from '../icons/ModelForge';
import { Button } from '../ui/button';
import OnboardingWizard from './OnboardingWizard';
import {
  hasConfiguredProviderEntry,
  hasStoredCredential,
  isConfiguredByUser,
} from './userConfiguredProviders';
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
 * Whether the kernel holds a provider key or sign-in token. Listing them reads the kernel's
 * secret store; the other checks have reached the kernel by then, so a store that cannot be read
 * counts as holding none rather than keeping the app on the connection error.
 */
async function hasStoredProviderCredential(): Promise<boolean> {
  try {
    return hasStoredCredential(await acpListProviderSecrets());
  } catch (error) {
    console.warn('Could not list provider credentials:', error);
    return false;
  }
}

/**
 * First-boot gate (requirement 5.1): when the user has not set up a provider and there is no
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

  /**
   * Whether the user has set up a model provider. What a clean machine already reports does not
   * count: the inventory marks several providers as configured before the user did anything
   * (see userConfiguredProviders.ts).
   */
  const hasProviderSetUp = async (): Promise<boolean> => {
    // The default provider: `active_provider` or `GOOSE_PROVIDER`, in config.yaml or the
    // environment (the check the previous onboarding flow used).
    const { providerId } = await acpReadDefaults();
    if (providerId?.trim()) {
      return true;
    }
    if (hasConfiguredProviderEntry(await acpReadConfig('providers'))) {
      return true;
    }
    const providers = await acpListProviderDetails();
    if (providers.some(isConfiguredByUser)) {
      return true;
    }
    if (await hasStoredProviderCredential()) {
      return true;
    }
    // A distribution may bundle a default provider (GOOSE_DEFAULT_PROVIDER).
    const fallback = await getFallbackModelAndProvider();
    return !!fallback.provider?.trim();
  };

  const checkProvider = async () => {
    setIsCheckingProvider(true);
    setCheckProviderError(false);
    try {
      const onboarding = (await window.electron.getSetting('onboarding')) as OnboardingState | null;
      const setUp = onboarding?.completed || (await hasProviderSetUp());
      setShowWizard(!setUp);
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
            <OnboardingWizard
              onComplete={() => {
                // Navigating to "/" from "/" keeps this guard mounted, so leave the wizard
                // explicitly; otherwise it stays on screen after the last step.
                setShowWizard(false);
                navigate('/', { replace: true });
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

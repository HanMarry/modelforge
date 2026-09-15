/**
 * Keeps goose's provider state in sync with the selected agent kernel: an external kernel runs
 * through its ACP adapter, so new sessions must default to that provider. The previous default
 * is remembered so switching back to the built-in kernel restores it.
 */
import { acpEnableProvider, acpGetProviderDetails, acpReadDefaults, acpSaveDefaults } from './providers';
import type { AgentKernelSettings } from '../utils/settings';

const KERNEL_PROVIDER: Partial<Record<AgentKernelSettings['runtime'], string>> = {
  'claude-code': 'claude-acp',
  codex: 'codex-acp',
};

const RETRY_DELAY_MS = 2000;
const RETRIES = 5;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDefaultsWithRetry(): Promise<{
  providerId: string | null;
  modelId: string | null;
} | null> {
  // The ACP connection may still be warming up on mount.
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      return await acpReadDefaults();
    } catch {
      await wait(RETRY_DELAY_MS);
    }
  }
  return null;
}

/**
 * goose only accepts a default provider that it considers configured; ACP providers become
 * configured once the app enables them (the adapter binary must already be installed).
 */
async function ensureKernelProviderEnabled(providerId: string): Promise<void> {
  const provider = await acpGetProviderDetails(providerId);
  if (provider.is_configured) {
    return;
  }
  if (!provider.is_available) {
    throw new Error(
      `${providerId} adapter is not installed: ${provider.metadata.setup_steps?.[0] ?? ''}`
    );
  }
  await acpEnableProvider(providerId);
}

export async function syncAgentKernelProviderDefaults(): Promise<void> {
  if (typeof window === 'undefined' || !window.electron?.getSetting) {
    return;
  }

  let kernel: AgentKernelSettings;
  try {
    kernel = await window.electron.getSetting('agentKernel');
  } catch {
    return;
  }
  if (!kernel) {
    return;
  }

  const target = KERNEL_PROVIDER[kernel.runtime];

  const defaults = await readDefaultsWithRetry();
  if (!defaults) {
    console.error('Could not read the default provider for the agent kernel');
    return;
  }

  if (!target) {
    if (kernel.builtinProviderId && defaults.providerId !== kernel.builtinProviderId) {
      await acpSaveDefaults(kernel.builtinProviderId, kernel.builtinModel || null).catch(() => {});
    }
    return;
  }

  if (defaults.providerId === target) {
    return;
  }

  if (defaults.providerId && !kernel.builtinProviderId) {
    await window.electron
      .setSetting('agentKernel', {
        ...kernel,
        builtinProviderId: defaults.providerId,
        builtinModel: defaults.modelId ?? '',
      })
      .catch(() => {});
  }

  try {
    await ensureKernelProviderEnabled(target);
    await acpSaveDefaults(target);
  } catch (error) {
    console.error(`Failed to default sessions to the ${target} kernel provider`, error);
  }
}

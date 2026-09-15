/**
 * The external agent kernels (Claude Code / Codex) reuse the API the user configured in the
 * app. goose masks secrets over ACP, so when the user saves a provider key here the app keeps
 * its own encrypted copy in the main process.
 */
export function rememberProviderApiKey(providerId: string, apiKey?: string | null): void {
  if (!providerId || !apiKey) {
    return;
  }
  try {
    void window.electron?.rememberProviderApiKey(providerId, apiKey)?.catch(() => {});
  } catch {
    // Best effort: the kernel settings let the user enter the key directly if capture fails.
  }
}

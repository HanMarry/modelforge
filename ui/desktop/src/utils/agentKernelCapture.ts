/**
 * The external agent kernels (Claude Code / Codex) reuse the API the user configured in the
 * app. goose masks secrets over ACP, so when the user saves a provider key here the app keeps
 * its own encrypted copy in the main process.
 */
export function rememberProviderApiKey(providerId: string, apiKey?: string | null): void {
  if (!providerId) {
    return;
  }
  if (!apiKey) {
    // The provider editor submits an empty key whenever the user leaves the field untouched;
    // the app then keeps whatever copy it captured earlier (if any).
    console.warn(`agent kernel: no provider key copy captured for ${providerId} (empty key)`);
    return;
  }
  try {
    void window.electron?.rememberProviderApiKey(providerId, apiKey)?.catch((error) => {
      console.warn(`agent kernel: failed to capture the provider key for ${providerId}`, error);
    });
  } catch (error) {
    // Best effort: the kernel settings let the user enter the key directly if capture fails.
    console.warn(`agent kernel: failed to capture the provider key for ${providerId}`, error);
  }
}

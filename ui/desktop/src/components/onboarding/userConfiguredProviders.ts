/**
 * Whether the user has set up a model provider, for the first-boot gate (spec
 * mathmodel-parity-and-beyond, requirement 5.1: the wizard shows while the configuration holds no
 * provider and there is no "completed" record).
 *
 * The inventory's `configured` flag alone cannot tell. Unless a provider brings its own check,
 * the kernel counts a required key that has a default as set (`default_inventory_configured` in
 * crates/goose/src/providers/inventory/mod.rs), so on a clean machine it already reports as
 * configured the CLI providers (codex, claude-code, cursor-agent, gemini-cli: their command key
 * defaults to the binary name), providers without required keys (github_copilot, local) and the
 * bundled local servers that need no key (lmstudio, llama_swap, atomic_chat, ...). Other screens
 * rely on that flag, so it stays as it is; the gate reads what the user left behind instead.
 */
import type { ProviderSecretDto } from '../../acp/providers';
import type { ConfigKey, ProviderDetails } from '../../types/providers';

/** A key only the user can fill in: required, and the kernel has no default for it. */
function needsUserValue(key: ConfigKey): boolean {
  return key.required && key.default == null;
}

/**
 * Whether the inventory reports the provider as configured because of something the user did:
 * - an ACP agent is configured once the user enabled it (`providers.<id>.configured`);
 * - a custom provider exists only because the user added it;
 * - any other provider only if it has a key only the user can fill in. Without one, `configured`
 *   holds on a clean machine too. Keys and sign-ins such a provider may still have are in the
 *   credential list (see `hasStoredCredential`).
 */
export function isConfiguredByUser(provider: ProviderDetails): boolean {
  if (!provider.is_configured) {
    return false;
  }
  if (provider.uses_acp || provider.provider_type === 'Custom') {
    return true;
  }
  return provider.metadata.config_keys.some(needsUserValue);
}

/**
 * Whether the `providers` block of config.yaml marks a provider as configured. The kernel writes
 * `providers.<id>.configured: true` when a provider becomes the default and when an ACP agent is
 * enabled, and keeps it when the default is cleared again.
 */
export function hasConfiguredProviderEntry(providers: unknown): boolean {
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
    return false;
  }
  return Object.values(providers).some(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      (entry as { configured?: unknown }).configured === true
  );
}

/**
 * Whether the kernel holds a provider credential: an API key in its secret store or a sign-in
 * token in a provider cache (ChatGPT, GitHub Copilot, Gemini, ...). The Hugging Face entry is
 * always listed, with `hasSecret` false until the user signs in.
 */
export function hasStoredCredential(secrets: readonly ProviderSecretDto[]): boolean {
  return secrets.some((secret) => secret.hasSecret);
}

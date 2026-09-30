/**
 * Saving an API-key provider from step 2 of the first-boot wizard (spec
 * mathmodel-parity-and-beyond, requirement 5.2, 5.3, 5.6).
 *
 * The built-in kernel only takes a provider as its default once the provider is configured in
 * the kernel itself: ACP `defaults/save` answers "Provider is not configured" otherwise, which is
 * what a clean machine used to get when the wizard kept the key in the desktop store only. After
 * a successful connectivity test the wizard therefore saves in three steps:
 *
 * 1. the key goes into the desktop credential store (`provider:<id>`), which the external agent
 *    kernels reuse. `memory-only` means the OS offers no secure storage: nothing else is saved
 *    and the wizard stays on step 2 (requirement 5.6);
 * 2. the key, and the API address for providers that take one, go to the kernel through ACP
 *    `providers/config/save`, the call behind the settings page's `providerConfigSubmitHandler`.
 *    The kernel keeps the key in its secret store and the address in config.yaml;
 * 3. the provider and model become the kernel defaults through ACP `defaults/save`, as the
 *    settings page's model picker and the previous onboarding flow do.
 */
import type { ProviderDetails } from '../../types/providers';
import type { CredentialSaveResult } from '../../utils/credentialIpc';
import { errorMessage } from '../../utils/conversionUtils';

export interface EndpointField {
  /** Provider config key that holds the address. */
  key: string;
  /** Address the kernel uses while the key is unset, shown as the initial value. */
  defaultAddress: string;
}

/**
 * Providers whose API address the wizard saves. The address has the shape the connectivity
 * test uses, an OpenAI-compatible base URL such as `https://api.example.com/v1` under which
 * `/models` and `/chat/completions` live, and `OPENAI_BASE_URL` takes exactly that shape (the
 * kernel splits it into host and path in `providers/openai_def.rs`), so OpenAI-compatible
 * endpoints work through the OpenAI provider. Other providers keep the endpoint goose ships for
 * them; for those the address only feeds the connectivity test.
 */
const ENDPOINT_FIELDS: ReadonlyMap<string, EndpointField> = new Map([
  ['openai', { key: 'OPENAI_BASE_URL', defaultAddress: 'https://api.openai.com/v1' }],
]);

export interface WizardProviderInput {
  address: string;
  key: string;
  model: string;
}

export interface ProviderConfigField {
  key: string;
  value: string;
}

export interface WizardSaveDeps {
  /** Desktop credential store, `window.electron.rememberProviderApiKey`. */
  rememberKey: (providerId: string, key: string) => Promise<CredentialSaveResult>;
  /** ACP `providers/config/save`, `acpSaveProviderConfig`. */
  saveProviderConfig: (providerId: string, fields: ProviderConfigField[]) => Promise<void>;
  /** ACP `defaults/save`, `acpSaveDefaults`. */
  saveDefaults: (providerId: string, modelId: string) => Promise<void>;
}

export type WizardSaveResult =
  | { ok: true }
  | { ok: false; failure: 'secure-storage-unavailable' }
  | { ok: false; failure: 'credential-store'; reason: string }
  | { ok: false; failure: 'kernel'; reason: string };

/** Trimmed, without trailing slashes; the kernel and the connectivity test both accept this. */
export function normalizeAddress(address: string): string {
  return address.trim().replace(/\/+$/, '');
}

/**
 * The config key that takes the API key: the provider's primary secret, else its first one.
 * OAuth and device-code keys are filled in by a sign-in, and `*_HEADERS` secrets are header maps,
 * so neither is an API key.
 */
export function apiKeyField(provider: ProviderDetails): string | null {
  const secrets = provider.metadata.config_keys.filter(
    (key) =>
      key.secret && !key.oauth_flow && !key.device_code_flow && !/HEADERS$/i.test(key.name)
  );
  return (secrets.find((key) => key.primary) ?? secrets[0])?.name ?? null;
}

/** The address field the wizard saves for this provider, or null when it saves none. */
export function endpointField(provider: ProviderDetails): EndpointField | null {
  const field = ENDPOINT_FIELDS.get(provider.name);
  if (!field || !provider.metadata.config_keys.some((key) => key.name === field.key)) {
    return null;
  }
  return field;
}

/**
 * Whether step 2 can configure the provider with an API key and an address alone. ACP agents
 * and OAuth-only providers need their own sign-in, and a provider with further required
 * settings (an Azure deployment, a Databricks host) is set up in the settings page instead;
 * offering them here would end in "Provider is not configured".
 */
export function canConfigureInWizard(provider: ProviderDetails): boolean {
  if (provider.uses_acp) {
    return false;
  }
  const keyName = apiKeyField(provider);
  if (!keyName) {
    return false;
  }
  const endpointKey = endpointField(provider)?.key;
  return provider.metadata.config_keys.every(
    (key) =>
      !key.required || key.default != null || key.name === keyName || key.name === endpointKey
  );
}

/** Address and model step 2 starts with once the provider is chosen. */
export function initialProviderInput(provider: ProviderDetails): Omit<WizardProviderInput, 'key'> {
  return {
    address: endpointField(provider)?.defaultAddress ?? '',
    model: provider.metadata.default_model ?? '',
  };
}

/** Model names offered while typing: the provider's default first, then its known models. */
export function modelSuggestions(provider: ProviderDetails): string[] {
  const names = [
    provider.metadata.default_model,
    ...provider.metadata.known_models.map((model) => model.name),
  ];
  return [...new Set(names.map((name) => name?.trim() ?? '').filter((name) => name))];
}

/**
 * Fields for `providers/config/save`: the API key, plus the address for providers that take one.
 * Only keys the provider declares are sent, as `providerConfigSubmitHandler` does, because the
 * kernel rejects the whole request for an unknown key.
 */
export function providerConfigFields(
  provider: ProviderDetails,
  input: WizardProviderInput
): ProviderConfigField[] {
  const fields: ProviderConfigField[] = [];
  const keyName = apiKeyField(provider);
  const key = input.key.trim();
  if (keyName && key) {
    fields.push({ key: keyName, value: key });
  }
  const endpoint = endpointField(provider);
  const address = normalizeAddress(input.address);
  if (endpoint && address) {
    fields.push({ key: endpoint.key, value: address });
  }
  return fields;
}

/**
 * Saves the tested provider so the built-in kernel can chat with it (the three steps in the
 * module comment). Stops at the first failure and reports it; the caller keeps the user's input
 * on step 2 for a retry (requirement 5.3).
 */
export async function saveWizardProvider(
  provider: ProviderDetails,
  input: WizardProviderInput,
  deps: WizardSaveDeps
): Promise<WizardSaveResult> {
  const key = input.key.trim();

  let stored: CredentialSaveResult;
  try {
    stored = await deps.rememberKey(provider.name, key);
  } catch (error) {
    return { ok: false, failure: 'credential-store', reason: errorMessage(error) };
  }
  if (!stored.ok) {
    return { ok: false, failure: 'credential-store', reason: stored.error.message };
  }
  if (stored.data.outcome !== 'encrypted') {
    return { ok: false, failure: 'secure-storage-unavailable' };
  }

  const model = input.model.trim() || provider.metadata.default_model;
  try {
    await deps.saveProviderConfig(provider.name, providerConfigFields(provider, { ...input, key }));
    await deps.saveDefaults(provider.name, model);
  } catch (error) {
    return { ok: false, failure: 'kernel', reason: errorMessage(error) };
  }
  return { ok: true };
}

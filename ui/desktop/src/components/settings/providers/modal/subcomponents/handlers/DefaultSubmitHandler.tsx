import { acpSaveProviderConfig } from '../../../../../../acp/providers';
import { rememberProviderApiKey } from '../../../../../../utils/agentKernelCapture';

/**
 * Submit provider configuration through ACP.
 *
 * The ACP server validates the supplied fields, persists config/secret values,
 * and triggers an inventory refresh in a single call, so no client-side
 * rollback is required.
 */
export const providerConfigSubmitHandler = async (
  provider: {
    name: string;
    metadata: {
      config_keys?: Array<{ name: string; secret?: boolean }>;
    };
  },
  configValues: Record<string, string>
) => {
  const fields: { key: string; value: string }[] = [];
  for (const { name } of provider.metadata.config_keys ?? []) {
    const value = configValues[name];
    if (value === undefined || value === '') {
      continue;
    }
    fields.push({ key: name, value });
  }

  await acpSaveProviderConfig(provider.name, fields);

  for (const { name, secret } of provider.metadata.config_keys ?? []) {
    if (secret) {
      rememberProviderApiKey(provider.name, configValues[name]);
    }
  }
};

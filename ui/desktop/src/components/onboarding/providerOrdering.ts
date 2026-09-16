import type { ProviderDetails } from '../../types/providers';

// Domestic providers surfaced first during onboarding so Chinese users can
// find and configure them without scrolling past the full provider catalog.
const RECOMMENDED_DOMESTIC_PROVIDERS = [
  'custom_deepseek',
  'zhipu',
  'moonshot',
  'alibaba',
  'minimax',
  'iflytek',
];

function domesticProviderRank(name: string): number {
  const index = RECOMMENDED_DOMESTIC_PROVIDERS.indexOf(name);
  return index === -1 ? RECOMMENDED_DOMESTIC_PROVIDERS.length : index;
}

export function sortSetupProviders(providers: ProviderDetails[]): ProviderDetails[] {
  return [...providers].sort((a, b) => {
    const aDomestic = domesticProviderRank(a.name);
    const bDomestic = domesticProviderRank(b.name);
    if (aDomestic !== bDomestic) return aDomestic - bDomestic;
    const aPreferred = a.provider_type === 'Preferred' ? 0 : 1;
    const bPreferred = b.provider_type === 'Preferred' ? 0 : 1;
    if (aPreferred !== bPreferred) return aPreferred - bPreferred;
    return a.metadata.display_name.localeCompare(b.metadata.display_name);
  });
}

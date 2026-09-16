/**
 * External links shown in the UI.
 *
 * These still point at the upstream goose documentation, which remains accurate
 * for the parts of the app this fork has not changed. Replace `DOCS_BASE` (and
 * the repository links) once the ModelForge documentation site exists — every
 * in-app link resolves through this module.
 */
export const DOCS_BASE = 'https://goose-docs.ai';

export const DOCS_URLS = {
  extensions: `${DOCS_BASE}/v1/extensions/`,
  quickstart: `${DOCS_BASE}/docs/quickstart`,
  recipes: `${DOCS_BASE}/docs/guides/recipes/`,
  goosehints: `${DOCS_BASE}/docs/guides/using-goosehints/`,
  troubleshooting: `${DOCS_BASE}/docs/troubleshooting`,
  diagnostics: `${DOCS_BASE}/docs/troubleshooting/diagnostics-and-reporting/`,
} as const;

/**
 * GitHub release feed defaults. `your-org` is a placeholder until the ModelForge
 * release repository exists; the updater treats it as "not configured" and skips
 * network requests. Keep in sync with src/app-update.yml and forge.config.ts.
 */
export const DEFAULT_GITHUB_OWNER = 'your-org';
export const DEFAULT_GITHUB_REPO = 'modelforge';

/** Repository for the customized build; keep in sync with src/app-update.yml. */
export const REPOSITORY_URL = `https://github.com/${DEFAULT_GITHUB_OWNER}/${DEFAULT_GITHUB_REPO}`;

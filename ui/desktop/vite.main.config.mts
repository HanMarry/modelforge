import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  // Updater settings baked into the main-process bundle at build time. GITHUB_OWNER stays
  // empty unless the release build sets it: isUpdateChannelConfigured() (githubUpdater.ts)
  // treats an empty owner as "no update channel", and an empty owner/repo falls back to the
  // ModelForge defaults in src/branding.ts. Never default these to the upstream goose
  // repository: that switches the update channel on for every build and points it at
  // upstream goose releases.
  define: {
    'process.env.GITHUB_OWNER': JSON.stringify(process.env.GITHUB_OWNER || ''),
    'process.env.GITHUB_REPO': JSON.stringify(process.env.GITHUB_REPO || ''),
    'process.env.GOOSE_BUNDLE_NAME': JSON.stringify(process.env.GOOSE_BUNDLE_NAME || 'ModelForge'),
  },
});

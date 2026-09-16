import { app } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubUpdater } from './githubUpdater';

function stubAppVersion(version: string): void {
  (app as unknown as { getVersion: () => string }).getVersion = () => version;
}

function expectedAssetName(): string {
  const bundleName = 'ModelForge';
  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? `${bundleName}.zip` : `${bundleName}_intel_mac.zip`;
  }
  if (process.platform === 'win32') {
    return `${bundleName}-win32-x64.zip`;
  }
  return `${bundleName}-linux-${process.arch}.zip`;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GitHubUpdater.checkForUpdates', () => {
  it('returns not-configured without fetching when the owner is still a placeholder', async () => {
    vi.stubEnv('GITHUB_OWNER', 'your-org');
    vi.stubEnv('GITHUB_REPO', 'modelforge');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    stubAppVersion('1.0.0');

    const updater = new GitHubUpdater();
    const result = await updater.checkForUpdates();

    expect(result).toEqual({ updateAvailable: false, status: 'not-configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fetches the configured release endpoint and reports an available update', async () => {
    vi.stubEnv('GITHUB_OWNER', 'acme');
    vi.stubEnv('GITHUB_REPO', 'modelforge');
    stubAppVersion('1.0.0');

    const assetName = expectedAssetName();
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({
        tag_name: 'v2.0.0',
        name: 'v2.0.0',
        published_at: '2026-01-01T00:00:00Z',
        html_url: 'https://github.com/acme/modelforge/releases/tag/v2.0.0',
        assets: [
          {
            name: assetName,
            browser_download_url: `https://example.com/${assetName}`,
            size: 100,
          },
        ],
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchSpy);

    const updater = new GitHubUpdater();
    const result = await updater.checkForUpdates();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/acme/modelforge/releases/latest'
    );
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe('2.0.0');
    expect(result.downloadUrl).toBe(`https://example.com/${assetName}`);
    expect(result.releaseUrl).toBe('https://github.com/acme/modelforge/releases/tag/v2.0.0');
  });
});

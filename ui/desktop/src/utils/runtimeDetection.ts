/**
 * Local external-runtime detection (requirement 5.5): whether Claude Code or the Codex CLI /
 * ACP adapter are installed on this machine, so the first-boot wizard can offer "通过 ACP 接入
 * 本机运行时" only for runtimes that are actually present.
 */
import { execFile } from 'child_process';

export type LocalRuntimeId = 'claude-code' | 'codex';

export interface LocalRuntimeDetection {
  id: LocalRuntimeId;
  available: boolean;
  version: string | null;
}

function versionOf(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 8000, windowsHide: true }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const line = stdout.trim().split('\n')[0]?.trim() ?? '';
      resolve(line || null);
    });
  });
}

export async function detectLocalRuntimes(): Promise<LocalRuntimeDetection[]> {
  const [claude, codex, codexAcp] = await Promise.all([
    versionOf('claude', ['--version']),
    versionOf('codex', ['--version']),
    versionOf('codex-acp', ['--version']),
  ]);
  return [
    { id: 'claude-code', available: claude !== null, version: claude },
    {
      id: 'codex',
      available: codex !== null || codexAcp !== null,
      version: codex ?? codexAcp,
    },
  ];
}

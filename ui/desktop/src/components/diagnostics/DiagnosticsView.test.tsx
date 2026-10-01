import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiagnosticsView from './DiagnosticsView';
import type { CategoryResult, DiagnosticCategory } from '../../utils/diagnostics/diagnosticsService';
import type { CredentialMigrationFailure } from '../../acp/credentialMigration';
import { IntlTestWrapper } from '../../i18n/test-utils';

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
}));

const migration = vi.hoisted(() => ({
  failures: vi.fn<() => Promise<CredentialMigrationFailure[]>>(),
}));

vi.mock('../../acp/credentialMigration', () => ({
  getCredentialMigrationFailures: migration.failures,
  subscribeToCredentialMigrationRefresh: () => () => undefined,
}));

const normalResult: CategoryResult = {
  state: '正常',
  version: '1.0.0',
  checkedAt: '2026-09-29T00:00:00.000Z',
  reason: null,
  fixes: [],
  logIds: [],
};

const runResult = {
  provider: { ...normalResult, version: 'openai' },
  runtime: normalResult,
  python: normalResult,
  typesetting: normalResult,
} as Record<DiagnosticCategory, CategoryResult>;

const electron = {
  onDiagnosticsProgress: vi.fn(() => () => {}),
  kernelProvenance: vi.fn().mockResolvedValue({
    state: '正常',
    version: '1.50.0',
    commit: '0123456789abcdef0123456789abcdef01234567',
    features: ['code-mode'],
    dirty: false,
    differences: [],
    reason: null,
  }),
  getSetting: vi.fn().mockResolvedValue(null),
  checkpointGitSource: vi
    .fn()
    .mockResolvedValue({ source: 'system', path: 'git', errorCode: null, message: null }),
  diagnosticsRun: vi.fn().mockResolvedValue(runResult),
  showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
  diagnosticsExport: vi.fn().mockResolvedValue({ ok: true }),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  openExternal: vi.fn().mockResolvedValue({ ok: true }),
};

beforeEach(() => {
  vi.clearAllMocks();
  migration.failures.mockResolvedValue([]);
  (window as unknown as { electron: unknown }).electron = electron;
});

describe('DiagnosticsView', () => {
  it('renders the four categories and the one-click run button', async () => {
    render(<DiagnosticsView />);

    expect(await screen.findByText('诊断中心')).toBeInTheDocument();
    expect(screen.getByText('模型供应商')).toBeInTheDocument();
    expect(screen.getByText('智能体运行时')).toBeInTheDocument();
    expect(screen.getByText('Python 环境')).toBeInTheDocument();
    expect(screen.getByText('LaTeX/Typst 编译环境')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键检测' })).toBeInTheDocument();
    expect(screen.queryByTestId('credential-migration-notice')).not.toBeInTheDocument();
  });

  it('names the configs whose plaintext headers could not be migrated (requirement 1.9)', async () => {
    migration.failures.mockResolvedValue([
      {
        owner: 'provider',
        name: 'Gateway',
        stage: 'write',
        message:
          'provider Gateway: plaintext header migration failed at write: header Authorization: the keyring is locked',
      },
      { owner: 'extension', name: 'GitHub', stage: 'replace', message: '' },
    ]);
    render(<DiagnosticsView />, { wrapper: IntlTestWrapper });

    const notice = await screen.findByTestId('credential-migration-notice');
    expect(notice).toHaveTextContent('Provider Gateway: the write step failed');
    expect(notice).toHaveTextContent('header Authorization: the keyring is locked');
    expect(notice).toHaveTextContent('Extension GitHub: the replace step failed');
    expect(notice).toHaveTextContent('The migration is retried automatically on the next start.');
  });

  it('runs diagnostics when the one-click button is clicked', async () => {
    const user = userEvent.setup();
    render(<DiagnosticsView />);

    await screen.findByText('诊断中心');
    await user.click(screen.getByRole('button', { name: '一键检测' }));

    expect(electron.diagnosticsRun).toHaveBeenCalled();
  });
});

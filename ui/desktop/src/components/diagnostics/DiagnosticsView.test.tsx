import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DiagnosticsView from './DiagnosticsView';
import type { CategoryResult, DiagnosticCategory } from '../../utils/diagnostics/diagnosticsService';

vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
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
  diagnosticsRun: vi.fn().mockResolvedValue(runResult),
  showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
  diagnosticsExport: vi.fn().mockResolvedValue({ ok: true }),
  showMessageBox: vi.fn().mockResolvedValue({ response: 0 }),
  openExternal: vi.fn().mockResolvedValue({ ok: true }),
};

beforeEach(() => {
  vi.clearAllMocks();
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
  });

  it('runs diagnostics when the one-click button is clicked', async () => {
    const user = userEvent.setup();
    render(<DiagnosticsView />);

    await screen.findByText('诊断中心');
    await user.click(screen.getByRole('button', { name: '一键检测' }));

    expect(electron.diagnosticsRun).toHaveBeenCalled();
  });
});

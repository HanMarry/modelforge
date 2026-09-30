import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { EnvironmentProbe, EnvironmentProbeStatus } from '../../types/workspaceApi';
import EnvironmentPanel from './EnvironmentPanel';

vi.mock('./TerminalView', () => ({ default: () => null }));

const originalElectron = window.electron;
const probeEnvironment = vi.fn<() => Promise<EnvironmentProbe[]>>();

function probe(
  id: string,
  label: string,
  status: EnvironmentProbeStatus,
  version: string | null = null
): EnvironmentProbe {
  return { id, label, command: id, version, available: status === 'available', status };
}

beforeEach(() => {
  probeEnvironment.mockReset();
  window.electron = {
    ...originalElectron,
    workspaceProbeEnvironment: probeEnvironment,
    openExternal: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  window.electron = originalElectron;
});

function renderPanel() {
  return render(
    <IntlTestWrapper>
      <EnvironmentPanel workingDir="C:\Users\模型 测试\Documents\ModelForge 项目\冒烟 项目" />
    </IntlTestWrapper>
  );
}

describe('EnvironmentPanel', () => {
  it('shows a tool that answered too late as timed out, not as missing', async () => {
    probeEnvironment.mockResolvedValue([
      probe('python', 'Python', 'timeout'),
      probe('typst', 'Typst', 'available', 'typst 0.15.1 (9dfd3a08)'),
      probe('node', 'Node.js', 'missing'),
    ]);
    renderPanel();

    expect(await screen.findByText('Timed out')).toBeInTheDocument();
    expect(screen.getByText('Not found')).toBeInTheDocument();
    expect(screen.getByText('1/3')).toBeInTheDocument();
    expect(screen.queryByText(/not found\.$/)).not.toBeInTheDocument();
  });

  it('shows the version number on each chip', async () => {
    probeEnvironment.mockResolvedValue([
      probe('latexmk', 'latexmk', 'available', 'Latexmk, John Collins, 31 Jan. 2024. Version 4.83'),
      probe('pwsh', 'PowerShell', 'available', 'Windows PowerShell 5.1.20348.2849'),
      probe('typst', 'Typst', 'available', 'typst 0.15.1 (9dfd3a08)'),
    ]);
    renderPanel();

    expect(await screen.findByText('4.83')).toBeInTheDocument();
    expect(screen.getByText('5.1.20348.2849')).toBeInTheDocument();
    expect(screen.getByText('0.15.1')).toBeInTheDocument();
  });

  it('names a missing runtime only when none of its probes found it', async () => {
    probeEnvironment.mockResolvedValue([
      probe('python', 'Python', 'missing'),
      probe('latexmk', 'latexmk', 'missing'),
      probe('xelatex', 'XeLaTeX', 'missing'),
      probe('typst', 'Typst', 'timeout'),
    ]);
    renderPanel();

    expect(await screen.findByText('Python not found.')).toBeInTheDocument();
    expect(screen.queryByText('LaTeX (TeX Live) not found.')).not.toBeInTheDocument();
    expect(screen.queryByText('Typst not found.')).not.toBeInTheDocument();
  });
});

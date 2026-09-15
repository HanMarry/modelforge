import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntlTestWrapper } from '../i18n/test-utils';
import ToolCallGroup from './ToolCallGroup';

function renderGroup(props: Partial<React.ComponentProps<typeof ToolCallGroup>> = {}) {
  return render(
    <ToolCallGroup
      operationCount={3}
      isRunning={false}
      latestOperation="running uv run a.py"
      {...props}
    >
      <div>operation-row</div>
    </ToolCallGroup>,
    { wrapper: IntlTestWrapper }
  );
}

describe('ToolCallGroup', () => {
  it('stays collapsed with a summary when the chain finished', () => {
    renderGroup();

    expect(screen.getByText('3 operations')).toBeTruthy();
    expect(screen.getByText('completed')).toBeTruthy();
    expect(screen.getByText('running uv run a.py')).toBeTruthy();
    expect(screen.queryByText('operation-row')).toBeNull();
  });

  it('expands automatically while the chain is running', () => {
    renderGroup({ isRunning: true });

    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('operation-row')).toBeTruthy();
  });

  it('collapses when a running chain finishes', () => {
    const { rerender } = renderGroup({ isRunning: true });
    expect(screen.getByText('operation-row')).toBeTruthy();

    rerender(
      <ToolCallGroup operationCount={3} isRunning={false} latestOperation="running uv run a.py">
        <div>operation-row</div>
      </ToolCallGroup>
    );

    expect(screen.queryByText('operation-row')).toBeNull();
  });

  it('toggles manually', async () => {
    const user = userEvent.setup();
    renderGroup();

    await user.click(screen.getByText('3 operations'));
    expect(screen.getByText('operation-row')).toBeTruthy();

    await user.click(screen.getByText('3 operations'));
    expect(screen.queryByText('operation-row')).toBeNull();
  });
});

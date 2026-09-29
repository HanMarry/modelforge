import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntlTestWrapper } from '../../i18n/test-utils';
import type { BrowserNavState } from '../../utils/browser/browserPanelHost';
import BrowserPanel from './BrowserPanel';

type StateListener = (event: unknown, state: BrowserNavState) => void;

const originalElectron = window.electron;
let stateListener: StateListener | null = null;

const navigate = vi.fn();
const back = vi.fn();
const forward = vi.fn();
const reload = vi.fn();

function emitState(state: Partial<BrowserNavState>) {
  act(() => {
    stateListener?.(
      null,
      {
        url: '',
        title: '',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        error: null,
        ...state,
      }
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stateListener = null;
  window.electron = {
    ...originalElectron,
    browserNavigate: navigate,
    browserBack: back,
    browserForward: forward,
    browserReload: reload,
    browserSetBounds: vi.fn(),
    browserApprovalRespond: vi.fn(),
    on: vi.fn((channel: string, callback: StateListener) => {
      if (channel === 'browser-state') stateListener = callback;
    }),
    off: vi.fn(),
  } as typeof window.electron;
});

afterEach(() => {
  window.electron = originalElectron;
});

describe('BrowserPanel', () => {
  it('disables back and forward when there is no history', () => {
    render(
      <IntlTestWrapper>
        <BrowserPanel active={false} />
      </IntlTestWrapper>
    );
    emitState({ canGoBack: false, canGoForward: false, url: 'https://example.com' });

    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('enables back and forward once the page has history', () => {
    render(
      <IntlTestWrapper>
        <BrowserPanel active={false} />
      </IntlTestWrapper>
    );
    emitState({ canGoBack: true, canGoForward: true, url: 'https://example.com' });

    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeEnabled();
  });

  it('shows a retry action when a page failed to load', () => {
    render(
      <IntlTestWrapper>
        <BrowserPanel active={false} />
      </IntlTestWrapper>
    );
    emitState({ error: { kind: 'load', reason: 'network', detail: 'ERR_NAME_NOT_RESOLVED' } });

    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the page');
    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);
    expect(reload).toHaveBeenCalled();
  });

  it('shows the protocol hint instead of a retry for a rejected scheme', () => {
    render(
      <IntlTestWrapper>
        <BrowserPanel active={false} />
      </IntlTestWrapper>
    );
    emitState({ error: { kind: 'scheme', reason: 'other', detail: 'URL protocol not supported' } });

    expect(screen.getByRole('alert')).toHaveTextContent('URL protocol not supported');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

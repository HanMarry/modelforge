import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { MoveHorizontal, RotateCw } from 'lucide-react';
import { defineMessages, useIntl } from '../../i18n';
import { Button } from '../ui/button';

const i18n = defineMessages({
  starting: {
    id: 'terminalView.starting',
    defaultMessage: 'Starting the shell…',
  },
  failed: {
    id: 'terminalView.failed',
    defaultMessage: 'Could not start the shell',
  },
  exited: {
    id: 'terminalView.exited',
    defaultMessage: 'Session ended',
  },
  restart: {
    id: 'terminalView.restart',
    defaultMessage: 'Start a new session',
  },
  ptyMode: {
    id: 'terminalView.ptyMode',
    defaultMessage: 'Interactive PTY',
  },
  pipeMode: {
    id: 'terminalView.pipeMode',
    defaultMessage: 'Piped shell (no PTY available)',
  },
  fitWidth: {
    id: 'terminalView.fitWidth',
    defaultMessage: 'Fit panel width',
  },
});

const DARK_THEME = {
  background: '#1a1921',
  foreground: '#edecee',
  cursor: '#edecee',
  selectionBackground: '#3f434b',
  black: '#22252a',
  red: '#ff6b6b',
  green: '#a3d795',
  yellow: '#ffd966',
  blue: '#7cacff',
  magenta: '#c39ac9',
  cyan: '#8cd3d6',
  white: '#e3e6ea',
  brightBlack: '#606c7a',
  brightRed: '#f94b4b',
  brightGreen: '#91cb80',
  brightYellow: '#fbcd44',
  brightBlue: '#5c98f9',
  brightMagenta: '#d7a9dd',
  brightCyan: '#a7e3e6',
  brightWhite: '#ffffff',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#3f434b',
  cursor: '#3f434b',
  selectionBackground: '#cbd1d6',
  black: '#3f434b',
  red: '#c0392b',
  green: '#2f7d32',
  yellow: '#9a6700',
  blue: '#1f5fa8',
  magenta: '#7b3f9d',
  cyan: '#0f6f74',
  white: '#e3e6ea',
  brightBlack: '#606c7a',
  brightRed: '#e74c3c',
  brightGreen: '#3fa142',
  brightYellow: '#b8860b',
  brightBlue: '#2e7ad1',
  brightMagenta: '#9b59b6',
  brightCyan: '#159fa6',
  brightWhite: '#ffffff',
};

function base64ToBytes(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface TerminalViewProps {
  cwd: string;
}

export default function TerminalView({ cwd }: TerminalViewProps) {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'starting' | 'ready' | 'exited' | 'failed'>('starting');
  const [mode, setMode] = useState<'pty' | 'pipe' | null>(null);
  const [generation, setGeneration] = useState(0);
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const hasTypedRef = useRef(false);

  /** Re-measure the terminal and push the new size into the PTY console. */
  const fitToPanel = useCallback(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitRef.current;
    if (!terminal || !fitAddon) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    terminal.scrollToBottom();
    setSize({ cols: terminal.cols, rows: terminal.rows });
    const sessionId = sessionIdRef.current;
    if (sessionId) {
      void window.electron.terminalResizeConsole(sessionId, terminal.cols, terminal.rows);
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const isDark = document.documentElement.classList.contains('dark');
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'Consolas, "Cascadia Mono", "Microsoft YaHei Mono", monospace',
      scrollback: 5000,
      theme: isDark ? DARK_THEME : LIGHT_THEME,
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    try {
      fitAddon.fit();
    } catch {
      // the container may not be measurable on the first paint
    }
    setSize({ cols: terminal.cols, rows: terminal.rows });

    let sessionId: string | null = null;
    let cancelled = false;

    const offData = window.electron.onTerminalData(({ id, data }) => {
      if (id !== sessionId) return;
      terminal.write(base64ToBytes(data));
    });
    const offExit = window.electron.onTerminalExit(({ id }) => {
      if (id !== sessionId) return;
      sessionId = null;
      setStatus('exited');
    });
    const inputSubscription = terminal.onData((data) => {
      hasTypedRef.current = true;
      if (sessionId) void window.electron.terminalWrite(sessionId, data);
    });

    setStatus('starting');
    void (async () => {
      const session = await window.electron.terminalCreate({
        cwd,
        cols: terminal.cols,
        rows: terminal.rows,
      });
      if (cancelled) {
        if (session) void window.electron.terminalKill(session.id);
        return;
      }
      if (!session) {
        setStatus('failed');
        return;
      }
      sessionId = session.id;
      sessionIdRef.current = session.id;
      setMode(session.mode);
      setSize({ cols: session.cols, rows: session.rows });
      setStatus('ready');
      terminal.focus();

      // winpty opens at 80x25 and resets the console while it initialises, so the size is
      // pushed twice: once now, once after startup settles. The prologue echo is cleared on
      // the display side rather than with Clear-Host, which would reset the size again.
      if (session.mode === 'pty') {
        const applyConsoleSize = () => {
          if (cancelled || hasTypedRef.current) return;
          void window.electron.terminalResizeConsole(session.id, terminal.cols, terminal.rows);
        };
        applyConsoleSize();
        window.setTimeout(applyConsoleSize, 700);
        window.setTimeout(() => {
          if (!hasTypedRef.current && !cancelled) {
            terminal.write('\u001b[2J\u001b[3J\u001b[H');
          }
        }, 1200);
      }
    })();

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        setSize({ cols: terminal.cols, rows: terminal.rows });
      } catch {
        // ignore transient layout states
      }
    });
    observer.observe(container);

    return () => {
      cancelled = true;
      observer.disconnect();
      inputSubscription.dispose();
      offData();
      offExit();
      const activeSession = sessionId;
      sessionId = null;
      sessionIdRef.current = null;
      hasTypedRef.current = false;
      if (activeSession) void window.electron.terminalKill(activeSession);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [cwd, generation]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border-primary px-2 py-1">
        <span className="text-[10px] text-text-tertiary">
          {mode
            ? intl.formatMessage(mode === 'pty' ? i18n.ptyMode : i18n.pipeMode)
            : intl.formatMessage(i18n.starting)}
          {size && ` · ${size.cols}×${size.rows}`}
        </span>
        {mode === 'pty' && status === 'ready' && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-1.5 text-[11px] text-text-secondary"
            title={intl.formatMessage(i18n.fitWidth)}
            onClick={fitToPanel}
          >
            <MoveHorizontal className="h-3 w-3" />
            {intl.formatMessage(i18n.fitWidth)}
          </Button>
        )}
        {(status === 'exited' || status === 'failed') && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 gap-1 px-1.5 text-[11px] text-text-secondary"
            onClick={() => setGeneration((current) => current + 1)}
          >
            <RotateCw className="h-3 w-3" />
            {status === 'failed'
              ? intl.formatMessage(i18n.failed)
              : intl.formatMessage(i18n.restart)}
          </Button>
        )}
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden bg-background-primary p-1"
      />
    </div>
  );
}

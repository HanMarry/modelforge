/**
 * IPC for the built-in browser panel (requirement 12): navigation, back/forward/reload, bounds
 * (which also drives attaching the `WebContentsView` to the window), the MCP endpoint for session
 * injection, and the approval channel used by `browser_click` / `browser_type` (12.3).
 */
import { BrowserWindow, ipcMain, type Rectangle } from 'electron';
import { registerLogSecrets } from '../logger';
import { BrowserPanelHost, type BrowserApprovalRequest } from './browserPanelHost';
import { startBrowserMcpServer, type BrowserMcpEndpoint } from './browserMcpServer';

export interface BrowserIpcOptions {
  /** Resolves the window that hosts the browser view; used to push state events. */
  getMainWindow: () => BrowserWindow | null;
}

const isRectangle = (value: unknown): value is Rectangle =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Rectangle).x === 'number' &&
  typeof (value as Rectangle).y === 'number' &&
  typeof (value as Rectangle).width === 'number' &&
  typeof (value as Rectangle).height === 'number';

export function registerBrowserIpc({ getMainWindow }: BrowserIpcOptions): void {
  const host = new BrowserPanelHost();
  const pendingApprovals = new Map<string, (approved: boolean) => void>();

  const send = (channel: string, ...args: unknown[]): void => {
    const window = getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send(channel, ...args);
    }
  };

  host.onStateChange((state) => send('browser-state', state));

  const requestApproval = (request: BrowserApprovalRequest): Promise<boolean> =>
    new Promise((resolve) => {
      pendingApprovals.set(request.id, resolve);
      send('browser-approval-request', request);
    });

  const endpoint: Promise<BrowserMcpEndpoint | null> = startBrowserMcpServer({
    host,
    requestApproval,
    onOpen: () => send('browser-show'),
    registerSecret: (value) => registerLogSecrets(() => [value]),
  }).catch((error) => {
    console.error('[browser] failed to start the MCP server', error);
    return null;
  });

  ipcMain.handle('browser-navigate', (_event, url: unknown) =>
    host.navigate(typeof url === 'string' ? url : '')
  );
  ipcMain.handle('browser-back', () => {
    host.back();
    return host.getState();
  });
  ipcMain.handle('browser-forward', () => {
    host.forward();
    return host.getState();
  });
  ipcMain.handle('browser-reload', () => {
    host.reload();
    return host.getState();
  });
  ipcMain.handle('browser-set-bounds', (event, bounds: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    host.setWindow(window);
    if (bounds === null || bounds === undefined) {
      host.setBounds(null);
    } else if (isRectangle(bounds)) {
      host.setBounds(bounds);
    }
    return host.getState();
  });
  ipcMain.handle('browser-mcp-endpoint', () => endpoint);
  ipcMain.handle('browser-approval-respond', (_event, id: unknown, approved: unknown) => {
    if (typeof id !== 'string') return;
    const resolve = pendingApprovals.get(id);
    if (resolve) {
      pendingApprovals.delete(id);
      resolve(approved === true);
    }
  });
}

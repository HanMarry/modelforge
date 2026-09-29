/**
 * Main-process host for the built-in browser panel (requirement 12). A single `WebContentsView`
 * renders web pages in an isolated session partition (`persist:mf-browser`), so loaded pages
 * cannot touch the app's own cookies, storage or cache (12.4). The view is only attached to the
 * main window while the browser tab is visible.
 */
import { session, WebContentsView, type BrowserWindow, type Rectangle } from 'electron';
import { truncateText } from '../textTruncate';
import { isAllowedUrl } from '../urlPolicy';

export type BrowserLoadFailureReason = 'network' | 'timeout' | 'http' | 'other';

export type BrowserToolErrorCode = 'NO_PAGE' | 'URL_SCHEME' | 'LOAD_FAILED' | 'USER_REJECTED';

export interface BrowserLoadError {
  /** `scheme` means the URL protocol was rejected; `load` means a real load failure. */
  kind: 'scheme' | 'load';
  reason: BrowserLoadFailureReason;
  detail: string;
}

export interface BrowserNavState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  error: BrowserLoadError | null;
}

export interface BrowserReadResult {
  title: string;
  url: string;
  text: string;
  truncated: boolean;
}

export interface BrowserNavigateResult {
  ok: boolean;
  code?: BrowserToolErrorCode;
  error?: BrowserLoadError;
}

export type BrowserElementAction = 'click' | 'type';

export interface BrowserElementTarget {
  description: string;
}

export interface BrowserApprovalRequest {
  id: string;
  action: BrowserElementAction;
  description: string;
  /** Text that will be typed; present only for `type`. */
  text?: string;
  url: string;
}

const BODY_MAX_CODE_POINTS = 100_000;
const LOAD_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;

/** Network error codes that mean the host could not be reached at all. */
const UNREACHABLE_CODES = new Set([-101, -102, -105, -106, -118, -137, -138]);
/** Network error codes that mean the connection or response timed out. */
const TIMEOUT_CODES = new Set([-7, -118]);

function describeError(description: string): string {
  return description || 'unknown error';
}

/** Pure classification, kept separate so it is easy to reason about. */
export function classifyLoadFailure(
  errorCode: number,
  timedOut: boolean,
  httpStatus?: number
): BrowserLoadFailureReason {
  if (timedOut) return 'timeout';
  if (httpStatus !== undefined && httpStatus >= 400) return 'http';
  if (TIMEOUT_CODES.has(errorCode)) return 'timeout';
  if (UNREACHABLE_CODES.has(errorCode)) return 'network';
  return 'other';
}

function readInnerText(view: WebContentsView): Promise<string> {
  return view.webContents.executeJavaScript(
    `(() => {
      const clone = document.body;
      if (!clone) return '';
      clone.querySelectorAll('script, style, noscript, template').forEach((node) => node.remove());
      return clone.innerText ?? '';
    })()`
  );
}

function describeElement(view: WebContentsView, selector: string): Promise<string | null> {
  return view.webContents.executeJavaScript(
    `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      const text = (el.innerText || el.value || '').trim().slice(0, 80);
      return [tag + id + cls, text].filter(Boolean).join(' ');
    })()`
  );
}

export class BrowserPanelHost {
  private view: WebContentsView | null = null;
  private window: BrowserWindow | null = null;
  private bounds: Rectangle | null = null;
  private currentUrl = '';
  private currentTitle = '';
  private loading = false;
  private error: BrowserLoadError | null = null;
  private stateListener: ((state: BrowserNavState) => void) | null = null;

  onStateChange(listener: (state: BrowserNavState) => void): void {
    this.stateListener = listener;
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window;
    this.syncAttachment();
  }

  setBounds(bounds: Rectangle | null): void {
    this.bounds = bounds;
    this.syncAttachment();
  }

  hasLoadedPage(): boolean {
    return this.view !== null && this.currentUrl !== '';
  }

  getState(): BrowserNavState {
    return {
      url: this.currentUrl,
      title: this.currentTitle,
      loading: this.loading,
      canGoBack: this.view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: this.view?.webContents.navigationHistory.canGoForward() ?? false,
      error: this.error,
    };
  }

  async navigate(input: string): Promise<BrowserNavigateResult> {
    if (!isAllowedUrl(input)) {
      this.error = { kind: 'scheme', reason: 'other', detail: 'URL protocol not supported' };
      this.emit();
      return { ok: false, code: 'URL_SCHEME' };
    }
    const view = this.ensureView();
    this.error = null;
    this.loading = true;
    this.emit();

    try {
      await withTimeout(view.webContents.loadURL(input), LOAD_TIMEOUT_MS, new Error('timeout'));
      this.currentUrl = view.webContents.getURL();
      this.loading = false;
      this.error = null;
      this.emit();
      return { ok: true };
    } catch (cause) {
      const loadError: BrowserLoadError =
        this.error ??
        {
          kind: 'load',
          reason: classifyLoadFailure(0, true),
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      this.error = loadError;
      this.loading = false;
      this.emit();
      return { ok: false, code: 'LOAD_FAILED', error: loadError };
    }
  }

  back(): void {
    this.view?.webContents.navigationHistory.goBack();
  }

  forward(): void {
    this.view?.webContents.navigationHistory.goForward();
  }

  reload(): void {
    if (!this.view) return;
    this.error = null;
    this.view.webContents.reload();
    this.emit();
  }

  async readPage(): Promise<BrowserReadResult | { ok: false; code: BrowserToolErrorCode }> {
    if (!this.hasLoadedPage()) {
      return { ok: false, code: 'NO_PAGE' };
    }
    const view = this.view!;
    const text = await withTimeout(readInnerText(view), READ_TIMEOUT_MS, new Error('timeout'));
    const truncated = truncateText(text, BODY_MAX_CODE_POINTS);
    return {
      title: view.webContents.getTitle(),
      url: view.webContents.getURL(),
      text: truncated.text,
      truncated: truncated.truncated,
    };
  }

  async locate(selector: string): Promise<BrowserElementTarget | null> {
    if (!this.hasLoadedPage()) return null;
    const description = await describeElement(this.view!, selector);
    return description === null ? null : { description };
  }

  async click(selector: string): Promise<void> {
    if (!this.view) return;
    await this.view.webContents.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); })()`
    );
  }

  async type(selector: string, text: string): Promise<void> {
    if (!this.view) return;
    await this.view.webContents.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        el.focus();
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(text)});
        else el.value = ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`
    );
  }

  destroy(): void {
    if (this.view) {
      this.view.webContents.close();
      this.view = null;
    }
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view;

    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition('persist:mf-browser'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isAllowedUrl(url)) {
        void this.navigate(url);
      }
      return { action: 'deny' };
    });

    view.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedUrl(url)) {
        event.preventDefault();
        this.error = { kind: 'scheme', reason: 'other', detail: 'URL protocol not supported' };
        this.emit();
      }
    });

    view.webContents.on('did-navigate', (_event, url) => {
      this.currentUrl = url;
      this.error = null;
      this.emit();
    });

    view.webContents.on('did-start-loading', () => {
      this.loading = true;
      this.emit();
    });

    view.webContents.on('did-stop-loading', () => {
      this.loading = false;
      this.currentUrl = view.webContents.getURL();
      this.currentTitle = view.webContents.getTitle();
      this.emit();
    });

    view.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (!isMainFrame) return;
        this.error = {
          kind: 'load',
          reason: classifyLoadFailure(errorCode, false),
          detail: describeError(errorDescription),
        };
        this.loading = false;
        this.emit();
      }
    );

    view.webContents.on('page-title-updated', (_event, title) => {
      this.currentTitle = title;
      this.emit();
    });

    this.view = view;
    this.syncAttachment();
    return view;
  }

  private syncAttachment(): void {
    if (!this.view) return;
    if (this.window && this.bounds) {
      this.window.contentView.addChildView(this.view);
      this.view.setBounds(this.bounds);
    } else {
      this.window?.contentView.removeChildView(this.view);
    }
  }

  private emit(): void {
    this.stateListener?.(this.getState());
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

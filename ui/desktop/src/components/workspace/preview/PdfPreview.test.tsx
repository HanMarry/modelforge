import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PdfPreview from './PdfPreview';
import { IntlTestWrapper } from '../../../i18n/test-utils';

// --- 全局 polyfill：jsdom 缺少 ResizeObserver ------------------------------
// 必须在任何组件代码运行之前挂载到 globalThis，因为组件里直接 `new ResizeObserver`。

class ResizeObserverMock implements ResizeObserver {
  private callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
  }
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry],
      this
    );
  }
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// --- pdfjs-dist mock ------------------------------------------------------

interface MockPage {
  getViewport: ReturnType<typeof vi.fn>;
  render: ReturnType<typeof vi.fn>;
}

interface MockDocument {
  numPages: number;
  getPage: ReturnType<typeof vi.fn>;
}

type GetDocumentResult =
  | { kind: 'resolve'; doc: MockDocument }
  | { kind: 'reject'; error: Error };

let getDocumentResult: GetDocumentResult;
let mockDocument: MockDocument;
let mockPage: MockPage;
let mockDestroy = vi.fn();

const getDocumentSpy = vi.fn();

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: (...args: unknown[]) => {
    getDocumentSpy(...args);
    let promise: Promise<MockDocument>;
    if (getDocumentResult.kind === 'resolve') {
      promise = Promise.resolve(getDocumentResult.doc);
    } else {
      promise = Promise.reject(getDocumentResult.error);
    }
    return { promise, destroy: mockDestroy };
  },
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'mock-worker.js' }));

// --- helpers --------------------------------------------------------------

function makeBase64(content = '%PDF-1.4 mock'): string {
  if (typeof btoa === 'function') return btoa(content);
  return Buffer.from(content, 'binary').toString('base64');
}

function renderPdf(base64: string) {
  return render(
    <IntlTestWrapper>
      <PdfPreview base64={base64} />
    </IntlTestWrapper>
  );
}

// --- setup / teardown ----------------------------------------------------

beforeEach(() => {
  getDocumentSpy.mockClear();
  mockDestroy = vi.fn();
  mockPage = {
    getViewport: vi.fn().mockReturnValue({ width: 612, height: 792 }),
    render: vi.fn().mockReturnValue({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }),
  };
  mockDocument = {
    numPages: 3,
    getPage: vi.fn().mockResolvedValue(mockPage),
  };
  getDocumentResult = { kind: 'resolve', doc: mockDocument };
});

afterEach(() => {
  vi.clearAllMocks();
});

// --- tests ---------------------------------------------------------------

describe('PdfPreview', () => {
  it('shows loading text immediately after render', () => {
    renderPdf(makeBase64());
    // getDocument 同步被调用，promise 微任务还没 resolve
    expect(getDocumentSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Loading PDF/i)).toBeInTheDocument();
  });

  it('calls pdfjs.getDocument with the decoded bytes and asset URLs', async () => {
    const base64 = makeBase64('hello pdf');
    renderPdf(base64);

    await waitFor(() => expect(getDocumentSpy).toHaveBeenCalledTimes(1));

    const callArg = getDocumentSpy.mock.calls[0][0] as {
      data: Uint8Array;
      wasmUrl: string;
      standardFontDataUrl: string;
      iccUrl: string;
    };
    expect(callArg.data).toBeInstanceOf(Uint8Array);
    const decoded = new TextDecoder().decode(callArg.data);
    expect(decoded).toBe('hello pdf');
    expect(callArg.wasmUrl).toBe('pdfjs/');
    expect(callArg.standardFontDataUrl).toBe('pdfjs/standard_fonts/');
    expect(callArg.iccUrl).toBe('pdfjs/');
  });

  it('renders a canvas and calls page.render once the document loads', async () => {
    renderPdf(makeBase64());

    const canvas = await waitFor(() => {
      const el = document.querySelector('canvas');
      expect(el).not.toBeNull();
      return el as HTMLCanvasElement;
    });

    expect(canvas).toBeInTheDocument();
    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(1));
    await waitFor(() => expect(mockPage.render).toHaveBeenCalled());
  });

  it('shows page count and disables prev on the first page', async () => {
    renderPdf(makeBase64());

    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalled());

    expect(screen.getByText(/1.*\/.*3/)).toBeInTheDocument();
    expect(screen.getByTitle(/Previous page/i)).toBeDisabled();
    expect(screen.getByTitle(/Next page/i)).not.toBeDisabled();
  });

  it('advances to the next page when next is clicked', async () => {
    renderPdf(makeBase64());

    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByTitle(/Next page/i));

    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(2));
    expect(screen.getByText(/2.*\/.*3/)).toBeInTheDocument();
  });

  it('goes to the previous page when prev is clicked', async () => {
    renderPdf(makeBase64());

    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByTitle(/Next page/i));
    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(2));

    fireEvent.click(screen.getByTitle(/Previous page/i));
    await waitFor(() =>
      expect(mockDocument.getPage).toHaveBeenLastCalledWith(1)
    );
  });

  it('disables next on the last page', async () => {
    renderPdf(makeBase64());

    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(1));

    fireEvent.click(screen.getByTitle(/Next page/i));
    fireEvent.click(screen.getByTitle(/Next page/i));

    await waitFor(() =>
      expect(mockDocument.getPage).toHaveBeenLastCalledWith(3)
    );

    expect(screen.getByTitle(/Next page/i)).toBeDisabled();
    expect(screen.getByTitle(/Previous page/i)).not.toBeDisabled();
  });

  it('shows an error message when the PDF cannot be opened', async () => {
    getDocumentResult = {
      kind: 'reject',
      error: new Error('Invalid PDF structure'),
    };

    renderPdf(makeBase64('not a pdf'));

    await waitFor(() =>
      expect(screen.getByText(/could not be opened/i)).toBeInTheDocument()
    );
  });

  it('cleans up the document task on unmount', async () => {
    const { unmount } = renderPdf(makeBase64());

    await waitFor(() => expect(getDocumentSpy).toHaveBeenCalledTimes(1));

    unmount();

    expect(mockDestroy).toHaveBeenCalled();
  });

  it('reloads when the base64 prop changes', async () => {
    const { rerender } = render(
      <IntlTestWrapper>
        <PdfPreview base64={makeBase64('first')} />
      </IntlTestWrapper>
    );

    await waitFor(() => expect(getDocumentSpy).toHaveBeenCalledTimes(1));

    rerender(
      <IntlTestWrapper>
        <PdfPreview base64={makeBase64('second')} />
      </IntlTestWrapper>
    );

    await waitFor(() => expect(getDocumentSpy).toHaveBeenCalledTimes(2));
  });

  it('zoom in and zoom out change the scale display', async () => {
    renderPdf(makeBase64());

    await waitFor(() => expect(mockDocument.getPage).toHaveBeenCalledWith(1));

    // 初始 scale 为 1 → 100%
    expect(screen.getByText('100%')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/Zoom in/i));
    expect(screen.getByText('115%')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(/Zoom out/i));
    expect(screen.getByText('100%')).toBeInTheDocument();
  });
});

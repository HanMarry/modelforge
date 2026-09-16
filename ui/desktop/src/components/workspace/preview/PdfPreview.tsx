import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus } from 'lucide-react';
import { defineMessages, useIntl } from '../../../i18n';
import { Button } from '../../ui/button';
import { base64ToArrayBuffer } from './previewKind';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const i18n = defineMessages({
  loading: { id: 'pdfPreview.loading', defaultMessage: 'Loading PDF…' },
  failed: { id: 'pdfPreview.failed', defaultMessage: 'This PDF could not be opened' },
  page: { id: 'pdfPreview.page', defaultMessage: '{current} / {total}' },
  previous: { id: 'pdfPreview.previous', defaultMessage: 'Previous page' },
  next: { id: 'pdfPreview.next', defaultMessage: 'Next page' },
  zoomIn: { id: 'pdfPreview.zoomIn', defaultMessage: 'Zoom in' },
  zoomOut: { id: 'pdfPreview.zoomOut', defaultMessage: 'Zoom out' },
  fitWidth: { id: 'pdfPreview.fitWidth', defaultMessage: 'Fit width' },
});

function decodeBase64(base64: string): Uint8Array {
  return new Uint8Array(base64ToArrayBuffer(base64));
}

interface PdfPreviewProps {
  base64: string;
}

export default function PdfPreview({ base64 }: PdfPreviewProps) {
  const intl = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [document, setDocument] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [baseWidth, setBaseWidth] = useState(0);
  const [scale, setScale] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const task = pdfjs.getDocument({
      data: decodeBase64(base64),
      // Runtime assets live in `public/pdfjs/` (see scripts/copy-pdfjs-assets.js) because
      // PDF.js resolves these prefixes as plain URLs rather than through the bundler.
      wasmUrl: 'pdfjs/',
      standardFontDataUrl: 'pdfjs/standard_fonts/',
      iccUrl: 'pdfjs/',
    });
    setError(null);
    setDocument(null);
    setPageNumber(1);
    setFitWidth(true);

    task.promise
      .then(async (loaded) => {
        if (cancelled) return;
        const firstPage = await loaded.getPage(1);
        if (cancelled) return;
        setBaseWidth(firstPage.getViewport({ scale: 1 }).width);
        setDocument(loaded);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      });

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [base64]);

  // Fit-to-width recomputes the scale whenever the panel is resized.
  useEffect(() => {
    if (!fitWidth || !baseWidth) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const apply = () => {
      const available = container.clientWidth - 16;
      if (available > 80) setScale(Math.max(available / baseWidth, 0.2));
    };
    apply();

    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [baseWidth, fitWidth]);

  useEffect(() => {
    const pdfDocument = document;
    const canvas = canvasRef.current;
    if (!pdfDocument || !canvas) return undefined;

    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;

    void (async () => {
      const page = await pdfDocument.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      renderTask = page.render({ canvas, viewport });
      try {
        await renderTask.promise;
      } catch {
        // rendering is cancelled when the page or scale changes
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, pageNumber, scale]);

  const totalPages = document?.numPages ?? 0;

  const goToPage = useCallback(
    (next: number) => {
      setPageNumber(Math.min(Math.max(next, 1), totalPages || 1));
    },
    [totalPages]
  );

  if (error) {
    return <p className="p-3 text-xs text-red-500">{intl.formatMessage(i18n.failed)}</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border-primary px-2 py-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.previous)}
          disabled={pageNumber <= 1}
          onClick={() => goToPage(pageNumber - 1)}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[3.5rem] text-center font-mono text-[10px] text-text-secondary">
          {intl.formatMessage(i18n.page, { current: pageNumber, total: totalPages || '–' })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.next)}
          disabled={!totalPages || pageNumber >= totalPages}
          onClick={() => goToPage(pageNumber + 1)}
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <div className="mx-1 h-4 w-px bg-border-primary" />
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.zoomOut)}
          onClick={() => {
            setFitWidth(false);
            setScale((current) => Math.max(current - 0.15, 0.25));
          }}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <span className="min-w-[2.5rem] text-center font-mono text-[10px] text-text-tertiary">
          {Math.round(scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-text-secondary"
          title={intl.formatMessage(i18n.zoomIn)}
          onClick={() => {
            setFitWidth(false);
            setScale((current) => Math.min(current + 0.15, 4));
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={`h-6 w-6 p-0 ${fitWidth ? 'text-text-info' : 'text-text-secondary'}`}
          title={intl.formatMessage(i18n.fitWidth)}
          onClick={() => setFitWidth(true)}
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-auto bg-background-secondary/40 p-2"
      >
        {!document && !error && (
          <p className="p-3 text-xs text-text-tertiary">{intl.formatMessage(i18n.loading)}</p>
        )}
        <canvas ref={canvasRef} className="mx-auto block max-w-full shadow-sm" />
      </div>
    </div>
  );
}

import { useEffect, useRef } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { base64ToArrayBuffer } from '../workspace/preview/previewKind';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface GalleryPdfThumbProps {
  pdfPath?: string;
}

/** Renders the first page of a local PDF as a small thumbnail for a gallery card. */
export default function GalleryPdfThumb({ pdfPath }: GalleryPdfThumbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!pdfPath) return;
    let cancelled = false;
    let renderTask: pdfjs.RenderTask | null = null;

    void (async () => {
      const bytes = await window.electron.workspaceReadBytes(pdfPath).catch(() => null);
      if (cancelled || !bytes?.base64) return;
      const data = new Uint8Array(base64ToArrayBuffer(bytes.base64));
      const task = pdfjs.getDocument({
        data,
        wasmUrl: 'pdfjs/',
        standardFontDataUrl: 'pdfjs/standard_fonts/',
        iccUrl: 'pdfjs/',
      });
      const doc = await task.promise;
      if (cancelled) return;
      const page = await doc.getPage(1);
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      const base = page.getViewport({ scale: 1 });
      const scale = 220 / base.width;
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      renderTask = page.render({ canvas, viewport });
      await renderTask.promise.catch(() => {});
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdfPath]);

  return <canvas ref={canvasRef} className="block h-32 w-full bg-background-secondary/40" />;
}

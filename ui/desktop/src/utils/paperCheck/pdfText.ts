/**
 * PDF text extraction with pdfjs for the paper check process (requirement 18.3, 18.6). Only
 * `paperCheckRunnerMain.ts` imports this module: it loads the legacy (Node) build of pdfjs and
 * its worker in the `utilityProcess`, so the renderer bundle and the tests never do.
 *
 * pdfjs gets a copy of the bytes the project reader already read; it opens no file itself.
 */

// Sets `globalThis.pdfjsWorker`, so pdfjs runs its worker in this process instead of loading
// `GlobalWorkerOptions.workerSrc`, which a bundled build could not resolve.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PdfDocumentText, PdfPageText, PdfTextItem } from './pdfTextLayer';

const DEFAULT_MAX_PAGES = 300;

/** The positioned text of the first `maxPages` pages. Rejects when the PDF cannot be parsed. */
export async function extractPdfText(
  bytes: Uint8Array,
  maxPages = DEFAULT_MAX_PAGES
): Promise<PdfDocumentText> {
  const task = getDocument({
    // pdfjs may transfer the buffer it is given, so it gets its own copy.
    data: new Uint8Array(bytes),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    const pages: PdfPageText[] = [];
    const count = Math.min(pdf.numPages, maxPages);
    for (let number = 1; number <= count; number++) {
      const page = await pdf.getPage(number);
      const [x0, y0, x1, y1] = page.view;
      const content = await page.getTextContent();
      const items: PdfTextItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) {
          continue;
        }
        const [a, b, , , e, f] = item.transform as number[];
        items.push({
          text: item.str,
          x: e - x0,
          y: f - y0,
          angle: (Math.atan2(b, a) * 180) / Math.PI,
          endOfLine: item.hasEOL,
        });
      }
      pages.push({ page: number, width: x1 - x0, height: y1 - y0, items });
      page.cleanup();
    }
    return { pages };
  } finally {
    await task.destroy();
  }
}

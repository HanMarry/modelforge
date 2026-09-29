/**
 * The text layer of a PDF as the paper checks use it (requirement 18.3, 18.6): positioned text
 * items per page. `pdfText.ts` fills it with pdfjs inside the check process; everything here is
 * pure so the checks can be tested with hand-made pages.
 */

export interface PdfTextItem {
  text: string;
  /** Baseline origin in PDF user space, relative to the page's lower-left corner. */
  x: number;
  y: number;
  /** Direction of the text in degrees, counter-clockwise; 90 for text reading bottom to top. */
  angle: number;
  /** A line break follows this item (pdfjs `hasEOL`). */
  endOfLine: boolean;
}

export interface PdfPageText {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

export interface PdfDocumentText {
  pages: PdfPageText[];
}

/**
 * Reads the text layer of the first `maxPages` pages of a PDF (all by default); supplied by the
 * check process, faked in tests. Rejects when the PDF cannot be parsed.
 */
export type PdfTextExtractor = (bytes: Uint8Array, maxPages?: number) => Promise<PdfDocumentText>;

/** The page's text split into lines, in reading order as pdfjs emits it. */
export function pageLines(page: PdfPageText): string[] {
  const lines: string[] = [];
  let current = '';
  for (const item of page.items) {
    current += item.text;
    if (item.endOfLine) {
      lines.push(current);
      current = '';
    }
  }
  if (current !== '') {
    lines.push(current);
  }
  return lines;
}

/** The whole page as one string, lines joined with `\n`. */
export function pageText(page: PdfPageText): string {
  return pageLines(page).join('\n');
}

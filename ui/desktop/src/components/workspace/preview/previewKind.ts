export type PreviewKind =
  'image' | 'pdf' | 'spreadsheet' | 'table' | 'markdown' | 'notebook' | 'code' | 'text' | 'binary';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.avif',
]);
const SPREADSHEET_EXTENSIONS = new Set(['.xlsx', '.xlsm']);
const TABLE_EXTENSIONS = new Set(['.csv', '.tsv']);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
const NOTEBOOK_EXTENSIONS = new Set(['.ipynb']);
const PDF_EXTENSIONS = new Set(['.pdf']);

export const PRISM_LANGUAGES: Record<string, string> = {
  '.py': 'python',
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonl': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.tex': 'latex',
  '.bib': 'bibtex',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.hpp': 'cpp',
  '.r': 'r',
  '.jl': 'julia',
  '.m': 'matlab',
  '.sh': 'bash',
  '.ps1': 'powershell',
  '.bat': 'batch',
  '.cmd': 'batch',
  '.html': 'markup',
  '.htm': 'markup',
  '.css': 'css',
  '.scss': 'scss',
  '.xml': 'markup',
  '.svg': 'markup',
  '.drawio': 'markup',
  '.sql': 'sql',
  '.lua': 'lua',
  '.php': 'php',
};

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.log',
  '.env',
  '.gitignore',
  '.properties',
  '.conf',
  '.text',
  '.dat',
]);

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  if (index <= 0) return '';
  return name.slice(index).toLowerCase();
}

export function previewKindFor(name: string): PreviewKind {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (PDF_EXTENSIONS.has(extension)) return 'pdf';
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheet';
  if (TABLE_EXTENSIONS.has(extension)) return 'table';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  if (NOTEBOOK_EXTENSIONS.has(extension)) return 'notebook';
  if (PRISM_LANGUAGES[extension]) return 'code';
  if (TEXT_EXTENSIONS.has(extension) || !extension) return 'text';
  return 'binary';
}

export function isEditableKind(kind: PreviewKind): boolean {
  return kind === 'code' || kind === 'text' || kind === 'markdown' || kind === 'table';
}

export function isImageExtension(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** Base64 → ArrayBuffer; keeps the Blob/Uint8Array constructors happy under strict typings. */
export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    view[index] = binary.charCodeAt(index);
  }
  return buffer;
}

/** Splits delimited text into rows, honouring quoted fields. */
export function parseDelimited(text: string, delimiter: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length && rows.length < maxRows; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === delimiter) {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    if (char === '\r') continue;
    field += char;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export function detectDelimiter(text: string, extension: string): string {
  if (extension === '.tsv') return '\t';
  const sample = text.split('\n').slice(0, 5).join('\n');
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = -1;
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = candidate;
    }
  }
  return best;
}

import { PRISM_LANGUAGES, extensionOf } from '../components/workspace/preview/previewKind';

/** Extensions worth showing as an inline artifact card in the conversation. */
const PREVIEWABLE_EXTENSIONS = new Set([
  ...Object.keys(PRISM_LANGUAGES),
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.pdf',
  '.xlsx',
  '.xlsm',
  '.csv',
  '.tsv',
  '.ipynb',
  '.txt',
  '.log',
  '.tex',
  '.bib',
]);

/** Absolute Windows or POSIX paths ending in a known extension. */
const ABSOLUTE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]|\/)[^\s"'`|<>()[\]{},;]*?\.[A-Za-z0-9]{1,6}/g;

/**
 * Pulls candidate output files out of a tool call's arguments. Tool arguments are where the
 * agent names what it is about to write, so this catches figures and reports without parsing
 * free-form tool output. Callers verify existence before rendering anything.
 */
export function extractArtifactPaths(toolArguments: unknown, limit = 4): string[] {
  const found = new Set<string>();

  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      for (const match of value.match(ABSOLUTE_PATH_PATTERN) ?? []) {
        const cleaned = match.replace(/[.,;:]+$/, '');
        if (PREVIEWABLE_EXTENSIONS.has(extensionOf(cleaned))) found.add(cleaned);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(visit);
    }
  };

  visit(toolArguments);
  return [...found].slice(0, limit);
}

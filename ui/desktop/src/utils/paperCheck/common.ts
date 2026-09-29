/**
 * Shared pieces of the paper delivery checks (spec mathmodel-parity-and-beyond, requirement 18):
 * the verdict every check reports, the source language of a file, comment removal that keeps
 * line numbers, and project-relative path arithmetic.
 *
 * Pure functions without imports. Callers read the files and pass their text in; nothing here
 * touches the file system.
 */

/** Conclusion of one check (requirement 18.8). */
export type PaperCheckVerdict = '通过' | '发现问题' | '无法执行';

export type SourceLanguage = 'latex' | 'typst' | 'markdown' | 'plain';

export interface SourceText {
  /** Project-relative path; `\` and `/` are both accepted. */
  path: string;
  text: string;
}

/** Language by file extension (case-insensitive): `.tex`/`.ltx`, `.typ`, `.md`/`.markdown`. */
export function sourceLanguageOf(path: string): SourceLanguage {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();
  switch (extension) {
    case '.tex':
    case '.ltx':
      return 'latex';
    case '.typ':
      return 'typst';
    case '.md':
    case '.markdown':
      return 'markdown';
    default:
      return 'plain';
  }
}

/** Splits on `\r\n`, `\r` or `\n`; line `n` (1-based) of a file is element `n - 1`. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** Whether the character at `index` is preceded by an odd number of backslashes. */
export function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++;
  }
  return backslashes % 2 === 1;
}

/** LaTeX: `%` up to the end of the line, unless written as `\%`. */
function stripLatexLine(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && !isEscaped(line, i)) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Typst: `//` line comments and nestable `/* … *\/` block comments. `//` inside a string literal
 * or right after `:` (a URL such as `https://…`) is not a comment. Strings end at the end of a
 * line so an unmatched quote in markup cannot hide the comments that follow it.
 */
function stripTypstComments(source: string): string {
  let out = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (depth > 0) {
      if (ch === '/' && next === '*') {
        depth++;
        i++;
      } else if (ch === '*' && next === '/') {
        depth--;
        i++;
      } else if (ch === '\n') {
        out += ch;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === '\\' && next !== undefined && next !== '\n') {
        out += next;
        i++;
      } else if (ch === '"' || ch === '\n') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && next === '/' && (i === 0 || source[i - 1] !== ':')) {
      const end = source.indexOf('\n', i);
      if (end === -1) {
        break;
      }
      // The loop's increment lands on the newline, which is kept.
      i = end - 1;
    } else if (ch === '/' && next === '*') {
      depth = 1;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Markdown: HTML comments `<!-- … -->`; an unterminated one runs to the end of the file. */
function stripMarkdownComments(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => comment.replace(/[^\n]/g, ''));
}

/**
 * Removes comments so that commands and question numbers inside them are not counted. Line
 * breaks are normalised to `\n` and every line keeps its number, so positions found in the
 * result point at the same line of the original file.
 */
export function stripComments(text: string, language: SourceLanguage): string {
  const lines = splitLines(text);
  switch (language) {
    case 'latex':
      return lines.map(stripLatexLine).join('\n');
    case 'typst':
      return stripTypstComments(lines.join('\n'));
    case 'markdown':
      return stripMarkdownComments(lines.join('\n'));
    case 'plain':
      return lines.join('\n');
  }
}

/** Offsets at which each line of `text` starts. */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      starts.push(i + 1);
    }
  }
  return starts;
}

/** 1-based line of the character at `offset`, given the result of `lineStarts`. */
export function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}

/**
 * Project-relative POSIX form: `\` becomes `/`, empty and `.` segments are dropped and `..`
 * removes the previous segment. Leading slashes are ignored. Returns `null` when the path climbs
 * above the project root.
 */
export function normalizeProjectPath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/** Directory part of a normalised project path; `''` for the project root. */
export function dirnameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** `relative` resolved against the project directory `dir`; `null` when it leaves the project. */
export function joinProjectPath(dir: string, relative: string): string | null {
  return normalizeProjectPath(dir === '' ? relative : `${dir}/${relative}`);
}

/** Whether the normalised `path` is `dir` itself or lies below it. */
export function isWithin(dir: string, path: string): boolean {
  return dir === '' || path === dir || path.startsWith(`${dir}/`);
}

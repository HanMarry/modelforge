import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  authorize,
  MANDATORY_EXCLUDE_PATTERNS,
  isExcludedPath,
  normalizeCollabPath,
  type CollabGuest,
  type CollabRequest,
  type CollabRequestKind,
} from './collabPolicy';

const kinds: CollabRequestKind[] = ['list', 'read', 'edit', 'comment'];
const roles: CollabGuest['role'][] = ['read-only', 'editable'];

// Feature: mathmodel-parity-and-beyond, Property 32: 协作访问控制
describe('Property 32: 协作访问控制', () => {
  it('authorize allows only shared, non-excluded paths and enforces the edit role', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...kinds),
        fc.constantFrom(...roles),
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.boolean(),
        fc.boolean(),
        (kind, role, rawPath, shared, excluded) => {
          const path = normalizeCollabPath(rawPath) || 'a.txt';
          const shareSet = new Set<string>(shared ? [path] : []);
          const excludeSet = excluded ? [`**/${path}`] : [];
          const request: CollabRequest = { kind, path };
          const guest: CollabGuest = { displayName: 'g', role };

          const expected =
            shared &&
            !excluded &&
            (kind === 'edit' ? role === 'editable' : true);

          expect(authorize(request, guest, shareSet, excludeSet)).toBe(expected);
        }
      ),
      pbtParams
    );
  });

  it('rejects read-only text edits but accepts read-only comments', () => {
    const guest: CollabGuest = { displayName: 'g', role: 'read-only' };
    const shareSet = new Set(['paper.tex']);
    expect(authorize({ kind: 'edit', path: 'paper.tex' }, guest, shareSet, [])).toBe(false);
    expect(authorize({ kind: 'comment', path: 'paper.tex' }, guest, shareSet, [])).toBe(true);
    const editor: CollabGuest = { displayName: 'e', role: 'editable' };
    expect(authorize({ kind: 'edit', path: 'paper.tex' }, editor, shareSet, [])).toBe(true);
  });

  it('normalizes backslashes and dot segments', () => {
    expect(normalizeCollabPath('.\\paper\\sub.tex')).toBe('paper/sub.tex');
    expect(normalizeCollabPath('./paper.tex')).toBe('paper.tex');
  });
});

describe('mandatory exclusion patterns', () => {
  it.each([
    ['.modelforge/sessions/x.log', true],
    ['.modelforge/sessions/2024/session.json', true],
    ['paper.log', true],
    ['logs/run.log', true],
    ['.env', true],
    ['sub/.env.local', true],
    ['credentials.json', true],
    ['a/b/credentials.json', true],
    ['agent-kernel-secrets.json', true],
    ['dir/agent-kernel-secrets.json', true],
    ['paper.tex', false],
    ['data.csv', false],
    ['src/main.py', false],
  ])('excludes %s as %s', (path, expected) => {
    expect(isExcludedPath(path, MANDATORY_EXCLUDE_PATTERNS)).toBe(expected);
  });
});

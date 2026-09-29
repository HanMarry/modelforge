import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import {
  addAnnotation,
  applyAnnotationUpdate,
  applyTextUpdate,
  createCollabDocs,
  encodeAnnotationState,
  encodeTextState,
  getFileText,
  listAnnotationRecords,
  listResolvedAnnotations,
  setFileText,
} from './collabDoc';

function seededRandom(seed: number): (max: number) => number {
  let state = seed >>> 0;
  return (max) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state % max;
  };
}

const FILES = ['paper.tex', 'data.txt', 'model.py'];
const LINES = ['introduction\n', 'the model is\n', 'results are shown in\n', 'conclusion\n'];
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 ';

function randomText(rng: (max: number) => number): string {
  const lineCount = rng(6) + 1;
  return Array.from({ length: lineCount }, () => {
    const wordCount = rng(6) + 1;
    return Array.from({ length: wordCount }, () => {
      const len = rng(5) + 1;
      return Array.from({ length: len }, () => ALPHABET[rng(ALPHABET.length)]).join('');
    }).join(' ');
  }).join('\n');
}

function sortedRecords(docs: ReturnType<typeof createCollabDocs>) {
  return listAnnotationRecords(docs)
    .map(({ id, fileId, author, content, anchor, createdAt }) => ({
      id,
      fileId,
      author,
      content,
      anchor,
      createdAt,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Feature: mathmodel-parity-and-beyond, Property 33: 批注同步收敛
describe('Property 33: 批注同步收敛', () => {
  it('text and annotations converge under arbitrary, duplicated update delivery', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        fc.nat(30),
        fc.nat(4),
        (seed, opCount, shuffleRounds) => {
          const rng = seededRandom(seed);
          const a = createCollabDocs();
          const b = createCollabDocs();
          for (const file of FILES) {
            setFileText(a, file, randomText(rng));
          }

          // Random edits and annotations on a random replica.
          for (let i = 0; i < opCount; i += 1) {
            const target = rng(2) === 0 ? a : b;
            const file = FILES[rng(FILES.length)];
            if (rng(2) === 0) {
              setFileText(target, file, randomText(rng));
            } else {
              addAnnotation(target, file, 'alice', `comment ${i}`, rng(10));
            }
          }

          const updates = [
            encodeTextState(a),
            encodeTextState(b),
            encodeAnnotationState(a),
            encodeAnnotationState(b),
          ];

          // Deliver in arbitrary order with arbitrary repetition; yjs updates are idempotent.
          for (let round = 0; round < shuffleRounds; round += 1) {
            const order = [...updates].sort(() => rng(3) - 1);
            for (const update of order) {
              if (rng(2) === 0) {
                applyTextUpdate(a, update);
                applyTextUpdate(b, update);
              } else {
                applyAnnotationUpdate(a, update);
                applyAnnotationUpdate(b, update);
              }
            }
          }

          for (const file of FILES) {
            expect(getFileText(a, file)).toBe(getFileText(b, file));
            const linesA = listResolvedAnnotations(a, file).map((entry) => entry.line);
            const linesB = listResolvedAnnotations(b, file).map((entry) => entry.line);
            expect(linesA).toEqual(linesB);
          }
          expect(sortedRecords(a)).toEqual(sortedRecords(b));
        }
      ),
      pbtParams
    );
  });

  it('keeps an anchor aligned to its line after edits above it', () => {
    const docs = createCollabDocs();
    const file = 'paper.tex';
    setFileText(docs, file, 'line one\nline two\nline three');
    const id = addAnnotation(docs, file, 'alice', 'look here', 2);

    expect(listResolvedAnnotations(docs, file).find((entry) => entry.id === id)?.line).toBe(2);

    // Insert two new lines before the anchored line; the anchor must move with its line.
    setFileText(docs, file, 'intro\npreface\nline one\nline two\nline three');
    expect(listResolvedAnnotations(docs, file).find((entry) => entry.id === id)?.line).toBe(4);
  });
});

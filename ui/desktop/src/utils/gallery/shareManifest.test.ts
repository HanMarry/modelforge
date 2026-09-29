import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import { TITLE_MAX_CODE_POINTS, validateShareManifest } from './shareManifest';

const missingArb = fc.constantFrom(undefined, '', null);
const presentArb = fc.string({ minLength: 1, maxLength: 8 });
const textFieldArb = fc.oneof(missingArb, presentArb);
const titleArb = fc.oneof(
  missingArb,
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.constantFrom('x'.repeat(TITLE_MAX_CODE_POINTS), 'y'.repeat(TITLE_MAX_CODE_POINTS + 1))
);

// Feature: mathmodel-parity-and-beyond, Property 30: 分享包元数据校验
describe('Property 30: 分享包元数据校验', () => {
  it('passes exactly when the four fields are present, the title is 1..200, and the PDF exists', () => {
    fc.assert(
      fc.property(
        titleArb,
        textFieldArb,
        textFieldArb,
        textFieldArb,
        fc.boolean(),
        (title, competition, category, abstract, hasPdf) => {
          const meta = { title, competition, category, abstract };
          const result = validateShareManifest(meta, hasPdf);

          const expected: string[] = [];
          const titleOk =
            typeof title === 'string' &&
            title.length > 0 &&
            Array.from(title).length <= TITLE_MAX_CODE_POINTS;
          if (!titleOk) expected.push('title');
          if (!(typeof competition === 'string' && competition.length > 0))
            expected.push('competition');
          if (!(typeof category === 'string' && category.length > 0)) expected.push('category');
          if (!(typeof abstract === 'string' && abstract.length > 0)) expected.push('abstract');
          if (!hasPdf) expected.push('pdf');

          expect(result.valid).toBe(expected.length === 0);
          expect([...result.invalidFields].sort()).toEqual(expected.sort());
        }
      ),
      pbtParams
    );
  });
});

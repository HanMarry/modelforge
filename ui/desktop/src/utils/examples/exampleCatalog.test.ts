import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../../test/pbt';
import type { ExampleManifest } from '../../types/catalog';
import {
  EXAMPLE_MANIFEST_FILE,
  bundleFiles,
  classifyExample,
  isCompleteManifest,
  shipsProblemAndAttachments,
} from './exampleCatalog';

const categoryArb = fc.constantFrom('优化类', '预测/统计类', '综合评价类', '其他');
const licenseArb = fc.record({
  type: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
  redistributable: fc.boolean(),
  note: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
});

/** Manifests with randomly missing/invalid fields, to exercise the completeness filter. */
const manifestArb = fc.record({
  id: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
  title: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
  category: categoryArb,
  source: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
  license: licenseArb,
  officialUrl: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
  problemFile: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1 })),
  attachments: fc.oneof(
    fc.constant(undefined),
    fc.array(fc.string({ minLength: 1 }), { minLength: 0, maxLength: 3 })
  ),
  solution: fc.oneof(
    fc.constant(undefined),
    fc.array(
      fc.record({ question: fc.string({ minLength: 1 }), file: fc.string({ minLength: 1 }) }),
      { minLength: 0, maxLength: 3 }
    )
  ),
});

/** A fully valid manifest for exercising the bundle filter. */
const completeManifestArb: fc.Arbitrary<ExampleManifest> = fc.record({
  id: fc.string({ minLength: 1 }),
  title: fc.string({ minLength: 1 }),
  category: fc.constantFrom('优化类', '预测/统计类', '综合评价类'),
  source: fc.string({ minLength: 1 }),
  license: fc.record({
    type: fc.string({ minLength: 1 }),
    redistributable: fc.boolean(),
    note: fc.string({ minLength: 1 }),
  }),
  officialUrl: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
  problemFile: fc.constant('problem.md'),
  // Attachments and solution files live in their own folders, as in the real manifests, so an
  // attachment can never share a name with a solution file (always shipped), the problem file
  // or the manifest; such a collision made the "iff redistributable" check fail spuriously.
  attachments: fc.array(
    fc.string({ minLength: 1 }).map((name) => `data/${name}`),
    { minLength: 1, maxLength: 3 }
  ),
  solution: fc.array(
    fc.record({
      question: fc.string({ minLength: 1 }),
      file: fc.string({ minLength: 1 }).map((name) => `solution/${name}`),
    }),
    { minLength: 1, maxLength: 3 }
  ),
});

// Feature: mathmodel-parity-and-beyond, Property 19: 示例题列表与打包过滤
describe('Property 19: 示例题列表与打包过滤', () => {
  it('keeps exactly the complete manifests', () => {
    fc.assert(
      fc.property(fc.array(manifestArb, { maxLength: 20 }), (manifests) => {
        const entries = manifests.map((m) => classifyExample(m, () => true));
        const kept = entries.filter((e) => e !== null);
        const expectedComplete = manifests.filter((m) => isCompleteManifest(m));
        expect(kept).toHaveLength(expectedComplete.length);
      }),
      pbtParams
    );
  });

  it('bundles problem and attachments iff redistributable', () => {
    fc.assert(
      fc.property(completeManifestArb, (manifest) => {
        const files = bundleFiles(manifest);
        const shipped = new Set(files);

        expect(shipped.has(EXAMPLE_MANIFEST_FILE)).toBe(true);
        for (const section of manifest.solution) {
          expect(shipped.has(section.file)).toBe(true);
        }

        expect(shipped.has(manifest.problemFile)).toBe(manifest.license.redistributable);
        for (const attachment of manifest.attachments) {
          expect(shipped.has(attachment)).toBe(manifest.license.redistributable);
        }
        expect(shipsProblemAndAttachments(manifest)).toBe(manifest.license.redistributable);
      }),
      pbtParams
    );
  });

  it('marks a complete but absent, non-redistributable example as needsDownload', () => {
    const manifest: ExampleManifest = {
      id: 'x',
      title: 'x',
      category: '优化类',
      source: 'x',
      license: { type: 'CC BY 4.0', redistributable: false, note: 'n' },
      officialUrl: 'https://example.com',
      problemFile: 'problem.md',
      attachments: ['data.csv'],
      solution: [{ question: 'q', file: 'solution/q.md' }],
    };
    expect(classifyExample(manifest, () => false)?.needsDownload).toBe(true);
    expect(classifyExample(manifest, () => true)?.needsDownload).toBe(false);
  });
});

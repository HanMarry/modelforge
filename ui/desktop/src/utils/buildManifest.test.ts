// @vitest-environment node
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { pbtParams } from '../test/pbt';
import {
  createManifest,
  describeReleaseBlocker,
  isArtifactFileName,
  parseKernelBuildInfo,
  parseManifest,
  provenanceDifferences,
  releaseBlockers,
  serializeManifest,
  verifyManifest,
  type BuildManifest,
  type BuildType,
  type ManifestInput,
  type ManifestMismatch,
} from './buildManifest';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const sha256Arb = fc.stringMatching(/^[0-9a-f]{64}$/);

/** File names with CJK, emoji, spaces and names that collide with `Object.prototype`. */
const fileNameArb = fc.oneof(
  fc.constantFrom(
    'goose.exe',
    'goose',
    '模型 内核.exe',
    'ümlaut 😀.bin',
    '__proto__',
    'constructor'
  ),
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 16 }).filter(isArtifactFileName)
);

const manifestArb: fc.Arbitrary<BuildManifest> = fc
  .record({
    commit: fc.stringMatching(/^[0-9a-f]{40}$/),
    dirty: fc.boolean(),
    buildType: fc.constantFrom<BuildType>('release', 'dev'),
    features: fc.uniqueArray(
      fc.constantFrom('aws-providers', 'code-mode', 'otel', 'rustls-tls', 'system-keyring')
    ),
    artifacts: fc.uniqueArray(fc.record({ file: fileNameArb, sha256: sha256Arb }), {
      selector: (artifact) => artifact.file,
      minLength: 1,
      maxLength: 6,
    }),
    skills: fc.nat({ max: 500 }),
    examples: fc.uniqueArray(
      fc
        .string({ unit: 'grapheme', minLength: 1, maxLength: 12 })
        .filter((name) => name.trim().length > 0),
      { maxLength: 3 }
    ),
    builtAt: fc.date({
      min: new Date('2000-01-01T00:00:00Z'),
      max: new Date('2100-01-01T00:00:00Z'),
      noInvalidDate: true,
    }),
  })
  .map((fields) =>
    createManifest({
      commit: fields.commit,
      dirty: fields.dirty,
      buildType: fields.buildType,
      toolchain: { rust: '1.96.1 (test 2026-01-01)', node: '24.10.0' },
      features: fields.features,
      target: 'x86_64-pc-windows-gnu',
      version: '1.50.0',
      builtAt: fields.builtAt,
      artifacts: fields.artifacts,
      content: { skills: fields.skills, examples: fields.examples },
    })
  );

type ArtifactAction = 'keep' | 'keep-uppercase' | 'tamper' | 'remove';

const actionArb = fc.constantFrom<ArtifactAction>('keep', 'keep-uppercase', 'tamper', 'remove');

/** A hash guaranteed to differ from `recorded`. */
function tamperedHash(recorded: string, candidate: string): string {
  if (candidate !== recorded) {
    return candidate;
  }
  return `${recorded.startsWith('0') ? '1' : '0'}${recorded.slice(1)}`;
}

function baseInput(overrides: Partial<ManifestInput> = {}): ManifestInput {
  return {
    commit: COMMIT,
    dirty: false,
    buildType: 'release',
    toolchain: { rust: '1.96.1', node: '24.10.0' },
    features: ['rustls-tls', 'aws-providers'],
    target: 'x86_64-pc-windows-gnu',
    version: '1.50.0',
    builtAt: '2026-09-20T08:00:00.000Z',
    artifacts: [{ file: 'goose.exe', sha256: SHA_A }],
    content: { skills: 47, examples: [] },
    ...overrides,
  };
}

function manifestJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({ ...createManifest(baseInput()), ...overrides });
}

// Feature: mathmodel-parity-and-beyond, Property 12: Build_Manifest 校验
describe('Property 12: Build_Manifest 校验', () => {
  it('reports exactly the tampered or missing binaries, with recorded and actual hashes', () => {
    fc.assert(
      fc.property(
        manifestArb.chain((manifest) => {
          const count = manifest.artifacts.length;
          return fc.tuple(
            fc.constant(manifest),
            fc.array(actionArb, { minLength: count, maxLength: count }),
            fc.array(sha256Arb, { minLength: count, maxLength: count }),
            fc.array(fc.tuple(fileNameArb, sha256Arb), { maxLength: 3 })
          );
        }),
        ([manifest, actions, candidates, extras]) => {
          const listed = new Set(manifest.artifacts.map(({ file }) => file));
          const entries: Array<[string, string]> = [];
          const expected: ManifestMismatch[] = [];

          manifest.artifacts.forEach(({ file, sha256 }, index) => {
            const action = actions[index];
            if (action === 'keep') {
              entries.push([file, sha256]);
            } else if (action === 'keep-uppercase') {
              entries.push([file, sha256.toUpperCase()]);
            } else if (action === 'tamper') {
              const actual = tamperedHash(sha256, candidates[index]);
              entries.push([file, actual]);
              expected.push({ file, recorded: sha256, actual });
            } else {
              expected.push({ file, recorded: sha256, actual: null });
            }
          });
          // Binaries the manifest does not list are not its concern.
          for (const [file, sha256] of extras) {
            if (!listed.has(file)) {
              entries.push([file, sha256]);
            }
          }

          expect(verifyManifest(manifest, Object.fromEntries(entries))).toEqual(expected);

          const untouched = Object.fromEntries(
            manifest.artifacts.map(({ file, sha256 }) => [file, sha256])
          );
          expect(verifyManifest(manifest, untouched)).toEqual([]);
        }
      ),
      pbtParams
    );
  });
});

describe('parseManifest', () => {
  it('round-trips every manifest createManifest produces', () => {
    fc.assert(
      fc.property(manifestArb, (manifest) => {
        expect(parseManifest(serializeManifest(manifest))).toEqual({ ok: true, manifest });
      }),
      pbtParams
    );
  });

  it('drops unknown keys', () => {
    const result = parseManifest(manifestJson({ extra: 'ignored' }));

    expect(result.ok).toBe(true);
    expect(result.ok && 'extra' in result.manifest).toBe(false);
  });

  it.each([
    ['invalid JSON', '{'],
    ['a JSON array', '[]'],
    ['another schema version', manifestJson({ schemaVersion: 2 })],
    ['an abbreviated commit', manifestJson({ commit: '0123456' })],
    ['an uppercase commit', manifestJson({ commit: COMMIT.toUpperCase() })],
    ['a missing dirty flag', manifestJson({ dirty: undefined })],
    ['an unknown build type', manifestJson({ buildType: 'nightly' })],
    ['a missing Node version', manifestJson({ toolchain: { rust: '1.96.1', node: '' } })],
    ['features that are not names', manifestJson({ features: ['otel', 3] })],
    ['an empty target', manifestJson({ target: '' })],
    ['a date without time', manifestJson({ builtAt: '2026-09-20' })],
    ['no artifacts', manifestJson({ artifacts: [] })],
    ['an artifact path', manifestJson({ artifacts: [{ file: '../goose.exe', sha256: SHA_A }] })],
    ['a Windows path', manifestJson({ artifacts: [{ file: 'bin\\goose.exe', sha256: SHA_A }] })],
    ['a drive-relative path', manifestJson({ artifacts: [{ file: 'C:goose', sha256: SHA_A }] })],
    ['a short hash', manifestJson({ artifacts: [{ file: 'goose.exe', sha256: 'abc' }] })],
    [
      'a duplicate artifact',
      manifestJson({
        artifacts: [
          { file: 'goose.exe', sha256: SHA_A },
          { file: 'goose.exe', sha256: SHA_B },
        ],
      }),
    ],
    ['a negative skill count', manifestJson({ content: { skills: -1, examples: [] } })],
    ['a fractional skill count', manifestJson({ content: { skills: 1.5, examples: [] } })],
    ['missing examples', manifestJson({ content: { skills: 1 } })],
  ])('rejects %s', (_label, json) => {
    const result = parseManifest(json);

    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).not.toBe('');
  });
});

describe('createManifest', () => {
  it('sorts features and examples and lowercases hashes', () => {
    const manifest = createManifest(
      baseInput({
        commit: COMMIT.toUpperCase(),
        features: ['rustls-tls', 'aws-providers', 'rustls-tls'],
        artifacts: [{ file: 'goose.exe', sha256: SHA_A.toUpperCase() }],
        content: { skills: 3, examples: ['b', 'a'] },
      })
    );

    expect(manifest.commit).toBe(COMMIT);
    expect(manifest.features).toEqual(['aws-providers', 'rustls-tls']);
    expect(manifest.artifacts).toEqual([{ file: 'goose.exe', sha256: SHA_A }]);
    expect(manifest.content.examples).toEqual(['a', 'b']);
    expect(manifest.buildType).toBe('release');
  });

  it('throws on input requirement 3.2 would reject', () => {
    expect(() => createManifest(baseInput({ commit: 'unknown' }))).toThrow(/commit/);
    expect(() => createManifest(baseInput({ artifacts: [] }))).toThrow(/artifacts/);
  });
});

describe('releaseBlockers', () => {
  const actual = { 'goose.exe': SHA_A };

  it('lets a clean release with matching binaries through', () => {
    expect(releaseBlockers(createManifest(baseInput()), actual)).toEqual([]);
  });

  it('blocks dirty sources, dev builds and changed binaries', () => {
    const manifest = createManifest(baseInput({ dirty: true, buildType: 'dev' }));
    const blockers = releaseBlockers(manifest, { 'goose.exe': SHA_B });

    expect(blockers.map((blocker) => blocker.kind)).toEqual(['not-release', 'dirty', 'mismatch']);
    const lines = blockers.flatMap(describeReleaseBlocker);
    expect(lines).toContain(`goose.exe: recorded sha256 ${SHA_A}, actual ${SHA_B}`);
    expect(lines.some((line) => line.includes('uncommitted changes'))).toBe(true);
  });

  it('names missing binaries', () => {
    const blockers = releaseBlockers(createManifest(baseInput()), {});

    expect(blockers.flatMap(describeReleaseBlocker)).toEqual([
      `goose.exe: recorded sha256 ${SHA_A}, actual (file missing)`,
    ]);
  });
});

describe('kernel build info', () => {
  it('parses goose version --json, including unknown provenance', () => {
    const json = JSON.stringify({ version: '1.50.0', commit: null, dirty: null, features: [] });

    expect(parseKernelBuildInfo(json)).toEqual({
      ok: true,
      info: { version: '1.50.0', commit: null, dirty: null, features: [] },
    });
  });

  it('rejects abbreviated commits and missing fields', () => {
    const abbreviated = { version: '1.50.0', commit: 'abc1234', dirty: false, features: [] };

    expect(parseKernelBuildInfo(JSON.stringify(abbreviated)).ok).toBe(false);
    expect(parseKernelBuildInfo('{"version":"1.50.0"}').ok).toBe(false);
    expect(parseKernelBuildInfo('not json').ok).toBe(false);
  });

  it('lists every field where the kernel disagrees with its manifest', () => {
    const manifest = createManifest(baseInput());
    const agreeing = {
      version: manifest.version,
      commit: manifest.commit,
      dirty: manifest.dirty,
      features: [...manifest.features].reverse(),
    };

    const disagreeing = { ...agreeing, commit: null, dirty: true, features: [] };
    const fields = provenanceDifferences(manifest, disagreeing).map((line) => line.split(':')[0]);

    expect(provenanceDifferences(manifest, agreeing)).toEqual([]);
    expect(fields).toEqual(['commit', 'dirty', 'features']);
  });
});

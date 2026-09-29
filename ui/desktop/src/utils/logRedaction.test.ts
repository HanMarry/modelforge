import { describe, expect, it } from 'vitest';
import { redactLogData } from './logRedaction';
import { maskSecret } from './secretMask';

const SECRET = 'sk-log-0123456789abcdef';
const MASKED = maskSecret(SECRET);

describe('redactLogData', () => {
  it('masks key values inside log strings', () => {
    expect(redactLogData([`saving ${SECRET} for kernel`, 42], [SECRET])).toEqual([
      `saving ${MASKED} for kernel`,
      42,
    ]);
  });

  it('masks a key carried by an error message, stack or cause', () => {
    const [plain, nested] = redactLogData(
      [
        new Error(`rejected ${SECRET}`),
        new Error('provider call failed', { cause: new Error(`bad key ${SECRET}`) }),
      ],
      [SECRET]
    );

    for (const entry of [plain, nested]) {
      expect(typeof entry).toBe('string');
      expect(entry).not.toContain(SECRET);
      expect(entry).toContain(MASKED);
    }
  });

  it('masks a key nested in an object, including one with cycles', () => {
    const config: Record<string, unknown> = { headers: { Authorization: `Bearer ${SECRET}` } };
    config.self = config;

    const [entry] = redactLogData([config], [SECRET]);

    expect(typeof entry).toBe('string');
    expect(entry).not.toContain(SECRET);
    expect(entry).toContain(MASKED);
  });

  it('leaves entries without a key untouched', () => {
    const error = new Error('network down');
    const details = { status: 503 };

    const data = redactLogData(['plain text', error, details, null, undefined], [SECRET]);

    expect(data[0]).toBe('plain text');
    expect(data[1]).toBe(error);
    expect(data[2]).toBe(details);
    expect(data.slice(3)).toEqual([null, undefined]);
  });

  it('returns the data as it is when no key is known', () => {
    const data = [`saving ${SECRET}`];

    expect(redactLogData(data, [])).toEqual(data);
  });
});

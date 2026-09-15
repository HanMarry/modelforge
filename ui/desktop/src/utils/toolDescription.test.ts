import { describe, expect, it } from 'vitest';
import { describeToolCall, getToolShortName, unwrapToolCall } from './toolDescription';

describe('getToolShortName', () => {
  it('strips the extension prefix', () => {
    expect(getToolShortName('developer__shell')).toBe('shell');
  });

  it('keeps unprefixed names', () => {
    expect(getToolShortName('shell')).toBe('shell');
  });
});

describe('describeToolCall', () => {
  it('describes shell commands', () => {
    expect(
      describeToolCall({ name: 'developer__shell', arguments: { command: 'uv run a.py' } })
    ).toBe('running uv run a.py');
  });

  it('describes editor writes, reads and edits', () => {
    expect(
      describeToolCall({
        name: 'developer__text_editor',
        arguments: { command: 'write', path: 'a.py' },
      })
    ).toBe('writing a.py');
    expect(
      describeToolCall({
        name: 'developer__text_editor',
        arguments: { command: 'view', path: 'a.py' },
      })
    ).toBe('reading a.py');
    expect(
      describeToolCall({
        name: 'developer__text_editor',
        arguments: { command: 'str_replace', path: 'a.py' },
      })
    ).toBe('editing a.py');
  });

  it('falls back to a title-cased tool name with compact arguments', () => {
    expect(describeToolCall({ name: 'custom__my_tool', arguments: { paper: 'c' } })).toBe(
      'My Tool paper: c'
    );
    expect(describeToolCall({ name: 'custom__my_tool', arguments: {} })).toBe('My Tool');
    expect(describeToolCall({ name: 'custom__my_tool', arguments: { a: 1, b: 2 } })).toBe(
      'My Tool a, b'
    );
  });
});

describe('unwrapToolCall', () => {
  it('unwraps the success envelope', () => {
    expect(
      unwrapToolCall({
        status: 'success',
        value: { name: 'developer__shell', arguments: { command: 'ls' } },
      })
    ).toEqual({ name: 'developer__shell', arguments: { command: 'ls' } });
  });

  it('accepts the unwrapped shape', () => {
    expect(unwrapToolCall({ name: 'developer__shell' })).toEqual({
      name: 'developer__shell',
      arguments: undefined,
    });
  });

  it('returns null for malformed payloads', () => {
    expect(unwrapToolCall(undefined)).toBeNull();
    expect(unwrapToolCall({ status: 'error', error: 'nope' })).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { mergeComposerPreset, seedComposer, takeComposerSeed } from './composerSeed';

describe('composer presets preserve user work', () => {
  it('keeps an existing unsent question when choosing a preset', () => {
    expect(mergeComposerPreset('My constraints and question', 'Review the paper')).toBe(
      'My constraints and question\n\nReview the paper'
    );
  });
  it('updates the previous preset without discarding the user part', () => {
    expect(mergeComposerPreset('My question\n\nOld preset', 'New preset', 'Old preset')).toBe(
      'My question\n\nNew preset'
    );
    expect(mergeComposerPreset('Old preset\n\nExtra constraints', 'New preset', 'Old preset')).toBe(
      'New preset\n\nExtra constraints'
    );
  });
  it('retains a preset the user edited themselves', () => {
    expect(mergeComposerPreset('User-edited preset', 'New task', 'Old preset')).toBe(
      'User-edited preset\n\nNew task'
    );
  });
  it('fills an empty draft and replaces an untouched preset', () => {
    expect(mergeComposerPreset('', 'New')).toBe('New');
    expect(mergeComposerPreset('Old', 'New', 'Old')).toBe('New');
  });
  it('consumes a catalogue seed only once', () => {
    seedComposer('Selected template', 'test-seed');
    expect(takeComposerSeed()?.text).toBe('Selected template');
    expect(takeComposerSeed()).toBeNull();
  });
});

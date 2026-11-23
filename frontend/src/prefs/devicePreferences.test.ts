import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CALL_OUTPUT_VOLUME,
  normalizeOutputVolume,
  readCallOutputVolume,
  resetCallOutputPreferencesForTests,
  writeCallOutputVolume,
} from './devicePreferences';

describe('#107 call output volume preference', () => {
  it('clamps and rounds only integer percentages', () => {
    expect(normalizeOutputVolume(0)).toBe(0);
    expect(normalizeOutputVolume(100)).toBe(100);
    expect(normalizeOutputVolume(42.6)).toBe(43);
    expect(normalizeOutputVolume(-5)).toBe(0);
    expect(normalizeOutputVolume(140)).toBe(100);
    expect(normalizeOutputVolume('35')).toBe(35);
  });

  it('falls back to the default for malformed values', () => {
    expect(normalizeOutputVolume(null)).toBe(DEFAULT_CALL_OUTPUT_VOLUME);
    expect(normalizeOutputVolume(Number.NaN)).toBe(DEFAULT_CALL_OUTPUT_VOLUME);
    expect(normalizeOutputVolume('loud')).toBe(DEFAULT_CALL_OUTPUT_VOLUME);
  });

  it('persists the chosen value for the next mount and resets it', () => {
    expect(writeCallOutputVolume(37)).toBe(37);
    expect(readCallOutputVolume()).toBe(37);

    resetCallOutputPreferencesForTests();
    expect(readCallOutputVolume()).toBe(DEFAULT_CALL_OUTPUT_VOLUME);
  });
});

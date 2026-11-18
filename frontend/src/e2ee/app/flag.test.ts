import { afterEach, describe, expect, it } from 'vitest';
import {
  E2EE_FLAG_ENV,
  isE2eeEnabled,
  parseE2eeFlag,
  readEnvE2eeFlag,
  resetE2eeFlagForTests,
  setE2eeEnabledForTests,
} from './flag';

afterEach(() => resetE2eeFlagForTests());

describe('E2EE feature flag', () => {
  it('is off by default and for every malformed value', () => {
    expect(isE2eeEnabled({})).toBe(false);
    expect(readEnvE2eeFlag({})).toBe(false);
    expect(parseE2eeFlag(undefined)).toBe(false);
    expect(parseE2eeFlag('')).toBe(false);
    expect(parseE2eeFlag('maybe')).toBe(false);
    expect(parseE2eeFlag('enabled')).toBe(false);
  });

  it('accepts only explicit truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) {
      expect(parseE2eeFlag(value)).toBe(true);
    }
    for (const value of ['0', 'false', 'no', 'off']) {
      expect(parseE2eeFlag(value, true)).toBe(false);
    }
    expect(readEnvE2eeFlag({ [E2EE_FLAG_ENV]: 'true' })).toBe(true);
  });

  it('lets a runtime override win and restores the env value afterwards', () => {
    const env = { [E2EE_FLAG_ENV]: 'true' };
    expect(isE2eeEnabled(env)).toBe(true);
    setE2eeEnabledForTests(false);
    expect(isE2eeEnabled(env)).toBe(false);
    resetE2eeFlagForTests();
    expect(isE2eeEnabled(env)).toBe(true);
    expect(isE2eeEnabled({})).toBe(false);
  });
});

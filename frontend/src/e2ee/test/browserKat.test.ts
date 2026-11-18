/**
 * Node-side guard for the browser KAT harness (E7-F7A).
 *
 * The same `browserKat.ts` module is executed by Playwright in Chromium,
 * Firefox and WebKit. Running it here under Node's WebCrypto catches a broken
 * harness or a stale vector id without waiting for a real-browser run.
 */
import { describe, expect, it } from 'vitest';
import { runBrowserKat, runEnvelopeTamperKat } from './browserKat';
import { loadVectorFile } from './vectors';

describe('browser KAT runner', () => {
  it('passes A/B/C/D/F/G against the normative vector file', async () => {
    const result = await runBrowserKat(loadVectorFile());
    expect(result.cases.filter((entry) => !entry.ok)).toEqual([]);
    expect(result.cases).toHaveLength(22);
    expect(result.failures).toBe(0);
    expect(result.checks).toBeGreaterThan(80);
  });

  it('rejects tampered envelope, AD, preamble and AEAD inputs', async () => {
    const result = await runEnvelopeTamperKat(loadVectorFile());
    expect(result.cases.filter((entry) => !entry.ok)).toEqual([]);
    expect(result.cases).toHaveLength(10);
    expect(result.failures).toBe(0);
    expect(result.checks).toBeGreaterThanOrEqual(10);
  });
});

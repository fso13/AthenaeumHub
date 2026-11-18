/** WebCrypto feature detection (§2.4, E2EE-ADR-02): detect, never guess. */
import { describe, expect, it } from 'vitest';
import {
  E2EE_PRIMITIVES,
  detectE2eeSupport,
  getCryptoApi,
  getSubtle,
  requireE2eeSupport,
} from './crypto/support';

function fakeCrypto(value: Record<string, unknown>): Crypto {
  return value as unknown as Crypto;
}

describe('WebCrypto feature detection', () => {
  it('finds every required primitive in the test runtime', async () => {
    const support = await detectE2eeSupport();
    expect(support.available).toBe(true);
    expect(support.missing).toEqual([]);
    for (const primitive of E2EE_PRIMITIVES) {
      expect(support.primitives[primitive]).toBe(true);
    }
    expect(getSubtle()).toBe(globalThis.crypto.subtle);
    expect(getCryptoApi()).toBe(globalThis.crypto);
  });

  it('caches the probe per crypto object', async () => {
    const first = await detectE2eeSupport();
    const second = await detectE2eeSupport();
    expect(second).toBe(first);
  });

  it('reports all primitives missing when crypto is absent', async () => {
    const support = await detectE2eeSupport(null);
    expect(support.available).toBe(false);
    expect(support.missing).toEqual([...E2EE_PRIMITIVES]);
    for (const primitive of E2EE_PRIMITIVES) {
      expect(support.primitives[primitive]).toBe(false);
    }
  });

  it('reports no subtle as unsupported except CSPRNG', async () => {
    const support = await detectE2eeSupport(
      fakeCrypto({ getRandomValues: (array: Uint8Array) => array }),
    );
    expect(support.available).toBe(false);
    expect(support.primitives.random).toBe(true);
    expect(support.missing).toEqual(E2EE_PRIMITIVES.filter((primitive) => primitive !== 'random'));
  });

  it('treats throwing/partial subtle implementations as missing (no fallback)', async () => {
    const support = await detectE2eeSupport(fakeCrypto({ subtle: {} }));
    expect(support.available).toBe(false);
    expect(support.primitives.random).toBe(false);
    expect(support.missing).toEqual([...E2EE_PRIMITIVES]);

    const partlyBroken = fakeCrypto({
      subtle: {
        digest: () => Promise.reject(new Error('not supported')),
      },
    });
    const partial = await detectE2eeSupport(partlyBroken);
    expect(partial.primitives.sha256).toBe(false);
    expect(partial.primitives.sha512).toBe(false);
    expect(partial.available).toBe(false);
  });

  it('rejects an Ed25519 implementation that fails the RFC 8032 known-answer probe', async () => {
    const real = globalThis.crypto.subtle;
    // Self-consistent sign/verify (WebKit-like) but not byte-exact for the
    // empty message: the runtime floor must reject the primitive.
    const sign = async (
      algorithm: AlgorithmIdentifier,
      key: CryptoKey,
      data: BufferSource,
    ): Promise<ArrayBuffer> => {
      const signature = await real.sign(algorithm, key, data);
      const view = new Uint8Array(signature);
      const name = typeof algorithm === 'string' ? algorithm : algorithm.name;
      if (name === 'Ed25519' && view.byteLength === 0) return signature;
      if (name === 'Ed25519' && (data as ArrayBuffer).byteLength === 0) {
        view[0] = (view[0] ?? 0) ^ 1;
      }
      return view.buffer;
    };
    const subtle = {
      digest: real.digest.bind(real),
      importKey: real.importKey.bind(real),
      exportKey: real.exportKey.bind(real),
      generateKey: real.generateKey.bind(real),
      deriveBits: real.deriveBits.bind(real),
      encrypt: real.encrypt.bind(real),
      sign: sign as SubtleCrypto['sign'],
      verify: real.verify.bind(real),
    } as unknown as SubtleCrypto;
    const broken = fakeCrypto({
      getRandomValues: (array: Uint8Array) => globalThis.crypto.getRandomValues(array),
      subtle,
    });

    const support = await detectE2eeSupport(broken);
    expect(support.available).toBe(false);
    expect(support.primitives.ed25519).toBe(false);
    expect(support.missing).toEqual(['ed25519']);
    await expect(requireE2eeSupport(broken)).rejects.toMatchObject({
      code: 'E2EE_UNSUPPORTED_BROWSER',
      message: expect.stringContaining('ed25519'),
    });
  });

  it('requireE2eeSupport rejects with E2EE_UNSUPPORTED_BROWSER and names the gap', async () => {
    await expect(requireE2eeSupport(fakeCrypto({}))).rejects.toMatchObject({
      code: 'E2EE_UNSUPPORTED_BROWSER',
      message: expect.stringContaining('x25519'),
    });
    await expect(requireE2eeSupport()).resolves.toMatchObject({ available: true });
  });
});

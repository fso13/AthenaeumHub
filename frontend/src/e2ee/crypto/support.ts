/**
 * WebCrypto feature detection (docs/E2EE-SPEC.md §2.4, E2EE-ADR-02).
 *
 * There is deliberately no JS/WASM fallback: if any required primitive is
 * missing, E2EE must stay disabled and the UI says "browser does not support
 * E2EE". Version floors are never inferred from the User-Agent string.
 */
import { E2eeError } from '../errors';
import { runEd25519KnownAnswerTest } from './ed25519Kat';

export const E2EE_PRIMITIVES = [
  'random',
  'sha256',
  'sha512',
  'hmacSha256',
  'hkdfSha256',
  'aesGcm256',
  'x25519',
  'ed25519',
] as const;

export type E2eePrimitive = (typeof E2EE_PRIMITIVES)[number];

export interface E2eeSupport {
  readonly available: boolean;
  readonly primitives: Readonly<Record<E2eePrimitive, boolean>>;
  readonly missing: readonly E2eePrimitive[];
}

type CryptoApi = Crypto;

const supportCache = new WeakMap<CryptoApi, Promise<E2eeSupport>>();

export function getCryptoApi(): CryptoApi {
  const api = globalThis.crypto;
  if (!api) {
    throw new E2eeError('E2EE_UNSUPPORTED_BROWSER', 'Web Crypto API (crypto) is unavailable');
  }
  return api;
}

export function getSubtle(): SubtleCrypto {
  const subtle = getCryptoApi().subtle;
  if (!subtle) {
    throw new E2eeError(
      'E2EE_UNSUPPORTED_BROWSER',
      'Web Crypto API (crypto.subtle) is unavailable',
    );
  }
  return subtle;
}

function emptyPrimitives(): Record<E2eePrimitive, boolean> {
  const primitives = {} as Record<E2eePrimitive, boolean>;
  for (const primitive of E2EE_PRIMITIVES) primitives[primitive] = false;
  return primitives;
}

function unsupported(): E2eeSupport {
  return {
    available: false,
    primitives: emptyPrimitives(),
    missing: [...E2EE_PRIMITIVES],
  };
}

async function tryPrimitive(operation: () => Promise<boolean>): Promise<boolean> {
  try {
    return await operation();
  } catch {
    return false;
  }
}

async function detect(cryptoApi: CryptoApi | undefined): Promise<E2eeSupport> {
  if (!cryptoApi) return unsupported();

  const primitives = emptyPrimitives();
  primitives.random =
    typeof cryptoApi.getRandomValues === 'function' &&
    (() => {
      try {
        const probe = cryptoApi.getRandomValues(new Uint8Array(4));
        return probe.length === 4;
      } catch {
        return false;
      }
    })();

  const subtle = cryptoApi.subtle;
  if (!subtle) {
    return {
      available: false,
      primitives,
      missing: E2EE_PRIMITIVES.filter((primitive) => !primitives[primitive]),
    };
  }

  primitives.sha256 = await tryPrimitive(async () => {
    const digest = await subtle.digest('SHA-256', new Uint8Array([0]));
    return digest.byteLength === 32;
  });
  primitives.sha512 = await tryPrimitive(async () => {
    const digest = await subtle.digest('SHA-512', new Uint8Array([0]));
    return digest.byteLength === 64;
  });
  primitives.hmacSha256 = await tryPrimitive(async () => {
    const key = await subtle.importKey(
      'raw',
      new Uint8Array(32),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await subtle.sign({ name: 'HMAC' }, key, new Uint8Array([1]));
    return signature.byteLength === 32;
  });
  primitives.hkdfSha256 = await tryPrimitive(async () => {
    const key = await subtle.importKey('raw', new Uint8Array(32), 'HKDF', false, ['deriveBits']);
    const bits = await subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new Uint8Array([1]) },
      key,
      256,
    );
    return bits.byteLength === 32;
  });
  primitives.aesGcm256 = await tryPrimitive(async () => {
    const key = await subtle.importKey('raw', new Uint8Array(32), 'AES-GCM', false, ['encrypt']);
    const ciphertext = await subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(12),
        additionalData: new Uint8Array(0),
        tagLength: 128,
      },
      key,
      new Uint8Array(0),
    );
    return ciphertext.byteLength === 16;
  });
  primitives.x25519 = await tryPrimitive(async () => {
    const pair = (await subtle.generateKey({ name: 'X25519' }, false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const bits = await subtle.deriveBits(
      { name: 'X25519', public: pair.publicKey },
      pair.privateKey,
      256,
    );
    return bits.byteLength === 32;
  });
  primitives.ed25519 = await tryPrimitive(async () => {
    const pair = (await subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const signature = await subtle.sign({ name: 'Ed25519' }, pair.privateKey, new Uint8Array([1]));
    const valid = await subtle.verify(
      { name: 'Ed25519' },
      pair.publicKey,
      signature,
      new Uint8Array([1]),
    );
    if (signature.byteLength !== 64 || !valid) return false;
    // E7-F8 P1-04 / ADR-26: self-consistency alone is not a browser floor.
    // Ed25519 must reproduce RFC 8032 byte-for-byte (WebKit does not).
    return runEd25519KnownAnswerTest(subtle);
  });

  const missing = E2EE_PRIMITIVES.filter((primitive) => !primitives[primitive]);
  return { available: missing.length === 0, primitives, missing };
}

/** Feature-detects every primitive; the result is cached per `crypto` object. */
export async function detectE2eeSupport(
  cryptoApi: CryptoApi | null | undefined = globalThis.crypto,
): Promise<E2eeSupport> {
  if (!cryptoApi) return unsupported();
  const cached = supportCache.get(cryptoApi);
  if (cached) return cached;
  const pending = detect(cryptoApi);
  supportCache.set(cryptoApi, pending);
  return pending;
}

/** Throws `E2EE_UNSUPPORTED_BROWSER` when any required primitive is missing. */
export async function requireE2eeSupport(
  cryptoApi: CryptoApi | null | undefined = globalThis.crypto,
): Promise<E2eeSupport> {
  const support = await detectE2eeSupport(cryptoApi);
  if (!support.available) {
    throw new E2eeError(
      'E2EE_UNSUPPORTED_BROWSER',
      `Web Crypto does not support: ${support.missing.join(', ')}`,
    );
  }
  return support;
}

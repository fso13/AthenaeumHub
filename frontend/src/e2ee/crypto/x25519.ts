/**
 * X25519 key agreement through WebCrypto (§2.4).
 *
 * Private keys are always imported non-extractable. Deriving the public key
 * from a 32-byte private seed needs a temporary extractable import (WebCrypto
 * only accepts PKCS#8 for private keys); the temporary PKCS#8 buffer is zeroed
 * immediately afterwards and only the public half is kept.
 */
import { KEY_BYTES } from '../constants';
import { E2eeError, isE2eeError } from '../errors';
import { assertBytesLength, zeroBytes } from '../encoding/bytes';
import { decodeBase64Url } from '../encoding/base64url';
import { bufferSource } from './bufferSource';
import { exportedRawKeyBytes } from './rawKeyBytes';
import { getSubtle } from './support';

/** DER prefix for a raw 32-byte X25519 private key (RFC 8410). */
const X25519_PKCS8_PREFIX = Uint8Array.of(
  0x30,
  0x2e,
  0x02,
  0x01,
  0x00,
  0x30,
  0x05,
  0x06,
  0x03,
  0x2b,
  0x65,
  0x6e,
  0x04,
  0x22,
  0x04,
  0x20,
);

export interface X25519KeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

function wrapPkcs8(prefix: Uint8Array, raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix, 0);
  out.set(raw, prefix.length);
  return out;
}

export async function generateX25519KeyPair(): Promise<X25519KeyPair> {
  const generated = (await getSubtle().generateKey({ name: 'X25519' }, false, [
    'deriveBits',
  ])) as CryptoKeyPair;
  return {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    publicKeyBytes: await exportX25519PublicKey(generated.publicKey),
  };
}

export async function importX25519PrivateKey(raw: Uint8Array): Promise<CryptoKey> {
  assertBytesLength(raw, KEY_BYTES, 'X25519 private key');
  const pkcs8 = wrapPkcs8(X25519_PKCS8_PREFIX, raw);
  try {
    return await getSubtle().importKey('pkcs8', bufferSource(pkcs8), { name: 'X25519' }, false, [
      'deriveBits',
    ]);
  } catch {
    throw new E2eeError('INVALID_KEY', 'X25519 private key is not importable');
  } finally {
    zeroBytes(pkcs8);
  }
}

export async function importX25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  assertBytesLength(raw, KEY_BYTES, 'X25519 public key');
  try {
    return await getSubtle().importKey('raw', bufferSource(raw), { name: 'X25519' }, true, []);
  } catch {
    throw new E2eeError('INVALID_KEY', 'X25519 public key is not importable');
  }
}

export async function exportX25519PublicKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await getSubtle().exportKey('raw', key);
  return exportedRawKeyBytes(raw, 'X25519 public key');
}

/**
 * Imports a raw X25519 private seed and returns a non-extractable key pair.
 * Used by KATs and by device provisioning from a seed; normal device setup
 * should call `generateX25519KeyPair()` instead.
 */
export async function x25519KeyPairFromPrivate(raw: Uint8Array): Promise<X25519KeyPair> {
  assertBytesLength(raw, KEY_BYTES, 'X25519 private key');
  const subtle = getSubtle();
  const pkcs8 = wrapPkcs8(X25519_PKCS8_PREFIX, raw);
  try {
    const extractable = await subtle.importKey(
      'pkcs8',
      bufferSource(pkcs8),
      { name: 'X25519' },
      true,
      ['deriveBits'],
    );
    const jwk = (await subtle.exportKey('jwk', extractable)) as JsonWebKey;
    if (typeof jwk.x !== 'string') {
      throw new E2eeError('INVALID_KEY', 'X25519 public key is missing from the private key');
    }
    const publicKeyBytes = decodeBase64Url(jwk.x, KEY_BYTES);
    const privateKey = await subtle.importKey(
      'pkcs8',
      bufferSource(pkcs8),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    );
    return {
      privateKey,
      publicKey: await importX25519PublicKey(publicKeyBytes),
      publicKeyBytes,
    };
  } catch (error) {
    if (isE2eeError(error)) throw error;
    throw new E2eeError('INVALID_KEY', 'X25519 private key is not importable');
  } finally {
    zeroBytes(pkcs8);
  }
}

export async function x25519PublicKeyBytesFromPrivate(raw: Uint8Array): Promise<Uint8Array> {
  return (await x25519KeyPairFromPrivate(raw)).publicKeyBytes;
}

/** DH output; an all-zero result is rejected (low-order/contributory check). */
export async function x25519SharedSecret(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
): Promise<Uint8Array> {
  const bits = await getSubtle().deriveBits(
    { name: 'X25519', public: peerPublicKey },
    privateKey,
    256,
  );
  const secret = new Uint8Array(bits);
  if (secret.every((byte) => byte === 0)) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'X25519 produced an all-zero shared secret');
  }
  return secret;
}

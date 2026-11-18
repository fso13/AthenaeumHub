/**
 * Ed25519 signatures through WebCrypto (§2.3, §2.4).
 *
 * Private keys are always non-extractable. A raw 32-byte seed is imported via
 * a temporary extractable PKCS#8 wrapper to read the public key from the JWK,
 * then re-imported non-extractable; the wrapper buffer is zeroed afterwards.
 */
import { KEY_BYTES, SIGNATURE_BYTES } from '../constants';
import { E2eeError, isE2eeError } from '../errors';
import { assertBytesLength, zeroBytes } from '../encoding/bytes';
import { decodeBase64Url } from '../encoding/base64url';
import { bufferSource } from './bufferSource';
import { wrapEd25519Pkcs8 } from './ed25519Pkcs8';
import { exportedRawKeyBytes } from './rawKeyBytes';
import { getSubtle } from './support';

export interface Ed25519KeyPair {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicKeyBytes: Uint8Array;
}

export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const generated = (await getSubtle().generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  return {
    privateKey: generated.privateKey,
    publicKey: generated.publicKey,
    publicKeyBytes: await exportEd25519PublicKey(generated.publicKey),
  };
}

export async function ed25519KeyPairFromSeed(seed: Uint8Array): Promise<Ed25519KeyPair> {
  assertBytesLength(seed, KEY_BYTES, 'Ed25519 seed');
  const subtle = getSubtle();
  const pkcs8 = wrapEd25519Pkcs8(seed);
  try {
    const extractable = await subtle.importKey(
      'pkcs8',
      bufferSource(pkcs8),
      { name: 'Ed25519' },
      true,
      ['sign'],
    );
    const jwk = (await subtle.exportKey('jwk', extractable)) as JsonWebKey;
    if (typeof jwk.x !== 'string') {
      throw new E2eeError('INVALID_KEY', 'Ed25519 public key is missing from the private key');
    }
    const publicKeyBytes = decodeBase64Url(jwk.x, KEY_BYTES);
    const privateKey = await subtle.importKey(
      'pkcs8',
      bufferSource(pkcs8),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    return {
      privateKey,
      publicKey: await importEd25519PublicKey(publicKeyBytes),
      publicKeyBytes,
    };
  } catch (error) {
    if (isE2eeError(error)) throw error;
    throw new E2eeError('INVALID_KEY', 'Ed25519 seed is not importable');
  } finally {
    zeroBytes(pkcs8);
  }
}

export async function importEd25519PrivateKey(seed: Uint8Array): Promise<CryptoKey> {
  assertBytesLength(seed, KEY_BYTES, 'Ed25519 seed');
  const pkcs8 = wrapEd25519Pkcs8(seed);
  try {
    return await getSubtle().importKey('pkcs8', bufferSource(pkcs8), { name: 'Ed25519' }, false, [
      'sign',
    ]);
  } catch {
    throw new E2eeError('INVALID_KEY', 'Ed25519 seed is not importable');
  } finally {
    zeroBytes(pkcs8);
  }
}

export async function importEd25519PublicKey(raw: Uint8Array): Promise<CryptoKey> {
  assertBytesLength(raw, KEY_BYTES, 'Ed25519 public key');
  try {
    return await getSubtle().importKey('raw', bufferSource(raw), { name: 'Ed25519' }, true, [
      'verify',
    ]);
  } catch {
    throw new E2eeError('INVALID_KEY', 'Ed25519 public key is not importable');
  }
}

export async function exportEd25519PublicKey(key: CryptoKey): Promise<Uint8Array> {
  const raw = await getSubtle().exportKey('raw', key);
  return exportedRawKeyBytes(raw, 'Ed25519 public key');
}

export async function ed25519Sign(privateKey: CryptoKey, message: Uint8Array): Promise<Uint8Array> {
  const signature = await getSubtle().sign({ name: 'Ed25519' }, privateKey, bufferSource(message));
  return new Uint8Array(signature);
}

export async function ed25519Verify(
  publicKey: CryptoKey | Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  if (signature.length !== SIGNATURE_BYTES) return false;
  try {
    const key =
      publicKey instanceof Uint8Array ? await importEd25519PublicKey(publicKey) : publicKey;
    return await getSubtle().verify(
      { name: 'Ed25519' },
      key,
      bufferSource(signature),
      bufferSource(message),
    );
  } catch {
    return false;
  }
}

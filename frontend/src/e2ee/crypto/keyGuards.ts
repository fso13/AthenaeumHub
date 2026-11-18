/**
 * Guards that keep private key material non-extractable (§2.3, §2.4).
 * Storage and future session code call these before persisting a key.
 */
import { E2eeError } from '../errors';

export function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

export function assertPrivateKey(key: unknown, label = 'private key'): CryptoKey {
  if (!isCryptoKey(key)) {
    throw new E2eeError('INVALID_KEY', `${label} must be a CryptoKey`);
  }
  if (key.type !== 'private') {
    throw new E2eeError('INVALID_KEY', `${label} must be a private CryptoKey`);
  }
  if (key.extractable) {
    throw new E2eeError('INVALID_KEY', `${label} must be non-extractable`);
  }
  return key;
}

export function assertPublicKey(key: unknown, label = 'public key'): CryptoKey {
  if (!isCryptoKey(key)) {
    throw new E2eeError('INVALID_KEY', `${label} must be a CryptoKey`);
  }
  if (key.type !== 'public') {
    throw new E2eeError('INVALID_KEY', `${label} must be a public CryptoKey`);
  }
  return key;
}

/**
 * `K_storage` is a non-extractable AES-GCM `CryptoKey` of type `secret`
 * (§2.3). It is not a private key, but the same non-extractability rule holds:
 * raw bytes must never be exportable from JS again.
 */
export function assertSecretKey(key: unknown, label = 'secret key'): CryptoKey {
  if (!isCryptoKey(key)) {
    throw new E2eeError('INVALID_KEY', `${label} must be a CryptoKey`);
  }
  if (key.type !== 'secret') {
    throw new E2eeError('INVALID_KEY', `${label} must be a secret CryptoKey`);
  }
  if (key.extractable) {
    throw new E2eeError('INVALID_KEY', `${label} must be non-extractable`);
  }
  return key;
}

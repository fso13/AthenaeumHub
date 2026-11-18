/** AES-256-GCM with a 128-bit tag (§1.5, §3.5.2). */
import { AES_GCM_NONCE_BYTES, AES_GCM_TAG_BYTES, KEY_BYTES } from '../constants';
import { E2eeError } from '../errors';
import { assertBytesLength } from '../encoding/bytes';
import { bufferSource } from './bufferSource';
import { getSubtle } from './support';

export async function aesGcmEncrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertBytesLength(key, KEY_BYTES, 'AES-256-GCM key');
  assertBytesLength(nonce, AES_GCM_NONCE_BYTES, 'AES-GCM nonce');
  const subtle = getSubtle();
  const cryptoKey = await subtle.importKey('raw', bufferSource(key), 'AES-GCM', false, ['encrypt']);
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: bufferSource(aad), tagLength: 128 },
    cryptoKey,
    bufferSource(plaintext),
  );
  return new Uint8Array(ciphertext);
}

/**
 * AEAD decrypt. Any failure (bad tag, truncated ciphertext, wrong key) is the
 * protocol's `DECRYPT_FAILED`; callers must not leak tag details to the UI.
 */
export async function aesGcmDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertBytesLength(key, KEY_BYTES, 'AES-256-GCM key');
  assertBytesLength(nonce, AES_GCM_NONCE_BYTES, 'AES-GCM nonce');
  if (ciphertext.length < AES_GCM_TAG_BYTES) {
    throw new E2eeError('DECRYPT_FAILED', 'AEAD ciphertext is shorter than the tag');
  }
  const subtle = getSubtle();
  try {
    const cryptoKey = await subtle.importKey('raw', bufferSource(key), 'AES-GCM', false, [
      'decrypt',
    ]);
    const plaintext = await subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(nonce),
        additionalData: bufferSource(aad),
        tagLength: 128,
      },
      cryptoKey,
      bufferSource(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new E2eeError('DECRYPT_FAILED', 'AEAD authentication failed');
  }
}

/**
 * AES-GCM with a long-lived non-extractable `CryptoKey` (K_storage, §2.3).
 * Unlike the raw-byte helpers above, this never imports/extracts key material
 * per record.
 */
export async function aesGcmEncryptWithKey(
  key: CryptoKey,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertBytesLength(nonce, AES_GCM_NONCE_BYTES, 'AES-GCM nonce');
  if (key.type !== 'secret' || key.extractable) {
    throw new E2eeError('INVALID_KEY', 'storage key must be a non-extractable secret key');
  }
  const ciphertext = await getSubtle().encrypt(
    { name: 'AES-GCM', iv: bufferSource(nonce), additionalData: bufferSource(aad), tagLength: 128 },
    key,
    bufferSource(plaintext),
  );
  return new Uint8Array(ciphertext);
}

export async function aesGcmDecryptWithKey(
  key: CryptoKey,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  assertBytesLength(nonce, AES_GCM_NONCE_BYTES, 'AES-GCM nonce');
  if (key.type !== 'secret' || key.extractable) {
    throw new E2eeError('INVALID_KEY', 'storage key must be a non-extractable secret key');
  }
  if (ciphertext.length < AES_GCM_TAG_BYTES) {
    throw new E2eeError('DECRYPT_FAILED', 'AEAD ciphertext is shorter than the tag');
  }
  try {
    const plaintext = await getSubtle().decrypt(
      {
        name: 'AES-GCM',
        iv: bufferSource(nonce),
        additionalData: bufferSource(aad),
        tagLength: 128,
      },
      key,
      bufferSource(ciphertext),
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new E2eeError('DECRYPT_FAILED', 'AEAD authentication failed');
  }
}

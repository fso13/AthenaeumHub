/** HKDF-SHA-256 (RFC 5869) through WebCrypto (§1.5, §3.3, §3.4.1). */
import { E2eeError, invalid } from '../errors';
import { bufferSource } from './bufferSource';
import { getSubtle } from './support';

const MAX_OUTPUT_BYTES = 255 * 32;

/**
 * @param ikm  input keying material
 * @param salt HKDF salt (may be empty; the protocol uses 0×32 or `RK`)
 * @param info HKDF info (a protocol domain prefix)
 * @param length output length in bytes
 */
export async function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  if (!Number.isInteger(length) || length <= 0 || length > MAX_OUTPUT_BYTES) {
    throw invalid('INVALID_KEY', `HKDF output length must be 1..${MAX_OUTPUT_BYTES} bytes`);
  }
  const subtle = getSubtle();
  let key: CryptoKey;
  try {
    key = await subtle.importKey('raw', bufferSource(ikm), 'HKDF', false, ['deriveBits']);
  } catch {
    throw new E2eeError('INVALID_KEY', 'HKDF input keying material is not importable');
  }
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: bufferSource(salt), info: bufferSource(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

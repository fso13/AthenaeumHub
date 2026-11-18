/** SHA-256/SHA-512 and HMAC-SHA-256 through WebCrypto (§2.4). */
import { E2eeError } from '../errors';
import { bufferSource } from './bufferSource';
import { getSubtle } from './support';

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await getSubtle().digest('SHA-256', bufferSource(data));
  return new Uint8Array(digest);
}

export async function sha512(data: Uint8Array): Promise<Uint8Array> {
  const digest = await getSubtle().digest('SHA-512', bufferSource(data));
  return new Uint8Array(digest);
}

/** HMAC-SHA-256 with a raw key; used by KDF_CK (§3.4.1). */
export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (key.length === 0) {
    throw new E2eeError('INVALID_KEY', 'HMAC key must not be empty');
  }
  const subtle = getSubtle();
  const cryptoKey = await subtle.importKey(
    'raw',
    bufferSource(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await subtle.sign({ name: 'HMAC' }, cryptoKey, bufferSource(data));
  return new Uint8Array(signature);
}

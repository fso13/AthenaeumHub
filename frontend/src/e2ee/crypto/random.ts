/** CSPRNG wrapper (`crypto.getRandomValues`); no non-cryptographic PRNG (§2.4). */
import { E2eeError, invalid } from '../errors';
import { getCryptoApi } from './support';

const MAX_REQUEST_BYTES = 65536;

export function randomBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1 || length > MAX_REQUEST_BYTES) {
    throw invalid('INVALID_KEY', `random length must be 1..${MAX_REQUEST_BYTES} bytes`);
  }
  const api = getCryptoApi();
  if (typeof api.getRandomValues !== 'function') {
    throw new E2eeError('E2EE_UNSUPPORTED_BROWSER', 'crypto.getRandomValues is unavailable');
  }
  const bytes = new Uint8Array(length);
  api.getRandomValues(bytes);
  return bytes;
}

/**
 * Canonical unpadded base64url (RFC 4648 §5) as required by §4.7 item 1:
 * alphabet `[A-Za-z0-9_-]`, no `=`, `len % 4 !== 1`, and
 * `decode -> encode` must reproduce the input byte for byte.
 */
import { invalid } from '../errors';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Strict decoder. Non-canonical representations (padding, `+`/`/`, impossible
 * length, non-zero trailing bits, wrong decoded length) are rejected instead of
 * being silently normalised.
 */
export function decodeBase64Url(text: string, expectedBytes?: number): Uint8Array {
  if (typeof text !== 'string') {
    throw invalid('INVALID_ENCODING', 'base64url value must be a string');
  }
  if (!BASE64URL_PATTERN.test(text)) {
    throw invalid('INVALID_ENCODING', 'base64url contains characters outside [A-Za-z0-9_-]');
  }
  if (text.length % 4 === 1) {
    throw invalid('INVALID_ENCODING', 'base64url length cannot be 4n+1');
  }
  const padded =
    text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw invalid('INVALID_ENCODING', 'base64url value is not decodable');
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (encodeBase64Url(bytes) !== text) {
    throw invalid('INVALID_ENCODING', 'base64url value is not canonical');
  }
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw invalid(
      'INVALID_ENCODING',
      `base64url value must decode to exactly ${expectedBytes} bytes`,
    );
  }
  return bytes;
}

export function isCanonicalBase64Url(text: string, expectedBytes?: number): boolean {
  try {
    decodeBase64Url(text, expectedBytes);
    return true;
  } catch {
    return false;
  }
}

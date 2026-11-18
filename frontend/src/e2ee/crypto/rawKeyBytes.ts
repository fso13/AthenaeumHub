/**
 * `SubtleCrypto.exportKey('raw', ...)` returns an `ArrayBuffer` in browsers, but
 * the value can be a cross-realm buffer (jsdom vs Node) or a typed view, so
 * `instanceof ArrayBuffer` is not reliable. Normalise it explicitly.
 */
import { E2eeError } from '../errors';

export function exportedRawKeyBytes(exported: ArrayBuffer | JsonWebKey, label: string): Uint8Array {
  if (ArrayBuffer.isView(exported)) {
    const view = exported as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (typeof exported === 'object' && exported !== null && 'byteLength' in exported) {
    return new Uint8Array(exported as ArrayBuffer);
  }
  throw new E2eeError('INVALID_KEY', `${label} must export as raw bytes`);
}

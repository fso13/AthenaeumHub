/**
 * Narrow cast for WebCrypto calls.
 *
 * TypeScript 5.9 models `Uint8Array` as `Uint8Array<ArrayBufferLike>`, while
 * `SubtleCrypto` only accepts `ArrayBufferView<ArrayBuffer>`. Every buffer in
 * this package is allocated by us and is never SharedArrayBuffer-backed, so the
 * cast is sound; it exists only to bridge the DOM typings.
 */
export function bufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

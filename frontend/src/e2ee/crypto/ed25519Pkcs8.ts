/**
 * RFC 8410 PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
 *
 * Kept in its own module so the production key loader and the runtime
 * known-answer probe share exactly one DER prefix (no duplicated crypto
 * constants). The wrapper buffer is zeroed by the caller.
 */

/** DER prefix for a raw 32-byte Ed25519 seed (RFC 8410). */
export const ED25519_PKCS8_PREFIX = Uint8Array.of(
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
  0x70,
  0x04,
  0x22,
  0x04,
  0x20,
);

export function wrapEd25519Pkcs8(raw: Uint8Array): Uint8Array {
  const out = new Uint8Array(ED25519_PKCS8_PREFIX.length + raw.length);
  out.set(ED25519_PKCS8_PREFIX, 0);
  out.set(raw, ED25519_PKCS8_PREFIX.length);
  return out;
}

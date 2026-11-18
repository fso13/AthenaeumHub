/**
 * Byte-level helpers shared by the E2EE codecs.
 *
 * Everything here is strict and canonical: a malformed hex/UUID must fail with
 * a typed `E2eeError`, never be coerced into a "close enough" value.
 */
import { E2eeError, invalid } from '../errors';

const HEX_PATTERN = /^[0-9a-f]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const textEncoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  // `TextEncoder#encode` may return a `Uint8Array` from another realm (Node vs
  // jsdom/vitest); copy into this realm so `instanceof Uint8Array` guards stay
  // meaningful for every codec.
  return new Uint8Array(textEncoder.encode(text));
}

export function fromUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalid('INVALID_ENCODING', 'bytes are not valid UTF-8');
  }
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function zeros(length: number): Uint8Array {
  return new Uint8Array(length);
}

export function copyBytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

/** Best-effort zeroization of raw buffers (JS cannot promise a secure wipe). */
export function zeroBytes(...buffers: readonly Uint8Array[]): void {
  for (const buffer of buffers) buffer.fill(0);
}

export function areBytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return diff === 0;
}

/** Lexicographic comparison of unsigned bytes; used for safety-number sorting. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  if (a.length === b.length) return 0;
  return a.length < b.length ? -1 : 1;
}

export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_PATTERN.test(hex)) {
    throw invalid('INVALID_ENCODING', 'hex must be lowercase, even-length and unprefixed');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function requireUint(value: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new E2eeError('INVALID_ENCODING', `${label} is out of range`);
  }
  return value;
}

export function u8(value: number): Uint8Array {
  return Uint8Array.of(requireUint(value, 0xff, 'u8'));
}

export function u16be(value: number): Uint8Array {
  const v = requireUint(value, 0xffff, 'u16');
  return Uint8Array.of((v >>> 8) & 0xff, v & 0xff);
}

export function u32be(value: number): Uint8Array {
  const v = requireUint(value, 0xffffffff, 'u32');
  return Uint8Array.of((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
}

export function readU16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

export function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function uuidToBytes(uuid: string): Uint8Array {
  if (!isUuid(uuid)) {
    throw invalid('INVALID_ENCODING', 'value is not a canonical lowercase UUID');
  }
  const hex = uuid.replace(/-/g, '');
  return hexToBytes(hex);
}

export function assertBytesLength(bytes: Uint8Array, expected: number, label: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== expected) {
    throw invalid('INVALID_KEY', `${label} must be exactly ${expected} bytes`);
  }
  return bytes;
}

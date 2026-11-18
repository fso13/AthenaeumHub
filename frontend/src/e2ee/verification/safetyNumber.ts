/**
 * Per-device-pair safety number and QR payload (§7.2, §7.3).
 *
 * `entry = user_id(16) || device_id(16) || fingerprint(32)` (64 bytes); the two
 * entries are sorted lexicographically by bytes so both sides see the same
 * digits. `digest = SHA-512(D_SN || u8(1) || u32(2) || entry1 || entry2)`;
 * digits are `decimal(bigint(digest) mod 10^60)` zero-padded to 60.
 */
import { D_SN, KEY_BYTES, UUID_BYTES } from '../constants';
import { sha512 } from '../crypto/digest';
import { encodeBase64Url } from '../encoding/base64url';
import {
  assertBytesLength,
  bytesToHex,
  compareBytes,
  concatBytes,
  u32be,
  u8,
  uuidToBytes,
} from '../encoding/bytes';

export const SAFETY_NUMBER_DIGITS = 60;
const DIGIT_MODULUS = 10n ** BigInt(SAFETY_NUMBER_DIGITS);

export interface SafetyNumberEntry {
  readonly userId: string;
  readonly deviceId: string;
  readonly fingerprint: Uint8Array;
}

export interface SafetyNumber {
  /** Raw SHA-512 digest (64 bytes) — never shown in the UI. */
  readonly digest: Uint8Array;
  /** Exactly 60 decimal characters. */
  readonly digits: string;
  /** 12 groups of 5 digits separated by spaces. */
  readonly display: string;
}

function entryBytes(entry: SafetyNumberEntry): Uint8Array {
  return concatBytes(
    uuidToBytes(entry.userId),
    uuidToBytes(entry.deviceId),
    assertBytesLength(entry.fingerprint, KEY_BYTES, 'fingerprint'),
  );
}

export async function computeSafetyNumber(
  first: SafetyNumberEntry,
  second: SafetyNumberEntry,
): Promise<SafetyNumber> {
  const firstBytes = entryBytes(first);
  const secondBytes = entryBytes(second);
  const [low, high] =
    compareBytes(firstBytes, secondBytes) <= 0
      ? [firstBytes, secondBytes]
      : [secondBytes, firstBytes];
  const digest = await sha512(concatBytes(D_SN, u8(1), u32be(2), low, high));
  const digits = (BigInt(`0x${bytesToHex(digest)}`) % DIGIT_MODULUS)
    .toString()
    .padStart(SAFETY_NUMBER_DIGITS, '0');
  return { digest, digits, display: formatSafetyNumberDigits(digits) };
}

export function formatSafetyNumberDigits(digits: string): string {
  if (!/^\d{60}$/.test(digits)) {
    throw new Error('safety number must be exactly 60 decimal digits');
  }
  const groups: string[] = [];
  for (let offset = 0; offset < SAFETY_NUMBER_DIGITS; offset += 5) {
    groups.push(digits.slice(offset, offset + 5));
  }
  return groups.join(' ');
}

export interface QrDevice {
  readonly deviceId: string;
  readonly fingerprint: Uint8Array;
}

/**
 * `krug://verify/v1?dev1=&fp1=&dev2=&fp2=` with `dev1 < dev2` (stable order).
 * Scanning never sets `verified` by itself; the caller compares both ids and
 * both fingerprints with locally computed values.
 */
export function buildSafetyNumberQrPayload(first: QrDevice, second: QrDevice): string {
  const [low, high] = first.deviceId <= second.deviceId ? [first, second] : [second, first];
  const lowFingerprint = encodeBase64Url(
    assertBytesLength(low.fingerprint, KEY_BYTES, 'fingerprint'),
  );
  const highFingerprint = encodeBase64Url(
    assertBytesLength(high.fingerprint, KEY_BYTES, 'fingerprint'),
  );
  const params = new URLSearchParams({
    dev1: low.deviceId,
    fp1: lowFingerprint,
    dev2: high.deviceId,
    fp2: highFingerprint,
  });
  return `krug://verify/v1?${params.toString()}`;
}

/** A safety number is per device pair; there is no per-user variant (§7.2). */
export function safetyNumberPairKey(deviceIdA: string, deviceIdB: string): string {
  const [low, high] = deviceIdA <= deviceIdB ? [deviceIdA, deviceIdB] : [deviceIdB, deviceIdA];
  return `${low}|${high}`;
}

export const SAFETY_NUMBER_ENTRY_BYTES = UUID_BYTES + UUID_BYTES + KEY_BYTES;

/**
 * Associated Data: the exact 163-byte structure from §3.5.3.
 *
 * AD authenticates chat/device/generation/session, the prekey preamble hash
 * and the ratchet header. It is built from validated field values, never by
 * copying JSON bytes.
 */
import {
  AD_BYTES,
  AD_FLAG_PREKEY,
  D_AD,
  ENVELOPE_VERSION,
  HEADER_BYTES,
  KEY_BYTES,
  MAX_KEY_GENERATION,
  SESSION_ID_BYTES,
  UUID_BYTES,
} from '../constants';
import { invalid } from '../errors';
import { areBytesEqual, concatBytes, readU32be, u32be, u8, zeros } from '../encoding/bytes';
import { type ParsedHeader, decodeHeader, encodeHeader } from './header';

export interface AdFields {
  readonly chatId: Uint8Array;
  readonly senderDeviceId: Uint8Array;
  readonly senderKeyGeneration: number;
  readonly recipientDeviceId: Uint8Array;
  readonly recipientKeyGeneration: number;
  readonly sessionId: Uint8Array;
  /** True for a prekey envelope: flags bit0 = 1, `preambleHash = SHA-256(preamble)`. */
  readonly prekey: boolean;
  /** 32-byte preamble hash for prekey envelopes, 32 zero bytes otherwise. */
  readonly preambleHash: Uint8Array;
  readonly header: ParsedHeader;
}

function assertKeyGeneration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_KEY_GENERATION) {
    throw invalid(
      'INVALID_ENVELOPE_FORMAT',
      `${label} must be an integer in 1..${MAX_KEY_GENERATION}`,
    );
  }
  return value;
}

function assertFixed(bytes: Uint8Array, length: number, label: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `${label} must be ${length} bytes`);
  }
  return bytes;
}

export function buildAd(fields: AdFields): Uint8Array {
  assertFixed(fields.chatId, UUID_BYTES, 'chat_id');
  assertFixed(fields.senderDeviceId, UUID_BYTES, 'sender_device_id');
  assertFixed(fields.recipientDeviceId, UUID_BYTES, 'recipient_device_id');
  assertFixed(fields.sessionId, SESSION_ID_BYTES, 'session_id');
  assertFixed(fields.preambleHash, KEY_BYTES, 'preamble_hash');
  if (!fields.prekey && !areBytesEqual(fields.preambleHash, zeros(KEY_BYTES))) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'non-prekey AD must use an all-zero preamble hash');
  }
  const ad = concatBytes(
    D_AD,
    u8(ENVELOPE_VERSION),
    u8(fields.prekey ? AD_FLAG_PREKEY : 0),
    fields.chatId,
    fields.senderDeviceId,
    u32be(assertKeyGeneration(fields.senderKeyGeneration, 'sender_key_generation')),
    fields.recipientDeviceId,
    u32be(assertKeyGeneration(fields.recipientKeyGeneration, 'recipient_key_generation')),
    fields.sessionId,
    fields.preambleHash,
    encodeHeader(fields.header),
  );
  if (ad.length !== AD_BYTES) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `AD must be ${AD_BYTES} bytes`);
  }
  return ad;
}

export function parseAd(bytes: Uint8Array): AdFields {
  if (bytes.length !== AD_BYTES) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `AD must be exactly ${AD_BYTES} bytes`);
  }
  if (!areBytesEqual(bytes.slice(0, D_AD.length), D_AD)) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'AD domain prefix mismatch');
  }
  if (bytes[D_AD.length] !== ENVELOPE_VERSION) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'AD envelope version must be 1');
  }
  const flags = bytes[D_AD.length + 1] ?? 0;
  if ((flags & ~AD_FLAG_PREKEY) !== 0) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'AD flags contain unknown bits');
  }
  const prekey = (flags & AD_FLAG_PREKEY) !== 0;

  // Offsets are derived from the domain length so the parser cannot silently
  // drift if a future protocol adds a new AD domain.
  let offset = D_AD.length + 2;
  const chatId = bytes.slice(offset, (offset += UUID_BYTES));
  const senderDeviceId = bytes.slice(offset, (offset += UUID_BYTES));
  const senderKeyGeneration = readU32be(bytes, offset);
  offset += 4;
  const recipientDeviceId = bytes.slice(offset, (offset += UUID_BYTES));
  const recipientKeyGeneration = readU32be(bytes, offset);
  offset += 4;
  const sessionId = bytes.slice(offset, (offset += SESSION_ID_BYTES));
  const preambleHash = bytes.slice(offset, (offset += KEY_BYTES));
  const headerBytes = bytes.slice(offset, offset + HEADER_BYTES);
  if (headerBytes.length !== HEADER_BYTES) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'AD header is truncated');
  }
  if (!prekey && !areBytesEqual(preambleHash, zeros(KEY_BYTES))) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'non-prekey AD must use an all-zero preamble hash');
  }
  return {
    chatId,
    senderDeviceId,
    senderKeyGeneration,
    recipientDeviceId,
    recipientKeyGeneration,
    sessionId,
    prekey,
    preambleHash,
    header: decodeHeader(headerBytes),
  };
}

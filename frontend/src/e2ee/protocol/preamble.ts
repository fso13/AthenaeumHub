/**
 * X3DH prekey preamble codec (§3.3.1).
 *
 * The preamble is a binary, fixed-layout structure with variable `spk_id` (L)
 * and `opk_id` (M) lengths; total size is `313 + L + M`. The receiver rebuilds
 * it byte-for-byte from the envelope's `prekey` block and its own identity
 * keys, so parsing must reject any structural drift.
 */
import {
  D_PRE,
  D_PRESIG,
  KEY_BYTES,
  KEY_ID_PATTERN,
  MAX_KEY_ID_CHARS,
  PREAMBLE_FIXED_BYTES,
  SESSION_ID_BYTES,
  UUID_BYTES,
} from '../constants';
import { E2eeError, invalid } from '../errors';
import {
  areBytesEqual,
  concatBytes,
  fromUtf8,
  readU16be,
  u16be,
  u8,
  utf8,
  zeros,
} from '../encoding/bytes';
import { ed25519Sign, ed25519Verify } from '../crypto/ed25519';

export interface PreambleFields {
  readonly chatId: Uint8Array;
  readonly senderDeviceId: Uint8Array;
  readonly recipientDeviceId: Uint8Array;
  readonly senderIdentitySigningKey: Uint8Array;
  readonly senderIdentityDhKey: Uint8Array;
  readonly senderEphemeralKey: Uint8Array;
  readonly recipientIdentityDhKey: Uint8Array;
  readonly recipientIdentitySigningKey: Uint8Array;
  readonly spkId: string;
  readonly spkPublic: Uint8Array;
  readonly opkId: string | null;
  readonly opkPublic: Uint8Array | null;
  readonly sessionId: Uint8Array;
}

function assertField(bytes: Uint8Array, length: number, label: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw invalid('INVALID_PREAMBLE', `${label} must be ${length} bytes`);
  }
  return bytes;
}

function assertKeyId(keyId: string, label: string): string {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw invalid('INVALID_PREAMBLE', `${label} must match ${KEY_ID_PATTERN.source}`);
  }
  return keyId;
}

export function buildPreamble(fields: PreambleFields): Uint8Array {
  assertField(fields.chatId, UUID_BYTES, 'chat_id');
  assertField(fields.senderDeviceId, UUID_BYTES, 'sender_device_id');
  assertField(fields.recipientDeviceId, UUID_BYTES, 'recipient_device_id');
  assertField(fields.senderIdentitySigningKey, KEY_BYTES, 'sender_ik_sig');
  assertField(fields.senderIdentityDhKey, KEY_BYTES, 'sender_ik_dh');
  assertField(fields.senderEphemeralKey, KEY_BYTES, 'sender_ek');
  assertField(fields.recipientIdentityDhKey, KEY_BYTES, 'recipient_ik_dh');
  assertField(fields.recipientIdentitySigningKey, KEY_BYTES, 'recipient_ik_sig');
  assertField(fields.spkPublic, KEY_BYTES, 'recipient_spk_pub');
  assertField(fields.sessionId, SESSION_ID_BYTES, 'session_id');
  assertKeyId(fields.spkId, 'spk_id');

  const spkIdBytes = utf8(fields.spkId);
  let opkPart: Uint8Array;
  if (fields.opkPublic === null) {
    if (fields.opkId !== null) {
      throw invalid('INVALID_PREAMBLE', 'opk_id must be null when opk_public is null');
    }
    opkPart = concatBytes(u8(0), u16be(0), zeros(KEY_BYTES));
  } else {
    if (fields.opkId === null) {
      throw invalid('INVALID_PREAMBLE', 'opk_id is required when opk_public is present');
    }
    assertField(fields.opkPublic, KEY_BYTES, 'recipient_opk_pub');
    const opkIdBytes = utf8(assertKeyId(fields.opkId, 'opk_id'));
    opkPart = concatBytes(u8(1), u16be(opkIdBytes.length), opkIdBytes, fields.opkPublic);
  }

  return concatBytes(
    D_PRE,
    u8(1),
    fields.chatId,
    fields.senderDeviceId,
    fields.recipientDeviceId,
    fields.senderIdentitySigningKey,
    fields.senderIdentityDhKey,
    fields.senderEphemeralKey,
    fields.recipientIdentityDhKey,
    fields.recipientIdentitySigningKey,
    u16be(spkIdBytes.length),
    spkIdBytes,
    fields.spkPublic,
    opkPart,
    fields.sessionId,
  );
}

export function parsePreamble(bytes: Uint8Array): PreambleFields {
  if (!(bytes instanceof Uint8Array) || bytes.length < PREAMBLE_FIXED_BYTES) {
    throw invalid('INVALID_PREAMBLE', `preamble must be at least ${PREAMBLE_FIXED_BYTES} bytes`);
  }
  if (!areBytesEqual(bytes.subarray(0, D_PRE.length), D_PRE)) {
    throw invalid('INVALID_PREAMBLE', 'preamble domain prefix mismatch');
  }
  let offset = D_PRE.length;
  if (bytes[offset] !== 1) {
    throw invalid('INVALID_PREAMBLE', 'unsupported preamble version');
  }
  offset += 1;

  const take = (length: number, label: string): Uint8Array => {
    if (offset + length > bytes.length) {
      throw invalid('INVALID_PREAMBLE', `preamble is truncated at ${label}`);
    }
    const value = bytes.slice(offset, offset + length);
    offset += length;
    return value;
  };

  const chatId = take(UUID_BYTES, 'chat_id');
  const senderDeviceId = take(UUID_BYTES, 'sender_device_id');
  const recipientDeviceId = take(UUID_BYTES, 'recipient_device_id');
  const senderIdentitySigningKey = take(KEY_BYTES, 'sender_ik_sig');
  const senderIdentityDhKey = take(KEY_BYTES, 'sender_ik_dh');
  const senderEphemeralKey = take(KEY_BYTES, 'sender_ek');
  const recipientIdentityDhKey = take(KEY_BYTES, 'recipient_ik_dh');
  const recipientIdentitySigningKey = take(KEY_BYTES, 'recipient_ik_sig');

  const readKeyId = (label: string, allowEmpty: boolean): string => {
    if (offset + 2 > bytes.length)
      throw invalid('INVALID_PREAMBLE', `preamble is truncated at ${label}`);
    const length = readU16be(bytes, offset);
    offset += 2;
    const limit = allowEmpty ? 0 : 1;
    if (length < limit || length > MAX_KEY_ID_CHARS) {
      throw invalid('INVALID_PREAMBLE', `${label} length must be ${limit}..${MAX_KEY_ID_CHARS}`);
    }
    const raw = take(length, label);
    if (length === 0) return '';
    let value: string;
    try {
      value = fromUtf8(raw);
    } catch {
      throw new E2eeError('INVALID_PREAMBLE', `${label} is not valid UTF-8`);
    }
    return assertKeyId(value, label);
  };

  const spkId = readKeyId('spk_id', false);
  const spkPublic = take(KEY_BYTES, 'recipient_spk_pub');

  const opkPresent = bytes[offset];
  offset += 1;
  if (opkPresent !== 0 && opkPresent !== 1) {
    throw invalid('INVALID_PREAMBLE', 'opk_present must be 0 or 1');
  }
  const opkId = readKeyId('opk_id', opkPresent === 0);
  const opkPublic = take(KEY_BYTES, 'recipient_opk_pub');
  if (opkPresent === 0) {
    if (opkId !== '') {
      throw invalid('INVALID_PREAMBLE', 'opk_id must be empty when opk_present is 0');
    }
    if (!areBytesEqual(opkPublic, zeros(KEY_BYTES))) {
      throw invalid('INVALID_PREAMBLE', 'opk_public must be all-zero when opk_present is 0');
    }
  } else if (opkId === '') {
    throw invalid('INVALID_PREAMBLE', 'opk_id is required when opk_present is 1');
  }

  const sessionId = take(SESSION_ID_BYTES, 'session_id');
  if (offset !== bytes.length) {
    throw invalid('INVALID_PREAMBLE', 'preamble has trailing bytes');
  }

  return {
    chatId,
    senderDeviceId,
    recipientDeviceId,
    senderIdentitySigningKey,
    senderIdentityDhKey,
    senderEphemeralKey,
    recipientIdentityDhKey,
    recipientIdentitySigningKey,
    spkId,
    spkPublic,
    opkId: opkPresent === 0 ? null : opkId,
    opkPublic: opkPresent === 0 ? null : opkPublic,
    sessionId,
  };
}

/** Message actually signed by `IK_sig`: `D_PRESIG || preamble` (§3.3.1). */
export function preambleSignatureMessage(preamble: Uint8Array): Uint8Array {
  return concatBytes(D_PRESIG, preamble);
}

export async function signPreamble(
  identitySigningPrivateKey: CryptoKey,
  preamble: Uint8Array,
): Promise<Uint8Array> {
  return ed25519Sign(identitySigningPrivateKey, preambleSignatureMessage(preamble));
}

export async function verifyPreambleSignature(
  identitySigningPublicKey: CryptoKey | Uint8Array,
  preamble: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return ed25519Verify(identitySigningPublicKey, preambleSignatureMessage(preamble), signature);
}

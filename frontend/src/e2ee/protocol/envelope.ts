/**
 * Envelope wire codec (§4.1, §4.7).
 *
 * Canonical b64u, exact field sets, exact byte lengths, number ranges and the
 * canonical ciphertext acceptance bounds. `parseEnvelope` returns decoded
 * bytes; `encodeEnvelope`/`serializeEnvelope` reproduce the normative JSON
 * byte for byte (field order included) for KAT vectors F1/F2.
 */
import {
  CIPHERTEXT_FORM_GUARD_CHARS,
  CIPHERTEXT_MAX_BYTES,
  CIPHERTEXT_MIN_BYTES,
  ENVELOPE_SCHEME,
  ENVELOPE_VERSION,
  HEADER_VERSION,
  KEY_BYTES,
  KEY_ID_PATTERN,
  MAX_HEADER_COUNTER,
  MAX_KEY_GENERATION,
  MAX_KEY_ID_CHARS,
  SESSION_ID_BYTES,
  SIGNATURE_BYTES,
} from '../constants';
import { E2eeError, invalid } from '../errors';
import { sha256 } from '../crypto/digest';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { uuidToBytes, zeros } from '../encoding/bytes';
import { buildAd } from './ad';
import { encodeHeader } from './header';
import { asRecord, assertExactKeys, readBase64Url, readInt, readString, readUuid } from './guards';
import { buildPreamble } from './preamble';

export interface WireCryptoHeader {
  v: 1;
  dh: string;
  pn: number;
  n: number;
}

export interface WirePrekeyBlock {
  sender_identity_signing_key: string;
  sender_identity_dh_key: string;
  sender_ephemeral_key: string;
  recipient_identity_dh_key: string;
  spk_id: string;
  spk_public: string;
  opk_id?: string | null;
  opk_public?: string | null;
  signature: string;
}

export interface WireEnvelope {
  v: 1;
  scheme: 'PAIRWISE_X3DH_DR';
  chat_id: string;
  sender_device_id: string;
  sender_key_generation: number;
  recipient_device_id: string;
  recipient_key_generation: number;
  session_id: string;
  header: WireCryptoHeader;
  ciphertext: string;
  prekey?: WirePrekeyBlock | null;
}

export interface ParsedPrekeyBlock {
  readonly senderIdentitySigningKey: Uint8Array;
  readonly senderIdentityDhKey: Uint8Array;
  readonly senderEphemeralKey: Uint8Array;
  readonly recipientIdentityDhKey: Uint8Array;
  readonly spkId: string;
  readonly spkPublic: Uint8Array;
  readonly opkId: string | null;
  readonly opkPublic: Uint8Array | null;
  readonly signature: Uint8Array;
}

export interface ParsedEnvelope {
  readonly v: 1;
  readonly scheme: 'PAIRWISE_X3DH_DR';
  readonly chatId: string;
  readonly senderDeviceId: string;
  readonly senderKeyGeneration: number;
  readonly recipientDeviceId: string;
  readonly recipientKeyGeneration: number;
  readonly sessionId: Uint8Array;
  readonly header: {
    readonly v: 1;
    readonly dh: Uint8Array;
    readonly pn: number;
    readonly n: number;
  };
  readonly ciphertext: Uint8Array;
  readonly prekey: ParsedPrekeyBlock | null;
}

const ENVELOPE_KEYS = [
  'v',
  'scheme',
  'chat_id',
  'sender_device_id',
  'sender_key_generation',
  'recipient_device_id',
  'recipient_key_generation',
  'session_id',
  'header',
  'ciphertext',
  'prekey',
] as const;

const ENVELOPE_REQUIRED = ENVELOPE_KEYS.filter((key) => key !== 'prekey');

const HEADER_KEYS = ['v', 'dh', 'pn', 'n'] as const;

const PREKEY_KEYS = [
  'sender_identity_signing_key',
  'sender_identity_dh_key',
  'sender_ephemeral_key',
  'recipient_identity_dh_key',
  'spk_id',
  'spk_public',
  'opk_id',
  'opk_public',
  'signature',
] as const;

const PREKEY_REQUIRED = PREKEY_KEYS.filter((key) => key !== 'opk_id' && key !== 'opk_public');

function uuidBytes(uuid: string, label: string): Uint8Array {
  try {
    return uuidToBytes(uuid);
  } catch {
    throw invalid('INVALID_ENVELOPE_FORMAT', `${label} must be a canonical lowercase UUID`);
  }
}

function assertKeyId(value: string, path: string): string {
  if (!KEY_ID_PATTERN.test(value) || value.length > MAX_KEY_ID_CHARS) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `${path} must match ${KEY_ID_PATTERN.source}`);
  }
  return value;
}

function parseHeader(value: unknown): ParsedEnvelope['header'] {
  const record = asRecord(value, 'envelope.header');
  assertExactKeys(record, 'envelope.header', HEADER_KEYS, HEADER_KEYS);
  if (record.v !== HEADER_VERSION) {
    throw invalid('INVALID_HEADER', 'unsupported header version');
  }
  return {
    v: 1,
    dh: readBase64Url(record, 'dh', 'envelope.header', KEY_BYTES),
    pn: readInt(record, 'pn', 'envelope.header', 0, MAX_HEADER_COUNTER),
    n: readInt(record, 'n', 'envelope.header', 0, MAX_HEADER_COUNTER),
  };
}

function parsePrekey(value: unknown): ParsedPrekeyBlock {
  const record = asRecord(value, 'envelope.prekey');
  assertExactKeys(record, 'envelope.prekey', PREKEY_KEYS, PREKEY_REQUIRED);

  const spkId = assertKeyId(
    readString(record, 'spk_id', 'envelope.prekey', 1, MAX_KEY_ID_CHARS),
    'envelope.prekey.spk_id',
  );

  const opkIdValue = record.opk_id;
  const opkPublicValue = record.opk_public;
  let opkId: string | null = null;
  let opkPublic: Uint8Array | null = null;
  if (opkIdValue === null || opkIdValue === undefined) {
    if (opkPublicValue !== null && opkPublicValue !== undefined) {
      throw invalid(
        'INVALID_ENVELOPE_FORMAT',
        'envelope.prekey.opk_id is required with opk_public',
      );
    }
  } else {
    if (typeof opkIdValue !== 'string') {
      throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.prekey.opk_id must be a string or null');
    }
    opkId = assertKeyId(opkIdValue, 'envelope.prekey.opk_id');
    if (opkPublicValue === null || opkPublicValue === undefined) {
      throw invalid(
        'INVALID_ENVELOPE_FORMAT',
        'envelope.prekey.opk_public is required with opk_id',
      );
    }
    opkPublic = readBase64Url(record, 'opk_public', 'envelope.prekey', KEY_BYTES);
  }

  return {
    senderIdentitySigningKey: readBase64Url(
      record,
      'sender_identity_signing_key',
      'envelope.prekey',
      KEY_BYTES,
    ),
    senderIdentityDhKey: readBase64Url(
      record,
      'sender_identity_dh_key',
      'envelope.prekey',
      KEY_BYTES,
    ),
    senderEphemeralKey: readBase64Url(record, 'sender_ephemeral_key', 'envelope.prekey', KEY_BYTES),
    recipientIdentityDhKey: readBase64Url(
      record,
      'recipient_identity_dh_key',
      'envelope.prekey',
      KEY_BYTES,
    ),
    spkId,
    spkPublic: readBase64Url(record, 'spk_public', 'envelope.prekey', KEY_BYTES),
    opkId,
    opkPublic,
    signature: readBase64Url(record, 'signature', 'envelope.prekey', SIGNATURE_BYTES),
  };
}

export function parseEnvelope(value: unknown): ParsedEnvelope {
  const record = asRecord(value, 'envelope');
  // Version first: a future envelope must fail with UNSUPPORTED_ENVELOPE_VERSION,
  // not with an incidental "unknown field" error.
  const version = record.v;
  if (typeof version === 'number' && version !== ENVELOPE_VERSION) {
    throw new E2eeError(
      'UNSUPPORTED_ENVELOPE_VERSION',
      `unsupported envelope version ${version}; this client only supports v${ENVELOPE_VERSION}`,
    );
  }
  assertExactKeys(record, 'envelope', ENVELOPE_KEYS, ENVELOPE_REQUIRED);
  if (version !== ENVELOPE_VERSION) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.v must be 1');
  }
  if (record.scheme !== ENVELOPE_SCHEME) {
    throw invalid('INVALID_ENVELOPE_FORMAT', `envelope.scheme must be ${ENVELOPE_SCHEME}`);
  }

  const chatId = readUuid(record, 'chat_id', 'envelope');
  const senderDeviceId = readUuid(record, 'sender_device_id', 'envelope');
  const recipientDeviceId = readUuid(record, 'recipient_device_id', 'envelope');
  if (senderDeviceId === recipientDeviceId) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'self-envelopes are forbidden (recipient == sender)');
  }

  const ciphertextText = record.ciphertext;
  if (typeof ciphertextText !== 'string') {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.ciphertext must be a base64url string');
  }
  // Cheap pre-decode form guard; it is not the acceptance limit (P2-11).
  if (ciphertextText.length > CIPHERTEXT_FORM_GUARD_CHARS) {
    throw new E2eeError('ENVELOPE_TOO_LARGE', 'envelope.ciphertext exceeds the 64 KiB form guard');
  }
  let ciphertext: Uint8Array;
  try {
    ciphertext = decodeBase64Url(ciphertextText);
  } catch {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.ciphertext is not canonical base64url');
  }
  if (ciphertext.length < CIPHERTEXT_MIN_BYTES || ciphertext.length > CIPHERTEXT_MAX_BYTES) {
    throw new E2eeError(
      'ENVELOPE_TOO_LARGE',
      `envelope.ciphertext must decode to ${CIPHERTEXT_MIN_BYTES}..${CIPHERTEXT_MAX_BYTES} bytes`,
    );
  }

  return {
    v: 1,
    scheme: ENVELOPE_SCHEME,
    chatId,
    senderDeviceId,
    senderKeyGeneration: readInt(
      record,
      'sender_key_generation',
      'envelope',
      1,
      MAX_KEY_GENERATION,
    ),
    recipientDeviceId,
    recipientKeyGeneration: readInt(
      record,
      'recipient_key_generation',
      'envelope',
      1,
      MAX_KEY_GENERATION,
    ),
    sessionId: readBase64Url(record, 'session_id', 'envelope', SESSION_ID_BYTES),
    header: parseHeader(record.header),
    ciphertext,
    prekey:
      record.prekey === null || record.prekey === undefined ? null : parsePrekey(record.prekey),
  };
}

export function parseEnvelopeJson(text: string): ParsedEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope is not valid JSON');
  }
  return parseEnvelope(value);
}

function assertEnvelopeForEncoding(envelope: ParsedEnvelope): void {
  uuidBytes(envelope.chatId, 'chat_id');
  uuidBytes(envelope.senderDeviceId, 'sender_device_id');
  uuidBytes(envelope.recipientDeviceId, 'recipient_device_id');
  if (envelope.sessionId.length !== SESSION_ID_BYTES) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.session_id must be 16 bytes');
  }
  if (envelope.header.dh.length !== KEY_BYTES) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.header.dh must be 32 bytes');
  }
  if (
    envelope.ciphertext.length < CIPHERTEXT_MIN_BYTES ||
    envelope.ciphertext.length > CIPHERTEXT_MAX_BYTES
  ) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'envelope.ciphertext is outside acceptance bounds');
  }
}

/**
 * Canonical wire object. Field order is normative: F1/F2 compare the JSON text
 * byte for byte, so the order below must not be reordered.
 */
export function encodeEnvelope(envelope: ParsedEnvelope): WireEnvelope {
  assertEnvelopeForEncoding(envelope);
  const wire: WireEnvelope = {
    v: ENVELOPE_VERSION,
    scheme: ENVELOPE_SCHEME,
    chat_id: envelope.chatId,
    sender_device_id: envelope.senderDeviceId,
    sender_key_generation: envelope.senderKeyGeneration,
    recipient_device_id: envelope.recipientDeviceId,
    recipient_key_generation: envelope.recipientKeyGeneration,
    session_id: encodeBase64Url(envelope.sessionId),
    header: {
      v: HEADER_VERSION,
      dh: encodeBase64Url(envelope.header.dh),
      pn: envelope.header.pn,
      n: envelope.header.n,
    },
    ciphertext: encodeBase64Url(envelope.ciphertext),
  };
  if (envelope.prekey) {
    const prekey = envelope.prekey;
    wire.prekey = {
      sender_identity_signing_key: encodeBase64Url(prekey.senderIdentitySigningKey),
      sender_identity_dh_key: encodeBase64Url(prekey.senderIdentityDhKey),
      sender_ephemeral_key: encodeBase64Url(prekey.senderEphemeralKey),
      recipient_identity_dh_key: encodeBase64Url(prekey.recipientIdentityDhKey),
      spk_id: prekey.spkId,
      spk_public: encodeBase64Url(prekey.spkPublic),
      opk_id: prekey.opkId,
      opk_public: prekey.opkPublic === null ? null : encodeBase64Url(prekey.opkPublic),
      signature: encodeBase64Url(prekey.signature),
    };
  }
  return wire;
}

/** Canonical JSON text (no whitespace); byte-identical to vectors F1/F2. */
export function serializeEnvelope(envelope: ParsedEnvelope): string {
  return JSON.stringify(encodeEnvelope(envelope));
}

/**
 * Rebuilds the signed preamble of a prekey envelope. The recipient identity
 * signing key is not on the wire (§3.3.1): the receiver supplies its own.
 */
export function buildEnvelopePreamble(
  envelope: ParsedEnvelope,
  recipientIdentitySigningKey: Uint8Array,
): Uint8Array {
  const prekey = envelope.prekey;
  if (!prekey) {
    throw invalid('INVALID_PREAMBLE', 'envelope has no prekey block');
  }
  return buildPreamble({
    chatId: uuidBytes(envelope.chatId, 'chat_id'),
    senderDeviceId: uuidBytes(envelope.senderDeviceId, 'sender_device_id'),
    recipientDeviceId: uuidBytes(envelope.recipientDeviceId, 'recipient_device_id'),
    senderIdentitySigningKey: prekey.senderIdentitySigningKey,
    senderIdentityDhKey: prekey.senderIdentityDhKey,
    senderEphemeralKey: prekey.senderEphemeralKey,
    recipientIdentityDhKey: prekey.recipientIdentityDhKey,
    recipientIdentitySigningKey,
    spkId: prekey.spkId,
    spkPublic: prekey.spkPublic,
    opkId: prekey.opkId,
    opkPublic: prekey.opkPublic,
    sessionId: envelope.sessionId,
  });
}

/** AD for the envelope; `preamble` is required iff `envelope.prekey` is set. */
export async function buildEnvelopeAd(
  envelope: ParsedEnvelope,
  preamble?: Uint8Array | null,
): Promise<Uint8Array> {
  const prekey = envelope.prekey !== null;
  if (prekey && !preamble) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'prekey envelope requires its preamble to build AD');
  }
  if (!prekey && preamble) {
    throw invalid('INVALID_ENVELOPE_FORMAT', 'non-prekey envelope must not carry a preamble');
  }
  return buildAd({
    chatId: uuidBytes(envelope.chatId, 'chat_id'),
    senderDeviceId: uuidBytes(envelope.senderDeviceId, 'sender_device_id'),
    senderKeyGeneration: envelope.senderKeyGeneration,
    recipientDeviceId: uuidBytes(envelope.recipientDeviceId, 'recipient_device_id'),
    recipientKeyGeneration: envelope.recipientKeyGeneration,
    sessionId: envelope.sessionId,
    prekey,
    preambleHash: preamble ? await sha256(preamble) : zeros(KEY_BYTES),
    header: envelope.header,
  });
}

export function isPrekeyEnvelope(envelope: ParsedEnvelope): boolean {
  return envelope.prekey !== null;
}

/** The 42 header bytes that go into AD, exported for diagnostics/tests. */
export function envelopeHeaderBytes(envelope: ParsedEnvelope): Uint8Array {
  return encodeHeader({
    v: 1,
    dh: envelope.header.dh,
    pn: envelope.header.pn,
    n: envelope.header.n,
  });
}

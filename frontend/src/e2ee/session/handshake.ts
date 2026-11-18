/**
 * X3DH initiator/responder handshake (§3.3, §3.3.1–§3.3.3).
 *
 * Initiator (`createInitiatorSession`) runs the ordered §3.3.2 sequence: SPK and
 * binding are re-verified, a fresh `EK` and a **separate fresh `DHs_A`** are
 * generated, `SK`/`SID` are derived, the prekey preamble is built and signed,
 * and the first receiving/sending chains are initialised.
 *
 * Responder (`establishResponderSession`) runs the §3.3.1 checklist before any
 * session exists: preamble signature, `prekey.sender_identity_*` vs
 * bundle/`auth.devices`/TOFU pin, sender binding, own identity keys, SPK/OPK
 * match, chat/device/session ids, then `SK`/`SID`. It never consumes the OPK —
 * that happens in the atomic commit after a successful AEAD (§3.4.5.1).
 */
import { KEY_BYTES, KEY_ID_PATTERN, MAX_KEY_ID_CHARS, SESSION_ID_BYTES } from '../constants';
import { E2eeError, invalid } from '../errors';
import { areBytesEqual, isUuid, uuidToBytes } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { importX25519PublicKey, generateX25519KeyPair, type X25519KeyPair } from '../crypto/x25519';
import { kdfRootKey } from '../protocol/kdf';
import { buildPreamble, signPreamble, verifyPreambleSignature } from '../protocol/preamble';
import { deriveX3dhSharedSecret, deriveX3dhSharedSecretResponder } from '../protocol/x3dh';
import { verifyIdentityBinding, verifySpkSignature } from '../protocol/signatures';
import {
  buildEnvelopePreamble,
  type ParsedEnvelope,
  type ParsedPrekeyBlock,
} from '../protocol/envelope';
import { x25519SharedSecret } from '../crypto/x25519';
import { verifyIdentityKeyMaterial, verifyPrekeySenderIdentity } from '../device/binding';
import type {
  LoadedDeviceIdentity,
  TofuPinRecord,
  VerifiedClaimedBundle,
  VerifiedDeviceIdentity,
} from '../device/types';
import { assertFreshRatchetKey } from './ratchet';
import type { SessionState } from './types';

/** Local device key material required by the initiator (no private export). */
export interface LocalIdentityKeys {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly signingPrivateKey: CryptoKey;
  readonly dhPrivateKey: CryptoKey;
  readonly identitySigningKey: Uint8Array;
  readonly identityDhKey: Uint8Array;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw invalid('KEY_HANDSHAKE_INVALID', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireKeyId(value: string, label: string): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value) || value.length > MAX_KEY_ID_CHARS) {
    throw invalid('KEY_HANDSHAKE_INVALID', `${label} is not a valid key id`);
  }
  return value;
}

function requireKeyGeneration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 2 ** 31 - 1) {
    throw invalid('KEY_HANDSHAKE_INVALID', `${label} is out of range`);
  }
  return value;
}

async function dh(privateKey: CryptoKey, publicBytes: Uint8Array): Promise<Uint8Array> {
  return x25519SharedSecret(privateKey, await importX25519PublicKey(publicBytes));
}

/** Adapts the stored identity to the key material this module operates on. */
export function localIdentityKeys(identity: LoadedDeviceIdentity): LocalIdentityKeys {
  const record = identity.record;
  if (record.deviceId === null || record.userId === null) {
    throw new E2eeError(
      'DEVICE_NOT_REGISTERED',
      'a registered device (user id + device id) is required to start an E2EE session',
    );
  }
  return {
    userId: requireUuid(record.userId, 'user_id'),
    deviceId: requireUuid(record.deviceId, 'device_id'),
    keyGeneration: requireKeyGeneration(record.keyGeneration, 'key_generation'),
    signingPrivateKey: identity.signingPrivateKey,
    dhPrivateKey: identity.dhPrivateKey,
    identitySigningKey: decodeBase64Url(record.identitySigningKey, KEY_BYTES),
    identityDhKey: decodeBase64Url(record.identityDhKey, KEY_BYTES),
  };
}

export interface InitiatorSessionInput {
  readonly identity: LocalIdentityKeys;
  readonly chatId: string;
  readonly bundle: VerifiedClaimedBundle;
  /** Deterministic KAT inputs only; production calls generate fresh pairs. */
  readonly ephemeralKeyPair?: X25519KeyPair;
  readonly ratchetKeyPair?: X25519KeyPair;
  readonly now?: number;
}

export interface InitiatorSessionResult {
  readonly session: SessionState;
  readonly preamble: Uint8Array;
  /** b64u64 wire form of `Ed25519_sign(IK_sig, D_PRESIG || preamble)`. */
  readonly prekeySignature: Uint8Array;
  readonly prekey: ParsedPrekeyBlock;
  readonly sessionId: Uint8Array;
  readonly otpExhausted: boolean;
}

/**
 * Re-verifies the claim bundle's binding and SPK signature. F3 already did this
 * before the bundle was handed over; doing it again keeps the cryptographic
 * precondition local to session creation (defence against a caller that skips
 * `verifyClaimedBundle`).
 */
async function assertBundleCryptographicallyValid(bundle: VerifiedClaimedBundle): Promise<void> {
  const bindingValid = await verifyIdentityBinding(
    bundle.identity.identitySigningKey,
    bundle.identity.identityDhKey,
    bundle.identity.identitySigningKey,
    bundle.identity.identityBindingSignature,
  );
  if (!bindingValid) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'bundle identity binding signature is invalid');
  }
  let spkPublic: Uint8Array;
  let spkSignature: Uint8Array;
  try {
    spkPublic = decodeBase64Url(bundle.signedPrekey.public_key, KEY_BYTES);
    spkSignature = decodeBase64Url(bundle.signedPrekey.signature, 64);
  } catch {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'bundle signed prekey is not canonical b64u');
  }
  const spkId = requireKeyId(bundle.signedPrekey.key_id, 'signed_prekey.key_id');
  const spkValid = await verifySpkSignature(
    bundle.identity.identitySigningKey,
    spkId,
    spkPublic,
    spkSignature,
  );
  if (!spkValid) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'signed prekey signature is invalid');
  }
  if (bundle.otpExhausted !== (bundle.oneTimePrekey === null)) {
    throw new E2eeError(
      'KEY_HANDSHAKE_INVALID',
      'otp_exhausted does not match the one-time prekey',
    );
  }
}

/** §3.3.2 — initiator A establishes the session and its first sending chain. */
export async function createInitiatorSession(
  input: InitiatorSessionInput,
): Promise<InitiatorSessionResult> {
  const chatId = requireUuid(input.chatId, 'chat_id');
  const bundle = input.bundle;
  const peerUserId = requireUuid(bundle.userId, 'bundle.user_id');
  const peerDeviceId = requireUuid(bundle.deviceId, 'bundle.device_id');
  requireKeyGeneration(bundle.keyGeneration, 'bundle.key_generation');
  if (peerDeviceId === input.identity.deviceId) {
    throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'a device cannot start a session with itself');
  }
  await assertBundleCryptographicallyValid(bundle);

  const spkPublic = decodeBase64Url(bundle.signedPrekey.public_key, KEY_BYTES);
  const spkId = requireKeyId(bundle.signedPrekey.key_id, 'signed_prekey.key_id');
  const opk = bundle.oneTimePrekey;
  const opkPublic = opk === null ? null : opk.publicKey;
  const opkId = opk === null ? null : requireKeyId(opk.keyId, 'one_time_prekey.key_id');
  if (opkPublic !== null && opkPublic.length !== KEY_BYTES) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'one-time prekey must be 32 bytes');
  }

  // §3.3.2 step 5: fresh ephemeral key; step 7: *separate* fresh ratchet pair.
  const ephemeral = input.ephemeralKeyPair ?? (await generateX25519KeyPair());
  const ratchet = input.ratchetKeyPair ?? (await generateX25519KeyPair());
  assertFreshRatchetKey(ratchet.publicKeyBytes, [
    ephemeral.publicKeyBytes,
    input.identity.identityDhKey,
    input.identity.identitySigningKey,
    spkPublic,
    bundle.identity.identityDhKey,
    opkPublic,
  ]);

  const x3dh = await deriveX3dhSharedSecret({
    senderIdentityDhPrivateKey: input.identity.dhPrivateKey,
    senderEphemeralPrivateKey: ephemeral.privateKey,
    recipientIdentityDhPublicKey: await importX25519PublicKey(bundle.identity.identityDhKey),
    recipientSignedPrekeyPublicKey: await importX25519PublicKey(spkPublic),
    recipientOneTimePrekeyPublicKey:
      opkPublic === null ? null : await importX25519PublicKey(opkPublic),
  });

  const sessionId = encodeBase64Url(x3dh.sessionId);
  const preamble = buildPreamble({
    chatId: uuidToBytes(chatId),
    senderDeviceId: uuidToBytes(input.identity.deviceId),
    recipientDeviceId: uuidToBytes(peerDeviceId),
    senderIdentitySigningKey: input.identity.identitySigningKey,
    senderIdentityDhKey: input.identity.identityDhKey,
    senderEphemeralKey: ephemeral.publicKeyBytes,
    recipientIdentityDhKey: bundle.identity.identityDhKey,
    recipientIdentitySigningKey: bundle.identity.identitySigningKey,
    spkId,
    spkPublic,
    opkId,
    opkPublic,
    sessionId: x3dh.sessionId,
  });
  const prekeySignature = await signPreamble(input.identity.signingPrivateKey, preamble);

  // §3.4.2 A: RK = SK, DHr = SPK_B, then the first root step with fresh DHs_A.
  const init = await kdfRootKey(x3dh.sharedSecret, await dh(ratchet.privateKey, spkPublic));
  const now = input.now ?? Date.now();
  const session: SessionState = {
    sessionId,
    deviceId: input.identity.deviceId,
    chatId,
    peerUserId,
    peerDeviceId,
    peerIkSig: bundle.identity.identitySigningKey.slice(),
    peerIkDh: bundle.identity.identityDhKey.slice(),
    rootKey: init.rootKey,
    dhPrivateKey: ratchet.privateKey,
    dhPublicKey: ratchet.publicKeyBytes.slice(),
    dhRemote: spkPublic.slice(),
    chainSend: init.chainKey,
    chainRecv: null,
    ns: 0,
    nr: 0,
    pn: 0,
    spkId,
    initiatedBy: 'local',
    lastReceivedAt: null,
    skipped: [],
    createdAt: now,
    lastUsedAt: now,
    localCopyRef: null,
    revision: 0,
  };

  const prekey: ParsedPrekeyBlock = {
    senderIdentitySigningKey: input.identity.identitySigningKey,
    senderIdentityDhKey: input.identity.identityDhKey,
    senderEphemeralKey: ephemeral.publicKeyBytes,
    recipientIdentityDhKey: bundle.identity.identityDhKey,
    spkId,
    spkPublic,
    opkId,
    opkPublic,
    signature: prekeySignature,
  };

  return {
    session,
    preamble,
    prekeySignature,
    prekey,
    sessionId: x3dh.sessionId,
    otpExhausted: bundle.otpExhausted,
  };
}

/** Responder-side prekey material (§3.3.3 steps 1–2). */
export interface ResponderPrekeyMaterial {
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identityDhPrivateKey: CryptoKey;
  readonly identityDhPublicKey: Uint8Array;
  readonly identitySigningPublicKey: Uint8Array;
  readonly spk: {
    readonly keyId: string;
    readonly publicKey: Uint8Array;
    readonly privateKey: CryptoKey;
  };
  readonly opk: {
    readonly keyId: string;
    readonly publicKey: Uint8Array;
    readonly privateKey: CryptoKey;
  } | null;
}

export interface ResponderSessionInput {
  readonly chatId: string;
  readonly envelope: ParsedEnvelope;
  /** Sender identity verified against the bundle / `GET /chats/{id}/keys`. */
  readonly sender: VerifiedDeviceIdentity;
  readonly material: ResponderPrekeyMaterial;
  /** Local TOFU pin for the sender device (null on first contact). */
  readonly pin: TofuPinRecord | null;
  readonly now?: number;
}

export interface ResponderSessionResult {
  readonly session: SessionState;
  readonly preamble: Uint8Array;
  /** OPK that must be consumed in the same transaction as the session+copy. */
  readonly oneTimePrekeyId: string | null;
  readonly sessionId: Uint8Array;
}

/**
 * §3.3.3 — responder B verifies everything and builds the initial session.
 * The returned session is not persisted and no OPK is consumed yet.
 */
export async function establishResponderSession(
  input: ResponderSessionInput,
): Promise<ResponderSessionResult> {
  const chatId = requireUuid(input.chatId, 'chat_id');
  const envelope = input.envelope;
  const prekey = envelope.prekey;
  if (!prekey) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'responder handshake requires a prekey envelope');
  }
  if (envelope.chatId !== chatId) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope chat_id does not match the chat');
  }
  const material = input.material;
  const sender = input.sender;
  requireUuid(sender.userId, 'sender.user_id');
  requireUuid(sender.deviceId, 'sender.device_id');
  requireKeyGeneration(sender.keyGeneration, 'sender.key_generation');

  if (envelope.senderDeviceId !== sender.deviceId) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope sender_device_id does not match');
  }
  if (envelope.recipientDeviceId !== material.deviceId) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope is addressed to another device');
  }
  if (envelope.recipientKeyGeneration !== material.keyGeneration) {
    throw new E2eeError('KEY_GENERATION_STALE', 'envelope recipient_key_generation is stale');
  }

  // §3.3.1 check 3: re-verify the sender's binding over exactly these keys.
  const verified = await verifyIdentityKeyMaterial(
    sender.identitySigningKey,
    sender.identityDhKey,
    sender.identityBindingSignature,
    'sender',
  );
  if (verified.fingerprintBase64Url !== sender.fingerprintBase64Url) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'sender fingerprint does not match its keys');
  }
  // Checks 1 and 2: preamble signature, then prekey↔bundle↔pin identity equality.
  const preamble = buildEnvelopePreamble(envelope, material.identitySigningPublicKey);
  const signatureValid = await verifyPreambleSignature(
    prekey.senderIdentitySigningKey,
    preamble,
    prekey.signature,
  );
  if (!signatureValid) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'prekey preamble signature is invalid');
  }
  verifyPrekeySenderIdentity(
    envelope,
    {
      userId: sender.userId,
      deviceId: sender.deviceId,
      keyGeneration: sender.keyGeneration,
      identity: sender,
    },
    input.pin,
  );

  // Check 4: our own identity keys.
  if (!areBytesEqual(prekey.recipientIdentityDhKey, material.identityDhPublicKey)) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'recipient identity DH key does not match ours');
  }
  // Check 5: SPK and OPK must be the very keys we stored.
  if (
    prekey.spkId !== material.spk.keyId ||
    !areBytesEqual(prekey.spkPublic, material.spk.publicKey)
  ) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'signed prekey does not match the stored SPK');
  }
  const opk = material.opk;
  if (opk === null) {
    if (prekey.opkId !== null || prekey.opkPublic !== null) {
      throw new E2eeError(
        'KEY_HANDSHAKE_INVALID',
        'envelope uses a one-time prekey we do not have',
      );
    }
  } else if (
    prekey.opkId !== opk.keyId ||
    prekey.opkPublic === null ||
    !areBytesEqual(prekey.opkPublic, opk.publicKey)
  ) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'one-time prekey does not match the stored OPK');
  }

  const x3dh = await deriveX3dhSharedSecretResponder({
    recipientIdentityDhPrivateKey: material.identityDhPrivateKey,
    recipientSignedPrekeyPrivateKey: material.spk.privateKey,
    senderIdentityDhPublicKey: await importX25519PublicKey(prekey.senderIdentityDhKey),
    senderEphemeralPublicKey: await importX25519PublicKey(prekey.senderEphemeralKey),
    recipientOneTimePrekeyPrivateKey: opk === null ? null : opk.privateKey,
  });
  if (!areBytesEqual(x3dh.sessionId, envelope.sessionId)) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'session_id does not match the derived X3DH id');
  }

  const now = input.now ?? Date.now();
  const session: SessionState = {
    sessionId: encodeBase64Url(x3dh.sessionId),
    deviceId: material.deviceId,
    chatId,
    peerUserId: sender.userId,
    peerDeviceId: sender.deviceId,
    peerIkSig: sender.identitySigningKey.slice(),
    peerIkDh: sender.identityDhKey.slice(),
    rootKey: x3dh.sharedSecret,
    dhPrivateKey: material.spk.privateKey,
    dhPublicKey: material.spk.publicKey.slice(),
    dhRemote: null,
    chainSend: null,
    chainRecv: null,
    ns: 0,
    nr: 0,
    pn: 0,
    spkId: material.spk.keyId,
    initiatedBy: 'peer',
    lastReceivedAt: null,
    skipped: [],
    createdAt: now,
    lastUsedAt: now,
    localCopyRef: null,
    revision: 0,
  };
  return {
    session,
    preamble,
    oneTimePrekeyId: opk === null ? null : opk.keyId,
    sessionId: x3dh.sessionId,
  };
}

/**
 * Builds the responder's prekey material from stored records. The private SPK
 * is required until every session created with it is gone (§3.4.2/§3.4.5.1).
 */
export function responderMaterialFromRecords(input: {
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identityDhPrivateKey: CryptoKey;
  readonly identityDhPublicKey: Uint8Array;
  readonly identitySigningPublicKey: Uint8Array;
  readonly spk: {
    readonly keyId: string;
    readonly publicKey: string;
    readonly privateKey: CryptoKey;
  };
  readonly opk: {
    readonly keyId: string;
    readonly publicKey: string;
    readonly privateKey: CryptoKey;
  } | null;
}): ResponderPrekeyMaterial {
  const decodeKey = (value: string, label: string): Uint8Array => {
    try {
      return decodeBase64Url(value, KEY_BYTES);
    } catch {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be canonical b64u32`);
    }
  };
  return {
    deviceId: requireUuid(input.deviceId, 'device_id'),
    keyGeneration: requireKeyGeneration(input.keyGeneration, 'key_generation'),
    identityDhPrivateKey: input.identityDhPrivateKey,
    identityDhPublicKey: input.identityDhPublicKey.slice(),
    identitySigningPublicKey: input.identitySigningPublicKey.slice(),
    spk: {
      keyId: requireKeyId(input.spk.keyId, 'spk_id'),
      publicKey: decodeKey(input.spk.publicKey, 'spk_public'),
      privateKey: input.spk.privateKey,
    },
    opk:
      input.opk === null
        ? null
        : {
            keyId: requireKeyId(input.opk.keyId, 'opk_id'),
            publicKey: decodeKey(input.opk.publicKey, 'opk_public'),
            privateKey: input.opk.privateKey,
          },
  };
}

/** Session-id helper shared by send/receive for canonical b64u16. */
export function encodeSessionId(bytes: Uint8Array): string {
  if (bytes.length !== SESSION_ID_BYTES) {
    throw invalid('KEY_HANDSHAKE_INVALID', `session_id must be ${SESSION_ID_BYTES} bytes`);
  }
  return encodeBase64Url(bytes);
}

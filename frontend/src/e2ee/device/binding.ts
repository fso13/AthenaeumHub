/**
 * Claim/chat-keys verification (§3.1, §3.2, §3.3.1, §6.2.5, §6.2.6).
 *
 * The server checks SPK and binding signatures, but the client must verify them
 * independently: a valid bundle is the only thing a TOFU pin may be based on.
 * `decodePrekeyBundle` is deliberately not trusted to establish trust — it only
 * turns b64u into bytes.
 */
import { KEY_BYTES, KEY_ID_PATTERN, MAX_KEY_ID_CHARS, MAX_KEY_GENERATION } from '../constants';
import { E2eeError } from '../errors';
import { areBytesEqual, isUuid } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { verifyIdentityBinding, verifySpkSignature } from '../protocol/signatures';
import { deviceFingerprint } from '../verification/fingerprint';
import {
  decodePrekeyBundle,
  type DecodedPrekeyBundle,
  type WireChatKeysResponse,
  type WireDeviceKeyInfo,
  type WireKeyClaimRequest,
  type WireKeyClaimResponse,
} from '../api/deviceKeys';
import type { ParsedEnvelope } from '../protocol/envelope';
import type { TofuPinRecord } from './types';
import type {
  DecodedClaimResponse,
  VerifiedClaimedBundle,
  VerifiedDeviceIdentity,
  VerifiedDeviceKeyInfo,
} from './types';

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('INVALID_RESPONSE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireKeyId(value: string, label: string): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value) || value.length > MAX_KEY_ID_CHARS) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', `${label} is not a valid key id`);
  }
  return value;
}

function requireKeyGeneration(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_KEY_GENERATION) {
    throw new E2eeError('INVALID_RESPONSE', `${label} is out of range`);
  }
  return value;
}

function decodeKey(value: string, label: string): Uint8Array {
  try {
    return decodeBase64Url(value, KEY_BYTES);
  } catch {
    throw new E2eeError('INVALID_RESPONSE', `${label} must be canonical b64u32`);
  }
}

function parseDate(value: string | null, label: string): number | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new E2eeError('INVALID_RESPONSE', `${label} is not a valid date-time`);
  }
  return timestamp;
}

export interface VerifyBundleOptions {
  readonly now?: number;
}

/**
 * Verifies `identity_binding_signature` over the claimed identity keys and the
 * SPK signature over `(spk_id, spk_public)`, and recomputes the fingerprint.
 */
type VerifiedKeyMaterial = Omit<VerifiedDeviceIdentity, 'userId' | 'deviceId' | 'keyGeneration'>;

export async function verifyIdentityKeyMaterial(
  identitySigningKey: Uint8Array,
  identityDhKey: Uint8Array,
  identityBindingSignature: Uint8Array,
  label = 'device',
): Promise<VerifiedKeyMaterial> {
  const bindingValid = await verifyIdentityBinding(
    identitySigningKey,
    identityDhKey,
    identitySigningKey,
    identityBindingSignature,
  );
  if (!bindingValid) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', `${label} identity binding signature is invalid`);
  }
  const fingerprint = await deviceFingerprint(identitySigningKey, identityDhKey);
  return {
    identitySigningKey,
    identityDhKey,
    identityBindingSignature,
    fingerprint,
    fingerprintBase64Url: encodeBase64Url(fingerprint),
  };
}

/** Verifies a decoded claim bundle; the returned object is safe to pin. */
export async function verifyClaimedBundle(
  bundle: DecodedPrekeyBundle,
  options: VerifyBundleOptions = {},
): Promise<VerifiedClaimedBundle> {
  const now = options.now ?? Date.now();
  const userId = requireUuid(bundle.userId, 'bundle.user_id');
  const deviceId = requireUuid(bundle.deviceId, 'bundle.device_id');
  const keyGeneration = requireKeyGeneration(bundle.keyGeneration, 'bundle.key_generation');
  const spkId = requireKeyId(bundle.signedPrekey.keyId, 'bundle.signed_prekey.key_id');
  const opkId =
    bundle.oneTimePrekey === null
      ? null
      : requireKeyId(bundle.oneTimePrekey.keyId, 'bundle.one_time_prekey.key_id');

  const identity = await verifyIdentityKeyMaterial(
    bundle.identitySigningKey,
    bundle.identityDhKey,
    bundle.identityBindingSignature,
    'bundle',
  );
  const spkValid = await verifySpkSignature(
    bundle.identitySigningKey,
    spkId,
    bundle.signedPrekey.publicKey,
    bundle.signedPrekey.signature,
  );
  if (!spkValid) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'signed prekey signature is invalid');
  }
  const expiresAt = parseDate(bundle.signedPrekey.expiresAt, 'signed_prekey.expires_at');
  if (expiresAt !== null && expiresAt <= now) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'signed prekey has expired');
  }
  if (bundle.otpExhausted !== (bundle.oneTimePrekey === null)) {
    throw new E2eeError('INVALID_RESPONSE', 'otp_exhausted does not match the one-time prekey');
  }
  return {
    userId,
    deviceId,
    keyGeneration,
    identity: {
      ...identity,
      userId,
      deviceId,
      keyGeneration,
    },
    signedPrekey: {
      key_id: spkId,
      public_key: encodeBase64Url(bundle.signedPrekey.publicKey),
      signature: encodeBase64Url(bundle.signedPrekey.signature),
      ...(bundle.signedPrekey.createdAt === null
        ? {}
        : { created_at: bundle.signedPrekey.createdAt }),
      ...(bundle.signedPrekey.expiresAt === null
        ? {}
        : { expires_at: bundle.signedPrekey.expiresAt }),
    },
    oneTimePrekeyId: opkId,
    oneTimePrekey:
      bundle.oneTimePrekey === null
        ? null
        : { keyId: bundle.oneTimePrekey.keyId, publicKey: bundle.oneTimePrekey.publicKey },
    otpExhausted: bundle.otpExhausted,
  };
}

/** Verifies one `GET /chats/{chatId}/keys` device entry, including fingerprint. */
export async function verifyDeviceKeyInfo(info: WireDeviceKeyInfo): Promise<VerifiedDeviceKeyInfo> {
  const userId = requireUuid(info.user_id, 'device.user_id');
  const deviceId = requireUuid(info.device_id, 'device.device_id');
  const keyGeneration = requireKeyGeneration(info.key_generation, 'device.key_generation');
  const signingKey = decodeKey(info.identity_signing_key, 'device.identity_signing_key');
  const dhKey = decodeKey(info.identity_dh_key, 'device.identity_dh_key');
  let bindingSignature: Uint8Array;
  try {
    bindingSignature = decodeBase64Url(info.identity_binding_signature, 64);
  } catch {
    throw new E2eeError('INVALID_RESPONSE', 'device.identity_binding_signature must be b64u64');
  }
  let serverFingerprint: Uint8Array;
  try {
    serverFingerprint = decodeBase64Url(info.fingerprint, KEY_BYTES);
  } catch {
    throw new E2eeError('INVALID_RESPONSE', 'device.fingerprint must be canonical b64u32');
  }
  const identity = await verifyIdentityKeyMaterial(signingKey, dhKey, bindingSignature, 'device');
  if (!areBytesEqual(identity.fingerprint, serverFingerprint)) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'server fingerprint does not match device keys');
  }
  const verifiedAt = parseVerificationTimestamp(info.verified_at);
  const verificationMethod = parseVerificationMethod(info.verification_method);
  if (info.verified !== undefined && info.verified !== null && typeof info.verified !== 'boolean') {
    throw new E2eeError('INVALID_RESPONSE', 'device.verified must be a boolean or null');
  }
  return {
    userId,
    deviceId,
    keyGeneration,
    identitySigningKey: signingKey,
    identityDhKey: dhKey,
    identityBindingSignature: bindingSignature,
    fingerprint: identity.fingerprint,
    fingerprintBase64Url: identity.fingerprintBase64Url,
    status: info.status,
    isSelf: info.is_self,
    signedPrekeyId: info.signed_prekey_id ?? null,
    // `verified` is read as an attestation only; local trust still comes from
    // the TOFU pin and the safety number (P0-1/P2-1).
    verified: info.verified === true,
    verifiedAt,
    verificationMethod,
  };
}

function parseVerificationTimestamp(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new E2eeError('INVALID_RESPONSE', 'device.verified_at must be an RFC 3339 timestamp');
  }
  return parsed;
}

function parseVerificationMethod(
  value: WireDeviceKeyInfo['verification_method'] | undefined,
): 'QR' | 'MANUAL' | null {
  if (value === undefined || value === null) return null;
  if (value !== 'QR' && value !== 'MANUAL') {
    throw new E2eeError('INVALID_RESPONSE', 'device.verification_method is invalid');
  }
  return value;
}

export interface ValidateClaimOptions {
  readonly now?: number;
}

/**
 * Validates a `POST /keys/claim` response against the request: exactly one
 * outcome per requested device, no duplicates, no unknown devices, and each
 * bundle cryptographically verified.
 */
export async function validateClaimResponse(
  response: WireKeyClaimResponse,
  request: WireKeyClaimRequest,
  options: ValidateClaimOptions = {},
): Promise<DecodedClaimResponse> {
  requireUuid(request.chat_id, 'claim.chat_id');
  if (
    !Array.isArray(request.devices) ||
    request.devices.length < 1 ||
    request.devices.length > 10
  ) {
    throw new E2eeError('INVALID_RESPONSE', 'claim.devices must contain 1..10 devices');
  }
  const requested = new Map<string, { userId: string }>();
  for (const device of request.devices) {
    const deviceId = requireUuid(device.device_id, 'claim.device_id');
    const userId = requireUuid(device.user_id, 'claim.user_id');
    if (requested.has(deviceId)) {
      throw new E2eeError('INVALID_RESPONSE', 'claim request contains a duplicate device');
    }
    requested.set(deviceId, { userId });
  }

  if (!Array.isArray(response.bundles) || !Array.isArray(response.unavailable)) {
    throw new E2eeError('INVALID_RESPONSE', 'claim response arrays are missing');
  }
  const seen = new Set<string>();
  const bundles: VerifiedClaimedBundle[] = [];
  for (const wireBundle of response.bundles) {
    const expected = requested.get(wireBundle.device_id);
    if (!expected) {
      throw new E2eeError('INVALID_RESPONSE', 'claim returned an unrequested device');
    }
    if (seen.has(wireBundle.device_id)) {
      throw new E2eeError('INVALID_RESPONSE', 'claim returned a duplicate device');
    }
    if (wireBundle.user_id !== expected.userId) {
      throw new E2eeError('INVALID_RESPONSE', 'claim bundle user_id does not match the request');
    }
    seen.add(wireBundle.device_id);
    const decoded = decodePrekeyBundle(wireBundle);
    bundles.push(await verifyClaimedBundle(decoded, options));
  }
  const unavailable: string[] = [];
  for (const entry of response.unavailable) {
    if (entry.reason !== 'NO_SPK' && entry.reason !== 'NO_KEYS') {
      throw new E2eeError('INVALID_RESPONSE', 'claim unavailable reason is invalid');
    }
    if (!requested.has(entry.device_id)) {
      throw new E2eeError('INVALID_RESPONSE', 'claim unavailable contains an unrequested device');
    }
    if (seen.has(entry.device_id)) {
      throw new E2eeError(
        'INVALID_RESPONSE',
        'claim returned a device as both bundle and unavailable',
      );
    }
    seen.add(entry.device_id);
    unavailable.push(entry.device_id);
  }
  for (const deviceId of requested.keys()) {
    if (!seen.has(deviceId)) {
      throw new E2eeError('INVALID_RESPONSE', 'claim omitted a requested device');
    }
  }
  return { bundles, unavailable };
}

export interface ValidateChatKeysOptions {
  readonly chatId: string;
  readonly myDeviceId: string;
  readonly localIdentity?: {
    readonly record: {
      readonly deviceId: string | null;
      readonly identitySigningKey: string;
      readonly identityDhKey: string;
      readonly identityBindingSignature: string;
      readonly fingerprint: string;
      readonly keyGeneration: number;
    };
  };
}

/**
 * Validates `GET /chats/{chatId}/keys`: only ACTIVE devices, one self entry
 * matching `my_device_id`, verified binding + recomputed fingerprint for every
 * device. Server `verified` is intentionally ignored: it is per verifier
 * device and never a local trust source (P0-1/P2-1).
 */
export async function validateChatKeysResponse(
  response: WireChatKeysResponse,
  options: ValidateChatKeysOptions,
): Promise<readonly VerifiedDeviceKeyInfo[]> {
  requireUuid(response.chat_id, 'chat_keys.chat_id');
  if (response.chat_id !== options.chatId) {
    throw new E2eeError('INVALID_RESPONSE', 'chat_keys.chat_id does not match the request');
  }
  if (response.security_mode !== 'E2EE') {
    throw new E2eeError('INVALID_RESPONSE', 'chat_keys.security_mode must be E2EE');
  }
  const myDeviceId = requireUuid(response.my_device_id, 'chat_keys.my_device_id');
  const verifierDeviceId = requireUuid(response.verifier_device_id, 'chat_keys.verifier_device_id');
  if (myDeviceId !== verifierDeviceId) {
    throw new E2eeError('INVALID_RESPONSE', 'verifier_device_id must equal my_device_id');
  }
  if (myDeviceId !== options.myDeviceId) {
    throw new E2eeError('INVALID_RESPONSE', 'chat_keys.my_device_id does not match this device');
  }
  if (!Array.isArray(response.devices) || response.devices.length === 0) {
    throw new E2eeError('INVALID_RESPONSE', 'chat_keys.devices must not be empty');
  }
  const seen = new Set<string>();
  const verified: VerifiedDeviceKeyInfo[] = [];
  for (const info of response.devices) {
    if (info.status !== 'ACTIVE') {
      throw new E2eeError('INVALID_RESPONSE', 'chat_keys contains a non-ACTIVE device');
    }
    if (seen.has(info.device_id)) {
      throw new E2eeError('INVALID_RESPONSE', 'chat_keys contains a duplicate device');
    }
    seen.add(info.device_id);
    verified.push(await verifyDeviceKeyInfo(info));
  }
  const self = verified.find((device) => device.deviceId === myDeviceId);
  if (!self || !self.isSelf) {
    throw new E2eeError('INVALID_RESPONSE', 'chat_keys is missing the self device');
  }
  const local = options.localIdentity?.record;
  if (local) {
    if (local.deviceId !== null && local.deviceId !== myDeviceId) {
      throw new E2eeError(
        'INVALID_RESPONSE',
        'chat_keys my_device_id does not match local identity',
      );
    }
    if (
      encodeBase64Url(self.identitySigningKey) !== local.identitySigningKey ||
      encodeBase64Url(self.identityDhKey) !== local.identityDhKey ||
      encodeBase64Url(self.identityBindingSignature) !== local.identityBindingSignature ||
      self.fingerprintBase64Url !== local.fingerprint
    ) {
      throw new E2eeError('KEY_CHANGE_DETECTED', 'self device keys do not match local identity');
    }
    if (self.keyGeneration !== local.keyGeneration) {
      throw new E2eeError('KEY_GENERATION_STALE', 'self device key generation changed');
    }
  }
  return verified;
}

/**
 * P0-2b: prekey sender identity must byte-match the bundle and, when present,
 * the local TOFU pin. A prekey↔bundle mismatch is `KEY_HANDSHAKE_INVALID`; a
 * pin mismatch is `KEY_CHANGE_DETECTED` (§3.3.1 checks 2 and 7).
 */
export interface PrekeySenderIdentitySource {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identity: VerifiedDeviceIdentity;
}

export function verifyPrekeySenderIdentity(
  envelope: ParsedEnvelope,
  bundle: PrekeySenderIdentitySource,
  pin: TofuPinRecord | null = null,
): void {
  const prekey = envelope.prekey;
  if (!prekey) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope has no prekey block');
  }
  if (envelope.senderDeviceId !== bundle.deviceId) {
    throw new E2eeError(
      'KEY_HANDSHAKE_INVALID',
      'prekey sender_device_id does not match the bundle',
    );
  }
  if (
    !areBytesEqual(prekey.senderIdentitySigningKey, bundle.identity.identitySigningKey) ||
    !areBytesEqual(prekey.senderIdentityDhKey, bundle.identity.identityDhKey)
  ) {
    throw new E2eeError(
      'KEY_HANDSHAKE_INVALID',
      'prekey sender identity does not match the bundle',
    );
  }
  if (envelope.senderKeyGeneration !== bundle.keyGeneration) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'prekey sender key_generation does not match');
  }
  if (pin !== null) {
    if (
      encodeBase64Url(prekey.senderIdentitySigningKey) !== pin.identitySigningKey ||
      encodeBase64Url(prekey.senderIdentityDhKey) !== pin.identityDhKey ||
      pin.deviceId !== bundle.deviceId ||
      pin.userId !== bundle.userId
    ) {
      throw new E2eeError(
        'KEY_CHANGE_DETECTED',
        'prekey sender identity does not match the TOFU pin',
      );
    }
    if (pin.keyGeneration !== bundle.keyGeneration) {
      throw new E2eeError(
        'KEY_CHANGE_DETECTED',
        'prekey sender key_generation does not match the pin',
      );
    }
  }
}

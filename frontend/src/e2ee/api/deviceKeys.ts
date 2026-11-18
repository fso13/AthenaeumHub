/**
 * Typed bridge between the generated API contract and the E2EE codec (E7-F1).
 *
 * The contract (`frontend/src/api/schema.d.ts`) already carries every E2EE
 * schema (I-01). This module only type-aliases those wire types and decodes
 * canonical b64u into bytes; it performs **no network calls** and no session
 * or E2E work (F3/F4).
 */
import type { components } from '../../api/schema';
import { E2eeError, invalid } from '../errors';
import { decodeBase64Url } from '../encoding/base64url';
import { isUuid } from '../encoding/bytes';
import { KEY_BYTES, MAX_KEY_GENERATION, SIGNATURE_BYTES } from '../constants';
import {
  type ParsedEnvelope,
  type WireEnvelope,
  encodeEnvelope,
  parseEnvelope,
} from '../protocol/envelope';

export type WireCryptoEnvelope = components['schemas']['CryptoEnvelope'];
export type WireCryptoHeader = components['schemas']['CryptoHeader'];
export type WirePrekeyBlock = components['schemas']['PrekeyBlock'];
export type WireSignedPrekey = components['schemas']['SignedPrekey'];
export type WireOneTimePrekey = components['schemas']['OneTimePrekey'];
export type WirePrekeyBundle = components['schemas']['PrekeyBundle'];
export type WireDeviceRegistration = components['schemas']['DeviceRegistration'];
export type WireSignedPrekeyUpload = components['schemas']['SignedPrekeyUpload'];
export type WirePrekeyUploadResult = components['schemas']['PrekeyUploadResult'];
export type WireDevice = components['schemas']['Device'];
export type WireDeviceList = components['schemas']['DeviceList'];
export type WireDeviceKeyInfo = components['schemas']['DeviceKeyInfo'];
export type WireKeyClaimRequest = components['schemas']['KeyClaimRequest'];
export type WireKeyClaimRequestDevice = WireKeyClaimRequest['devices'][number];
export type WireKeyClaimResponse = components['schemas']['KeyClaimResponse'];
export type WireChatKeysResponse = components['schemas']['ChatKeysResponse'];
export type WireVerificationRequest = components['schemas']['VerificationRequest'];
export type WireVerificationResponse = components['schemas']['VerificationResponse'];

function decodeKey(value: string, label: string, expectedBytes: number): Uint8Array {
  try {
    return decodeBase64Url(value, expectedBytes);
  } catch {
    throw invalid(
      'INVALID_RESPONSE',
      `${label} must be canonical base64url of ${expectedBytes} bytes`,
    );
  }
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw invalid('INVALID_RESPONSE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireKeyGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_KEY_GENERATION) {
    throw invalid('INVALID_RESPONSE', 'key_generation is out of range');
  }
  return value;
}

export interface DecodedSignedPrekey {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  readonly signature: Uint8Array;
  readonly createdAt: string | null;
  readonly expiresAt: string | null;
}

export interface DecodedOneTimePrekey {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
}

export interface DecodedPrekeyBundle {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identitySigningKey: Uint8Array;
  readonly identityDhKey: Uint8Array;
  readonly identityBindingSignature: Uint8Array;
  readonly signedPrekey: DecodedSignedPrekey;
  readonly oneTimePrekey: DecodedOneTimePrekey | null;
  readonly otpExhausted: boolean;
}

/** Validates and decodes an envelope object from the API into codec bytes. */
export function parseWireEnvelope(envelope: WireCryptoEnvelope): ParsedEnvelope {
  return parseEnvelope(envelope);
}

/** Canonical wire object for `POST /chats/{chatId}/messages` envelopes[]. */
export function serializeWireEnvelope(envelope: ParsedEnvelope): WireEnvelope {
  return encodeEnvelope(envelope);
}

export function decodeSignedPrekey(prekey: WireSignedPrekey): DecodedSignedPrekey {
  return {
    keyId: prekey.key_id,
    publicKey: decodeKey(prekey.public_key, 'signed_prekey.public_key', KEY_BYTES),
    signature: decodeKey(prekey.signature, 'signed_prekey.signature', SIGNATURE_BYTES),
    createdAt: prekey.created_at ?? null,
    expiresAt: prekey.expires_at ?? null,
  };
}

export function decodeOneTimePrekey(prekey: WireOneTimePrekey): DecodedOneTimePrekey {
  return {
    keyId: prekey.key_id,
    publicKey: decodeKey(prekey.public_key, 'one_time_prekey.public_key', KEY_BYTES),
  };
}

/**
 * Decodes a claimed prekey bundle. Cryptographic verification (SPK signature,
 * `identity_binding_signature`, TOFU pin) is E7-F4 and must run before this
 * bundle is used to create a session; decoding alone never establishes trust.
 */
export function decodePrekeyBundle(bundle: WirePrekeyBundle): DecodedPrekeyBundle {
  if (bundle.identity_key_alg !== 'Ed25519+X25519') {
    throw new E2eeError('INVALID_RESPONSE', 'bundle identity_key_alg must be Ed25519+X25519');
  }
  return {
    userId: requireUuid(bundle.user_id, 'bundle.user_id'),
    deviceId: requireUuid(bundle.device_id, 'bundle.device_id'),
    keyGeneration: requireKeyGeneration(bundle.key_generation),
    identitySigningKey: decodeKey(
      bundle.identity_signing_key,
      'bundle.identity_signing_key',
      KEY_BYTES,
    ),
    identityDhKey: decodeKey(bundle.identity_dh_key, 'bundle.identity_dh_key', KEY_BYTES),
    identityBindingSignature: decodeKey(
      bundle.identity_binding_signature,
      'bundle.identity_binding_signature',
      SIGNATURE_BYTES,
    ),
    signedPrekey: decodeSignedPrekey(bundle.signed_prekey),
    oneTimePrekey: bundle.one_time_prekey ? decodeOneTimePrekey(bundle.one_time_prekey) : null,
    otpExhausted: bundle.otp_exhausted,
  };
}

/** `e2ee_capable` is derived server-side; legacy devices must never be targets. */
export function isE2eeCapableDevice(device: Pick<WireDevice, 'e2ee_capable' | 'status'>): boolean {
  return device.e2ee_capable === true && device.status === 'ACTIVE';
}

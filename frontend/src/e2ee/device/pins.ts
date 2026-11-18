/**
 * TOFU pinning and key-change state (§3.3.1 checks 2/7, §5.6, §7.5).
 *
 * The pin is keyed by `(user_id, device_id)`, never by user alone (P0-2). A
 * first contact writes the pin **after** the bundle's binding/SPK signatures
 * were verified and before any session may be created. Any difference from an
 * existing pin creates a persisted key-change state and blocks send; the pin is
 * never overwritten automatically — only an explicit `acceptKeyChange` does it.
 *
 * No TTL ever removes a pin: the TOFU guarantee would degrade to "trust the
 * first key after a break".
 */
import { KEY_BYTES, MAX_KEY_GENERATION } from '../constants';
import { E2eeError } from '../errors';
import { isUuid } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import type { E2eeStorage } from '../storage/types';
import {
  deleteSealedPin,
  listSealedPins,
  type SealedPinListScope,
  mutateSealedPinRecords,
  readSealedKeyChange,
  readSealedPin,
} from './pinStore';
import { validateChatKeysResponse, validateClaimResponse, verifyClaimedBundle } from './binding';
import type {
  DecodedPrekeyBundle,
  WireChatKeysResponse,
  WireKeyClaimRequest,
  WireKeyClaimResponse,
} from '../api/deviceKeys';
import type {
  ChatKeysPinsResult,
  ClaimPinsResult,
  DecodedClaimResponse,
  DeviceKeyChangeRecord,
  LoadedDeviceIdentity,
  PinnedDeviceResult,
  PinnedKeysSnapshot,
  TofuPinCheck,
  TofuPinRecord,
  TofuPinSource,
  VerifiedClaimedBundle,
  VerifiedDeviceIdentity,
  VerifiedDeviceKeyInfo,
} from './types';

interface PinCandidate {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identitySigningKey: string;
  readonly identityDhKey: string;
  readonly identityBindingSignature: string;
  readonly fingerprint: string;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireB64(value: string, bytes: number, label: string): string {
  try {
    decodeBase64Url(value, bytes);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not canonical base64url`);
  }
  return value;
}

function requireKeyGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_KEY_GENERATION) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'key_generation is out of range');
  }
  return value;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a valid timestamp`);
  }
  return value;
}

function validatePin(value: unknown): TofuPinRecord {
  if (typeof value !== 'object' || value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'TOFU pin is not an object');
  }
  const pin = value as Partial<TofuPinRecord>;
  if (pin.v !== 1)
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'TOFU pin version is unsupported');
  const userId = requireUuid(pin.userId ?? '', 'pin.user_id');
  const deviceId = requireUuid(pin.deviceId ?? '', 'pin.device_id');
  requireB64(pin.identitySigningKey ?? '', KEY_BYTES, 'pin.identity_signing_key');
  requireB64(pin.identityDhKey ?? '', KEY_BYTES, 'pin.identity_dh_key');
  requireB64(pin.identityBindingSignature ?? '', 64, 'pin.identity_binding_signature');
  requireB64(pin.fingerprint ?? '', KEY_BYTES, 'pin.fingerprint');
  const keyGeneration = requireKeyGeneration(pin.keyGeneration ?? 0);
  if (pin.pinSource !== 'claim' && pin.pinSource !== 'chat_keys') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'TOFU pin source is invalid');
  }
  if (typeof pin.verified !== 'boolean') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'TOFU pin verified flag is invalid');
  }
  if (pin.verifiedAt !== null) requireTimestamp(pin.verifiedAt ?? -1, 'pin.verified_at');
  if (pin.acceptedAt !== null) requireTimestamp(pin.acceptedAt ?? -1, 'pin.accepted_at');
  return {
    v: 1,
    userId,
    deviceId,
    identitySigningKey: pin.identitySigningKey as string,
    identityDhKey: pin.identityDhKey as string,
    identityBindingSignature: pin.identityBindingSignature as string,
    fingerprint: pin.fingerprint as string,
    keyGeneration,
    firstSeen: requireTimestamp(pin.firstSeen ?? -1, 'pin.first_seen'),
    acceptedAt: pin.acceptedAt ?? null,
    verified: pin.verified,
    verifiedAt: pin.verifiedAt ?? null,
    pinSource: pin.pinSource,
  };
}

function validateKeyChange(value: unknown): DeviceKeyChangeRecord {
  if (typeof value !== 'object' || value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'key-change record is not an object');
  }
  const record = value as Partial<DeviceKeyChangeRecord>;
  if (record.v !== 1 || record.reason !== 'IDENTITY_KEY_CHANGED') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'key-change record is unsupported');
  }
  requireUuid(record.userId ?? '', 'key-change.user_id');
  requireUuid(record.deviceId ?? '', 'key-change.device_id');
  if (!record.pinned || !record.observed) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'key-change record is incomplete');
  }
  requireB64(record.pinned.identitySigningKey, KEY_BYTES, 'key-change.pinned.signing_key');
  requireB64(record.pinned.identityDhKey, KEY_BYTES, 'key-change.pinned.dh_key');
  requireB64(record.pinned.identityBindingSignature, 64, 'key-change.pinned.binding');
  requireB64(record.pinned.fingerprint, KEY_BYTES, 'key-change.pinned.fingerprint');
  requireKeyGeneration(record.pinned.keyGeneration);
  requireB64(record.observed.identitySigningKey, KEY_BYTES, 'key-change.observed.signing_key');
  requireB64(record.observed.identityDhKey, KEY_BYTES, 'key-change.observed.dh_key');
  requireB64(record.observed.identityBindingSignature, 64, 'key-change.observed.binding');
  requireB64(record.observed.fingerprint, KEY_BYTES, 'key-change.observed.fingerprint');
  requireKeyGeneration(record.observed.keyGeneration);
  requireTimestamp(record.detectedAt ?? -1, 'key-change.detected_at');
  return record as DeviceKeyChangeRecord;
}

export async function readPin(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<TofuPinRecord | null> {
  const value = await readSealedPin(storage, userId, deviceId);
  if (value === null) return null;
  const pin = validatePin(value);
  if (pin.userId !== userId || pin.deviceId !== deviceId) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'sealed pin belongs to another device');
  }
  return pin;
}

export async function getKeyChangeRecord(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<DeviceKeyChangeRecord | null> {
  const value = await readSealedKeyChange(storage, userId, deviceId);
  return value === null ? null : validateKeyChange(value);
}

export async function listPins(
  storage: E2eeStorage,
  scope: SealedPinListScope,
): Promise<TofuPinRecord[]> {
  const entries = await listSealedPins(storage, scope);
  const pins: TofuPinRecord[] = [];
  for (const entry of entries) {
    const pin = validatePin(entry.value);
    if (pin.userId !== entry.userId || pin.deviceId !== entry.deviceId) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'sealed pin scope does not match its key');
    }
    pins.push(pin);
  }
  return pins.sort((a, b) => a.firstSeen - b.firstSeen);
}

/** Explicit "forget device" action; never called by TTL/GC. */
export async function deletePin(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<void> {
  await deleteSealedPin(storage, userId, deviceId);
}

function candidateFromIdentity(identity: VerifiedDeviceIdentity): PinCandidate {
  return {
    userId: identity.userId,
    deviceId: identity.deviceId,
    keyGeneration: identity.keyGeneration,
    identitySigningKey: encodeBase64Url(identity.identitySigningKey),
    identityDhKey: encodeBase64Url(identity.identityDhKey),
    identityBindingSignature: encodeBase64Url(identity.identityBindingSignature),
    fingerprint: identity.fingerprintBase64Url,
  };
}

function candidateFromClaim(bundle: VerifiedClaimedBundle): PinCandidate {
  return candidateFromIdentity(bundle.identity);
}

function candidateFromInfo(info: VerifiedDeviceKeyInfo): PinCandidate {
  return candidateFromIdentity(info);
}

function samePinnedKeys(pin: TofuPinRecord, candidate: PinCandidate): boolean {
  return (
    pin.userId === candidate.userId &&
    pin.deviceId === candidate.deviceId &&
    pin.identitySigningKey === candidate.identitySigningKey &&
    pin.identityDhKey === candidate.identityDhKey &&
    pin.identityBindingSignature === candidate.identityBindingSignature &&
    pin.fingerprint === candidate.fingerprint &&
    pin.keyGeneration === candidate.keyGeneration
  );
}

function snapshot(pin: TofuPinRecord | PinCandidate): PinnedKeysSnapshot {
  return {
    identitySigningKey: pin.identitySigningKey,
    identityDhKey: pin.identityDhKey,
    identityBindingSignature: pin.identityBindingSignature,
    fingerprint: pin.fingerprint,
    keyGeneration: pin.keyGeneration,
  };
}

function sameSnapshot(a: PinnedKeysSnapshot, b: PinnedKeysSnapshot): boolean {
  return (
    a.identitySigningKey === b.identitySigningKey &&
    a.identityDhKey === b.identityDhKey &&
    a.identityBindingSignature === b.identityBindingSignature &&
    a.fingerprint === b.fingerprint &&
    a.keyGeneration === b.keyGeneration
  );
}

async function applyPinCheck(
  storage: E2eeStorage,
  candidate: PinCandidate,
  options: { readonly now: number; readonly source: TofuPinSource },
): Promise<TofuPinCheck> {
  return mutateSealedPinRecords<TofuPinCheck>(
    storage,
    candidate.userId,
    candidate.deviceId,
    (currentPin, currentChange) => {
      const pin = currentPin === null ? null : validatePin(currentPin);
      const previousChange = currentChange === null ? null : validateKeyChange(currentChange);
      if (pin === null) {
        const next: TofuPinRecord = {
          v: 1,
          userId: candidate.userId,
          deviceId: candidate.deviceId,
          identitySigningKey: candidate.identitySigningKey,
          identityDhKey: candidate.identityDhKey,
          identityBindingSignature: candidate.identityBindingSignature,
          fingerprint: candidate.fingerprint,
          keyGeneration: candidate.keyGeneration,
          firstSeen: options.now,
          acceptedAt: null,
          verified: false,
          verifiedAt: null,
          pinSource: options.source,
        };
        return {
          pin: next,
          keyChange: undefined,
          result: { status: 'first_contact', pin: next, keyChange: null },
        };
      }
      if (samePinnedKeys(pin, candidate)) {
        if (previousChange !== null) {
          throw new E2eeError(
            'KEY_CHANGE_DETECTED',
            'key-change state exists for an unchanged pin; explicit confirmation is required',
          );
        }
        return {
          pin: undefined,
          keyChange: undefined,
          result: { status: 'unchanged', pin, keyChange: null },
        };
      }
      const observed = snapshot(candidate);
      const pinned = snapshot(pin);
      const detectedAt =
        previousChange !== null && sameSnapshot(previousChange.pinned, pinned)
          ? previousChange.detectedAt
          : options.now;
      const keyChange: DeviceKeyChangeRecord = {
        v: 1,
        userId: candidate.userId,
        deviceId: candidate.deviceId,
        reason: 'IDENTITY_KEY_CHANGED',
        pinned,
        observed,
        detectedAt,
        blocked: true,
      };
      return {
        pin: undefined,
        keyChange,
        result: { status: 'key_change', pin, keyChange },
      };
    },
  );
}

/**
 * Pin/verify an already-verified identity (E7-F4 receive path). The caller must
 * have checked the binding signature, fingerprint and, for a prekey envelope,
 * the preamble signature/`prekey.sender_identity_*` before this call; this
 * function only records the TOFU decision or reports a key change.
 */
export async function checkVerifiedIdentityPin(
  storage: E2eeStorage,
  identity: VerifiedDeviceIdentity,
  options: { readonly now?: number; readonly source?: TofuPinSource } = {},
): Promise<TofuPinCheck> {
  return applyPinCheck(storage, candidateFromIdentity(identity), {
    now: options.now ?? Date.now(),
    source: options.source ?? 'chat_keys',
  });
}

/** Verifies a claim bundle and pins it (or reports key change). */
export async function checkBundlePin(
  storage: E2eeStorage,
  bundle: VerifiedClaimedBundle,
  options: { readonly now?: number; readonly source?: TofuPinSource } = {},
): Promise<TofuPinCheck> {
  return applyPinCheck(storage, candidateFromClaim(bundle), {
    now: options.now ?? Date.now(),
    source: options.source ?? 'claim',
  });
}

export async function checkDeviceInfoPin(
  storage: E2eeStorage,
  info: VerifiedDeviceKeyInfo,
  options: { readonly now?: number; readonly source?: TofuPinSource } = {},
): Promise<TofuPinCheck> {
  return applyPinCheck(storage, candidateFromInfo(info), {
    now: options.now ?? Date.now(),
    source: options.source ?? 'chat_keys',
  });
}

/** Convenience: decode+verify a raw bundle before pinning. */
export async function checkRawBundlePin(
  storage: E2eeStorage,
  bundle: DecodedPrekeyBundle,
  options: { readonly now?: number; readonly source?: TofuPinSource } = {},
): Promise<TofuPinCheck> {
  const verified = await verifyClaimedBundle(bundle, { now: options.now });
  return checkBundlePin(storage, verified, options);
}

export interface AcceptKeyChangeOptions {
  readonly now?: number;
  readonly source?: TofuPinSource;
}

interface AcceptObservedOptions extends AcceptKeyChangeOptions {
  /** When set, the caller's view of the new keys must equal the persisted `observed`. */
  readonly expectedObserved?: PinnedKeysSnapshot;
}

/**
 * Accepts exactly the key set persisted in `key-change.observed` (CR1b P2-17).
 * A missing key-change state, a pin that does not match `observed.pinned`, or
 * an `expectedObserved` that differs from the persisted observation all fail
 * closed before any write happens (the storage transaction aborts, so the
 * warning and the old pin stay intact). This prevents "Accept" from silently
 * pinning a third key that the user never saw.
 */
async function acceptObservedKeys(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
  options: AcceptObservedOptions,
): Promise<TofuPinRecord> {
  const now = options.now ?? Date.now();
  return mutateSealedPinRecords<TofuPinRecord>(
    storage,
    userId,
    deviceId,
    (currentPin, currentChange) => {
      if (currentChange === null) {
        throw new E2eeError(
          'KEY_CHANGE_DETECTED',
          'no persisted key-change state; refusing to overwrite a pin',
        );
      }
      const keyChange = validateKeyChange(currentChange);
      if (keyChange.userId !== userId || keyChange.deviceId !== deviceId) {
        throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'key-change scope does not match its key');
      }
      if (
        options.expectedObserved !== undefined &&
        !sameSnapshot(keyChange.observed, options.expectedObserved)
      ) {
        throw new E2eeError(
          'KEY_CHANGE_DETECTED',
          'key-change observed keys changed; refresh the warning before accepting',
        );
      }
      const previous = currentPin === null ? null : validatePin(currentPin);
      if (previous === null || !sameSnapshot(snapshot(previous), keyChange.pinned)) {
        throw new E2eeError(
          'KEY_STORAGE_UNAVAILABLE',
          'pinned keys do not match the key-change state; refusing to accept',
        );
      }
      const observed = keyChange.observed;
      const pin: TofuPinRecord = {
        v: 1,
        userId,
        deviceId,
        identitySigningKey: observed.identitySigningKey,
        identityDhKey: observed.identityDhKey,
        identityBindingSignature: observed.identityBindingSignature,
        fingerprint: observed.fingerprint,
        keyGeneration: observed.keyGeneration,
        firstSeen: previous.firstSeen,
        acceptedAt: now,
        verified: false,
        verifiedAt: null,
        pinSource: options.source ?? previous.pinSource,
      };
      return { pin, keyChange: null, result: pin };
    },
  );
}

/**
 * Explicit user action after a key-change warning. The bundle must be exactly
 * the persisted `observed` key set; otherwise `KEY_CHANGE_DETECTED` is raised
 * and nothing is written. On success the pin is overwritten with `observed`,
 * `verified` resets and the key-change state is cleared. Never automatic.
 */
export async function acceptKeyChange(
  storage: E2eeStorage,
  bundle: VerifiedClaimedBundle,
  options: AcceptKeyChangeOptions = {},
): Promise<TofuPinRecord> {
  const candidate = candidateFromClaim(bundle);
  return acceptObservedKeys(storage, candidate.userId, candidate.deviceId, {
    ...options,
    expectedObserved: snapshot(candidate),
  });
}

/**
 * Accept action keyed by `(user_id, device_id)` rather than by a fresh bundle.
 * This is the safest F5 entry point: the accepted keys are read from the
 * persisted `observed` record, so no network response can substitute them.
 */
export async function acceptObservedKeyChange(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
  options: AcceptKeyChangeOptions = {},
): Promise<TofuPinRecord> {
  return acceptObservedKeys(
    storage,
    requireUuid(userId, 'user_id'),
    requireUuid(deviceId, 'device_id'),
    options,
  );
}

/** Send guard: any persisted key change blocks the device until confirmation. */
export async function assertDeviceNotBlocked(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<void> {
  const change = await getKeyChangeRecord(storage, userId, deviceId);
  if (change !== null) {
    throw new E2eeError('KEY_CHANGE_DETECTED', 'device identity changed; confirmation is required');
  }
}

function assertSelfIdentity(local: LoadedDeviceIdentity, candidate: PinCandidate): void {
  const record = local.record;
  if (record.deviceId !== null && record.deviceId !== candidate.deviceId) {
    throw new E2eeError('DEVICE_IDENTITY_MISMATCH', 'self device id does not match local identity');
  }
  if (
    record.identitySigningKey !== candidate.identitySigningKey ||
    record.identityDhKey !== candidate.identityDhKey ||
    record.identityBindingSignature !== candidate.identityBindingSignature ||
    record.fingerprint !== candidate.fingerprint
  ) {
    throw new E2eeError('KEY_CHANGE_DETECTED', 'self device keys do not match local identity');
  }
  if (record.keyGeneration !== candidate.keyGeneration) {
    throw new E2eeError('KEY_GENERATION_STALE', 'self device key generation changed');
  }
}

/** Claim flow: verify every bundle, pin peers, verify the self device if present. */
export async function evaluateClaimPins(
  storage: E2eeStorage,
  response: WireKeyClaimResponse,
  request: WireKeyClaimRequest,
  options: {
    readonly now?: number;
    readonly source?: TofuPinSource;
    readonly localIdentity?: LoadedDeviceIdentity;
  } = {},
): Promise<ClaimPinsResult> {
  const decoded: DecodedClaimResponse = await validateClaimResponse(response, request, {
    now: options.now,
  });
  const localDeviceId = options.localIdentity?.record.deviceId ?? null;
  let selfVerified = false;
  const devices: PinnedDeviceResult[] = [];
  for (const bundle of decoded.bundles) {
    const candidate = candidateFromClaim(bundle);
    if (localDeviceId !== null && candidate.deviceId === localDeviceId) {
      if (options.localIdentity) assertSelfIdentity(options.localIdentity, candidate);
      selfVerified = true;
      continue;
    }
    const check = await applyPinCheck(storage, candidate, {
      now: options.now ?? Date.now(),
      source: options.source ?? 'claim',
    });
    devices.push({
      userId: candidate.userId,
      deviceId: candidate.deviceId,
      status: check.status,
      pin: check.pin,
      keyChange: check.keyChange,
    });
  }
  return {
    devices,
    unavailable: decoded.unavailable,
    blocked: devices.some((device) => device.status === 'key_change'),
    selfVerified,
  };
}

/** `/chats/{id}/keys` flow: pin peers, verify self against local identity. */
export async function evaluateChatKeysPins(
  storage: E2eeStorage,
  response: WireChatKeysResponse,
  options: {
    readonly chatId: string;
    readonly myDeviceId: string;
    readonly now?: number;
    readonly source?: TofuPinSource;
    readonly localIdentity?: LoadedDeviceIdentity;
  },
): Promise<ChatKeysPinsResult> {
  const verified = await validateChatKeysResponse(response, {
    chatId: options.chatId,
    myDeviceId: options.myDeviceId,
    localIdentity: options.localIdentity,
  });
  const devices: PinnedDeviceResult[] = [];
  let selfVerified = false;
  for (const info of verified) {
    if (info.isSelf) {
      selfVerified = true;
      continue;
    }
    const check = await applyPinCheck(storage, candidateFromInfo(info), {
      now: options.now ?? Date.now(),
      source: options.source ?? 'chat_keys',
    });
    devices.push({
      userId: info.userId,
      deviceId: info.deviceId,
      status: check.status,
      pin: check.pin,
      keyChange: check.keyChange,
    });
  }
  return {
    devices,
    blocked: devices.some((device) => device.status === 'key_change'),
    selfVerified,
  };
}

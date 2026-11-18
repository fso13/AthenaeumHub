/**
 * Device registration orchestration (§2.5, §3.1, §5.1–§5.3, D-17/D-S4-03).
 *
 * - Keyed registration is all-or-none: IK_sig, IK_dh, binding signature, SPK
 *   and `identity_key_alg` are sent together. Without keys the body is a legacy
 *   registration (rollout path), never an in-place upgrade (D-17).
 * - The exact body and `Idempotency-Key` are persisted before the network call
 *   and reused on retry (§4.6); a network failure never regenerates keys.
 * - The server response is verified against the local identity
 *   (`e2ee_capable=true`, same keys, `key_generation`) before it is trusted.
 */
import { MAX_KEY_GENERATION } from '../constants';
import { E2eeError, invalid } from '../errors';
import { isUuid } from '../encoding/bytes';
import { decodeBase64Url } from '../encoding/base64url';
import { getOneTimePrekey, getSignedPrekey } from '../session/prekeyStore';
import type { E2eeStorage } from '../storage/types';
import type {
  WireDevice,
  WireDeviceRegistration,
  WireOneTimePrekey,
  WireSignedPrekey,
} from '../api/deviceKeys';
import {
  bindDeviceIdentityUser,
  commitDeviceRegistration,
  createDeviceIdentity,
  isCanonicalUuid,
  loadDeviceIdentity,
  randomUuid,
  readPendingDeviceRegistration,
  writePendingDeviceRegistration,
  clearPendingDeviceRegistration,
  markDeviceIdentityState,
  type CreateDeviceIdentityOptions,
} from './identity';
import { collectActiveSessionSpkIds } from './sessionSpk';
import {
  ensureOneTimePrekeys,
  ensureSignedPrekey,
  registrationOneTimePrekeys,
  toWireOneTimePrekey,
  toWireSignedPrekey,
  defaultPrekeyIdFactory,
  type PrekeyIdFactory,
} from './prekeys';
import {
  isDeviceTransportError,
  isRetryableDeviceTransportError,
  type DeviceIdentityRecord,
  type DeviceRegistrationTransport,
  type LoadedDeviceIdentity,
  type PendingDeviceRegistration,
  type PreparedDeviceRegistration,
  type RegisterDeviceResult,
} from './types';

export const LEGACY_IDENTITY_KEY_ALG = 'LEGACY';
export const E2EE_IDENTITY_KEY_ALG = 'Ed25519+X25519';

export interface DeviceRegistrationInput {
  readonly name: string;
  readonly platform?: 'WEB';
  readonly appVersion: string;
}

export interface PrepareDeviceRegistrationOptions extends DeviceRegistrationInput {
  readonly userId: string;
  readonly idempotencyKey?: string;
  readonly opkCount?: number;
  readonly now?: number;
  readonly idFactory?: PrekeyIdFactory;
  readonly activeSessionSpkIds?: ReadonlySet<string>;
}

const REGISTRATION_KEY_FIELDS = [
  'identity_signing_key',
  'identity_dh_key',
  'identity_binding_signature',
  'identity_key_alg',
  'signed_prekey',
] as const;

export type RegistrationMode = 'e2ee' | 'legacy';

/**
 * Enforces the contract's all-or-none rule: either all five key fields are
 * present or none is. `one_time_prekeys` is only legal together with keys.
 */
export function assertRegistrationAllOrNone(body: WireDeviceRegistration): RegistrationMode {
  const present = REGISTRATION_KEY_FIELDS.filter((field) => body[field] !== undefined);
  const oneTimePrekeys = body.one_time_prekeys ?? [];
  if (present.length === 0) {
    if (oneTimePrekeys.length > 0) {
      throw invalid('INVALID_KEY', 'one_time_prekeys require the full device key set');
    }
    return 'legacy';
  }
  if (present.length !== REGISTRATION_KEY_FIELDS.length) {
    throw invalid('INVALID_KEY', 'device registration keys must be all-or-none');
  }
  if (body.identity_key_alg !== E2EE_IDENTITY_KEY_ALG) {
    throw invalid('INVALID_KEY', 'identity_key_alg must be Ed25519+X25519 for keyed registration');
  }
  if (oneTimePrekeys.length > 200) {
    throw invalid('INVALID_KEY', 'at most 200 one-time prekeys may be registered');
  }
  return 'e2ee';
}

export function buildLegacyDeviceRegistration(
  input: DeviceRegistrationInput,
): WireDeviceRegistration {
  return {
    name: input.name,
    platform: input.platform ?? 'WEB',
    app_version: input.appVersion,
  };
}

export interface BuildDeviceRegistrationInput extends DeviceRegistrationInput {
  readonly identity: LoadedDeviceIdentity;
  readonly signedPrekey: WireSignedPrekey;
  readonly oneTimePrekeys: readonly WireOneTimePrekey[];
}

export function buildDeviceRegistrationBody(
  input: BuildDeviceRegistrationInput,
): WireDeviceRegistration {
  const record = input.identity.record;
  return {
    name: input.name,
    platform: input.platform ?? 'WEB',
    app_version: input.appVersion,
    identity_signing_key: record.identitySigningKey,
    identity_dh_key: record.identityDhKey,
    identity_binding_signature: record.identityBindingSignature,
    identity_key_alg: E2EE_IDENTITY_KEY_ALG,
    signed_prekey: input.signedPrekey,
    one_time_prekeys: input.oneTimePrekeys.map((prekey) => ({
      key_id: prekey.key_id,
      public_key: prekey.public_key,
    })),
  };
}

function validateIdempotencyKey(value: string): string {
  if (!isUuid(value)) {
    throw invalid('INVALID_ENCODING', 'idempotency key must be a canonical UUID');
  }
  return value;
}

async function pendingMatchesIdentity(
  storage: E2eeStorage,
  pending: PendingDeviceRegistration,
  identity: LoadedDeviceIdentity,
): Promise<boolean> {
  const record = identity.record;
  const body = pending.body;
  if (pending.userId !== null && record.userId !== null && pending.userId !== record.userId) {
    return false;
  }
  if (
    body.identity_signing_key !== record.identitySigningKey ||
    body.identity_dh_key !== record.identityDhKey ||
    body.identity_binding_signature !== record.identityBindingSignature ||
    body.identity_key_alg !== E2EE_IDENTITY_KEY_ALG
  ) {
    return false;
  }
  const signedPrekey = body.signed_prekey;
  if (!signedPrekey) return false;
  const storedSpk = await getSignedPrekey(storage, signedPrekey.key_id);
  if (!storedSpk) return false;
  if (
    storedSpk.publicKey !== signedPrekey.public_key ||
    storedSpk.signature !== signedPrekey.signature
  ) {
    return false;
  }
  for (const prekey of body.one_time_prekeys ?? []) {
    if ((await getOneTimePrekey(storage, prekey.key_id)) === null) return false;
  }
  return true;
}

function assertIdentityCanRegister(identity: LoadedDeviceIdentity): void {
  const record = identity.record;
  if (record.deviceId !== null && record.state === 'registered') return;
  if (record.state === 'revoked') {
    throw new E2eeError(
      'KEY_CHANGE_DETECTED',
      'device identity was revoked; register a new device',
    );
  }
  if (record.state === 'conflict') {
    throw new E2eeError(
      'DEVICE_IDENTITY_CONFLICT',
      'device identity is already registered elsewhere',
    );
  }
  if (record.state === 'legacy') {
    throw new E2eeError('DEVICE_IDENTITY_INVALID', 'legacy devices cannot be upgraded in place');
  }
  if (record.state === 'invalid') {
    throw new E2eeError(
      'DEVICE_IDENTITY_INVALID',
      'device identity was rejected; a new device is required',
    );
  }
}

async function loadOrCreateIdentity(
  storage: E2eeStorage,
  options: PrepareDeviceRegistrationOptions,
): Promise<LoadedDeviceIdentity> {
  const createOptions: CreateDeviceIdentityOptions = {
    userId: options.userId,
    now: options.now,
  };
  let identity = await createDeviceIdentity(storage, createOptions);
  if (identity.record.userId === null) {
    const record = await bindDeviceIdentityUser(storage, options.userId);
    identity = { ...identity, record };
  }
  return identity;
}

/**
 * Builds (or reuses) the exact registration body. Calling it repeatedly after
 * a crash returns the same keys, SPK id, OPK ids and `Idempotency-Key`.
 */
export async function prepareDeviceRegistration(
  storage: E2eeStorage,
  options: PrepareDeviceRegistrationOptions,
): Promise<PreparedDeviceRegistration> {
  const identity = await loadOrCreateIdentity(storage, options);
  const record = identity.record;
  assertIdentityCanRegister(identity);
  if (record.deviceId !== null && record.state === 'registered') {
    return {
      kind: 'already_registered',
      deviceId: record.deviceId,
      keyGeneration: record.keyGeneration,
      identity,
    };
  }

  const now = options.now ?? Date.now();
  const pending = await readPendingDeviceRegistration(storage);
  if (pending !== null && (await pendingMatchesIdentity(storage, pending, identity))) {
    const body = pending.body;
    assertRegistrationAllOrNone(body);
    return {
      kind: 'ready',
      body,
      idempotencyKey: pending.idempotencyKey,
      identity,
      oneTimePrekeyCount: body.one_time_prekeys?.length ?? 0,
    };
  }
  if (pending !== null) await clearPendingDeviceRegistration(storage);

  const activeSessionSpkIds =
    options.activeSessionSpkIds ?? (await collectActiveSessionSpkIds(storage));
  const spk = await ensureSignedPrekey(storage, identity, {
    now,
    activeSessionSpkIds,
    keyId: options.idFactory?.signedPrekeyId(now),
  });
  const opkCount = Math.min(Math.max(options.opkCount ?? 100, 0), 200);
  await ensureOneTimePrekeys(storage, {
    now,
    target: opkCount,
    lowWater: opkCount,
    max: 200,
    idFactory: options.idFactory ?? defaultPrekeyIdFactory,
  });
  const opks = await registrationOneTimePrekeys(storage, now);

  const body = buildDeviceRegistrationBody({
    name: options.name,
    platform: options.platform ?? 'WEB',
    appVersion: options.appVersion,
    identity,
    signedPrekey: toWireSignedPrekey(spk.record),
    oneTimePrekeys: opks.map(toWireOneTimePrekey),
  });
  const mode = assertRegistrationAllOrNone(body);
  if (mode !== 'e2ee') {
    throw new E2eeError('INVALID_KEY', 'keyed registration body was built without keys');
  }

  const idempotencyKey = validateIdempotencyKey(options.idempotencyKey ?? randomUuid());
  const next: PendingDeviceRegistration = {
    v: 1,
    idempotencyKey,
    userId: record.userId,
    body,
    createdAt: now,
  };
  await writePendingDeviceRegistration(storage, next);
  return {
    kind: 'ready',
    body,
    idempotencyKey,
    identity,
    oneTimePrekeyCount: opks.length,
  };
}

function decodeKeyForCompare(value: string | null | undefined, label: string): Uint8Array {
  if (typeof value !== 'string') {
    throw new E2eeError('INVALID_RESPONSE', `${label} is missing`);
  }
  try {
    return decodeBase64Url(value, 32);
  } catch {
    throw new E2eeError('INVALID_RESPONSE', `${label} must be canonical b64u32`);
  }
}

function assertKeyedRegistrationResponse(
  device: WireDevice,
  prepared: Extract<PreparedDeviceRegistration, { kind: 'ready' }>,
): { deviceId: string; keyGeneration: number } {
  const record = prepared.identity.record;
  if (!isUuid(device.id)) {
    throw new E2eeError('INVALID_RESPONSE', 'device response id must be a canonical UUID');
  }
  if (device.e2ee_capable !== true || device.identity_key_alg === LEGACY_IDENTITY_KEY_ALG) {
    throw new E2eeError('INVALID_RESPONSE', 'server registered the device without E2EE keys');
  }
  if (device.identity_key_alg !== E2EE_IDENTITY_KEY_ALG) {
    throw new E2eeError('INVALID_RESPONSE', 'identity_key_alg must be Ed25519+X25519');
  }
  if (device.status !== undefined && device.status !== 'ACTIVE') {
    throw new E2eeError('INVALID_RESPONSE', 'registered device must be ACTIVE');
  }
  if (
    device.identity_signing_key !== record.identitySigningKey ||
    device.identity_dh_key !== record.identityDhKey ||
    device.identity_binding_signature !== record.identityBindingSignature
  ) {
    throw new E2eeError(
      'KEY_CHANGE_DETECTED',
      'server returned different identity keys for this registration',
    );
  }
  if (device.fingerprint !== undefined && device.fingerprint !== null) {
    const fingerprint = decodeKeyForCompare(device.fingerprint, 'device.fingerprint');
    const expected = decodeKeyForCompare(record.fingerprint, 'local fingerprint');
    if (
      fingerprint.length !== expected.length ||
      fingerprint.some((byte, i) => byte !== expected[i])
    ) {
      throw new E2eeError('KEY_CHANGE_DETECTED', 'server fingerprint does not match local keys');
    }
  }
  if (device.signed_prekey !== undefined && device.signed_prekey !== null) {
    const expected = prepared.body.signed_prekey;
    if (!expected) {
      throw new E2eeError('INVALID_RESPONSE', 'server returned an SPK that was not sent');
    }
    if (
      device.signed_prekey.key_id !== expected.key_id ||
      device.signed_prekey.public_key !== expected.public_key ||
      device.signed_prekey.signature !== expected.signature
    ) {
      throw new E2eeError('INVALID_RESPONSE', 'server did not store the uploaded signed prekey');
    }
  }
  if (
    !Number.isInteger(device.key_generation) ||
    (device.key_generation ?? 0) < 1 ||
    (device.key_generation ?? 0) > MAX_KEY_GENERATION
  ) {
    throw new E2eeError('INVALID_RESPONSE', 'key_generation is out of range');
  }
  return { deviceId: device.id, keyGeneration: device.key_generation as number };
}

export interface CompleteDeviceRegistrationOptions {
  readonly now?: number;
}

/** Verifies the server response against local keys and commits the device id. */
export async function completeDeviceRegistration(
  storage: E2eeStorage,
  prepared: Extract<PreparedDeviceRegistration, { kind: 'ready' }>,
  device: WireDevice,
  options: CompleteDeviceRegistrationOptions = {},
): Promise<DeviceIdentityRecord> {
  let committed: { deviceId: string; keyGeneration: number };
  try {
    committed = assertKeyedRegistrationResponse(device, prepared);
  } catch (error) {
    if (device.e2ee_capable !== true) {
      await markDeviceIdentityState(
        storage,
        device.identity_key_alg === LEGACY_IDENTITY_KEY_ALG ? 'legacy' : 'invalid',
      );
    }
    throw error;
  }
  return commitDeviceRegistration(storage, {
    deviceId: committed.deviceId,
    keyGeneration: committed.keyGeneration,
    userId: prepared.identity.record.userId,
    now: options.now,
  });
}

export interface RegisterDeviceOptions extends PrepareDeviceRegistrationOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function defaultRegistrationSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function retryDelay(error: unknown, attempt: number, options: RegisterDeviceOptions): number {
  const base = options.baseDelayMs ?? 250;
  const cap = options.maxDelayMs ?? 4_000;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  if (isDeviceTransportError(error) && error.retryAfterSeconds !== undefined) {
    return Math.max(exponential, Math.min(cap, error.retryAfterSeconds * 1_000));
  }
  return exponential;
}

async function markRegistrationFailure(storage: E2eeStorage, error: unknown): Promise<void> {
  if (!isDeviceTransportError(error)) return;
  if (error.kind === 'device_revoked') {
    await markDeviceIdentityState(storage, 'revoked');
  } else if (error.kind === 'identity_key_conflict') {
    await markDeviceIdentityState(storage, 'conflict');
  } else if (error.kind === 'legacy_device') {
    await markDeviceIdentityState(storage, 'legacy');
  } else if (error.kind === 'invalid_identity_binding' || error.kind === 'invalid_spk_signature') {
    await markDeviceIdentityState(storage, 'invalid');
  }
}

/**
 * Registers the device with the exact persisted body. Retries only transient
 * failures; `Idempotency-Key` and key material are never regenerated here.
 */
export async function registerDevice(
  storage: E2eeStorage,
  transport: DeviceRegistrationTransport,
  options: RegisterDeviceOptions,
): Promise<RegisterDeviceResult> {
  const prepared = await prepareDeviceRegistration(storage, options);
  if (prepared.kind === 'already_registered') {
    return {
      status: 'already_registered',
      deviceId: prepared.deviceId,
      keyGeneration: prepared.keyGeneration,
      replayed: false,
      device: null,
    };
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? defaultRegistrationSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await transport.registerDevice(prepared.body, prepared.idempotencyKey);
      const record = await completeDeviceRegistration(storage, prepared, response.device);
      return {
        status: 'registered',
        deviceId: record.deviceId as string,
        keyGeneration: record.keyGeneration,
        replayed: response.replayed,
        device: response.device,
      };
    } catch (error) {
      const retryable = isRetryableDeviceTransportError(error);
      if (!retryable || attempt >= maxAttempts) {
        await markRegistrationFailure(storage, error);
        throw error;
      }
      await sleep(retryDelay(error, attempt, options));
    }
  }
}

/** Legacy rollout path: registers a device without any E2EE material (D-17). */
export async function registerLegacyDevice(
  transport: DeviceRegistrationTransport,
  input: DeviceRegistrationInput & {
    readonly idempotencyKey?: string;
    readonly maxAttempts?: number;
    readonly sleep?: (milliseconds: number) => Promise<void>;
  },
): Promise<WireDevice> {
  const body = buildLegacyDeviceRegistration(input);
  if (assertRegistrationAllOrNone(body) !== 'legacy') {
    throw new E2eeError('INVALID_KEY', 'legacy registration body must not contain keys');
  }
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey ?? randomUuid());
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const sleep = input.sleep ?? defaultRegistrationSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await transport.registerDevice(body, idempotencyKey);
      const device = response.device;
      if (!isUuid(device.id)) {
        throw new E2eeError('INVALID_RESPONSE', 'device response id must be a canonical UUID');
      }
      if (device.e2ee_capable === true) {
        throw new E2eeError(
          'INVALID_RESPONSE',
          'legacy registration unexpectedly returned E2EE keys',
        );
      }
      if (
        device.identity_key_alg !== undefined &&
        device.identity_key_alg !== LEGACY_IDENTITY_KEY_ALG
      ) {
        throw new E2eeError(
          'INVALID_RESPONSE',
          'legacy registration returned a non-LEGACY algorithm',
        );
      }
      if (device.status !== undefined && device.status !== 'ACTIVE') {
        throw new E2eeError('INVALID_RESPONSE', 'registered device must be ACTIVE');
      }
      return device;
    } catch (error) {
      if (!isRetryableDeviceTransportError(error) || attempt >= maxAttempts) throw error;
      await sleep(
        retryDelay(error, attempt, {
          userId: '',
          name: input.name,
          appVersion: input.appVersion,
        }),
      );
    }
  }
}

export interface OwnDeviceVerification {
  readonly deviceId: string;
  readonly keyGeneration: number;
}

/**
 * P0-2b step 3a: own `GET /devices` record must byte-match local identity
 * before a prekey block may carry those keys.
 */
export async function verifyOwnDeviceRecord(
  storage: E2eeStorage,
  device: WireDevice,
  options: { readonly userId: string | null },
): Promise<OwnDeviceVerification> {
  const identity = await loadDeviceIdentity(storage, { userId: options.userId });
  if (!identity || identity.record.deviceId === null) {
    throw new E2eeError('DEVICE_NOT_REGISTERED', 'device is not registered');
  }
  const record = identity.record;
  if (device.id !== record.deviceId) {
    throw new E2eeError('DEVICE_IDENTITY_MISMATCH', 'GET /devices returned another device');
  }
  if (device.e2ee_capable !== true || device.identity_key_alg === LEGACY_IDENTITY_KEY_ALG) {
    throw new E2eeError('DEVICE_IDENTITY_INVALID', 'registered device is not E2EE-capable');
  }
  if (
    device.identity_signing_key !== record.identitySigningKey ||
    device.identity_dh_key !== record.identityDhKey ||
    device.identity_binding_signature !== record.identityBindingSignature
  ) {
    throw new E2eeError(
      'KEY_CHANGE_DETECTED',
      'server identity keys do not match local device keys',
    );
  }
  if (device.fingerprint !== undefined && device.fingerprint !== null) {
    const fingerprint = decodeKeyForCompare(device.fingerprint, 'device.fingerprint');
    const expected = decodeKeyForCompare(record.fingerprint, 'local fingerprint');
    if (fingerprint.length !== expected.length || fingerprint.some((b, i) => b !== expected[i])) {
      throw new E2eeError('KEY_CHANGE_DETECTED', 'server fingerprint does not match local keys');
    }
  }
  if (!Number.isInteger(device.key_generation) || (device.key_generation ?? 0) < 1) {
    throw new E2eeError('INVALID_RESPONSE', 'key_generation is out of range');
  }
  if (device.key_generation !== record.keyGeneration) {
    throw new E2eeError('KEY_GENERATION_STALE', 'device key generation changed');
  }
  return { deviceId: record.deviceId, keyGeneration: record.keyGeneration };
}

export function isCanonicalDeviceId(value: unknown): value is string {
  return isCanonicalUuid(value);
}

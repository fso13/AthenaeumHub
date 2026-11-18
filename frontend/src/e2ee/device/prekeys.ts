/**
 * Device prekey provisioning, rotation and replenishment (§2.3, §3.1, §3.2,
 * §5.3). E7-F3 owns the client-side half of `POST /devices` and
 * `POST /devices/{id}/prekeys`; the network call itself lives in
 * `src/api/e2eeDeviceApi.ts`.
 *
 * Invariants:
 * - a key id is generated once and never reused (a collision is skipped, never
 *   overwritten);
 * - the private half is persisted before the public half can be uploaded, and
 *   the pending upload body is retried byte for byte with the same
 *   `Idempotency-Key`;
 * - OPK replenishment is low-water based (`< 20` → fill to 100, hard cap 200);
 * - SPK rotation reuses F2 retention (`current + 2 previous`, 90-day window,
 *   30-day rotation/TTL);
 * - a pending upload that references an OPK whose private half disappeared is
 *   discarded, so the server is never told about a key we cannot use.
 */
import {
  KEY_ID_PATTERN,
  MAX_KEY_ID_CHARS,
  MAX_KEY_GENERATION,
  SPK_ROTATION_INTERVAL_MS,
} from '../constants';
import { E2eeError, invalid, isE2eeError } from '../errors';
import { isUuid, zeroBytes } from '../encoding/bytes';
import { generateX25519KeyPair } from '../crypto/x25519';
import { randomBytes } from '../crypto/random';
import { signSpk } from '../protocol/signatures';
import {
  countAvailableOneTimePrekeys,
  countAvailableOneTimePrekeysInTransaction,
  encodePrekeyPublicKey,
  encodePrekeySignature,
  getCurrentSignedPrekey,
  getOneTimePrekey,
  listOneTimePrekeys,
  oneTimePrekeyExpiry,
  pruneExpiredOneTimePrekeys,
  putOneTimePrekeyInTransaction,
  rotateSignedPrekey,
  signedPrekeyExpiry,
  type OneTimePrekeyRecord,
  type SignedPrekeyRecord,
} from '../session/prekeyStore';
import { type E2eeStorage } from '../storage/types';
import type {
  LoadedDeviceIdentity,
  PendingPrekeyUpload,
  PrekeyUploadPlan,
  PrekeyUploadResultSummary,
  PrekeyUploadTransport,
} from './types';
import { isRetryableDeviceTransportError, isDeviceTransportError } from './types';
import { markDeviceIdentityState, randomUuid } from './identity';
import { collectActiveSessionSpkIds } from './sessionSpk';

export const PENDING_PREKEY_UPLOAD_KEY = 'prekey-upload:pending:v1';
export const DEFAULT_OPK_TARGET = 100;
export const DEFAULT_OPK_LOW_WATER = 20;
export const DEFAULT_OPK_MAX = 200;

export interface PrekeyIdFactory {
  signedPrekeyId(now: number): string;
  oneTimePrekeyId(index: number): string;
}

function randomHex(bytes: number): string {
  const value = randomBytes(bytes);
  try {
    let hex = '';
    for (const byte of value) hex += byte.toString(16).padStart(2, '0');
    return hex;
  } finally {
    zeroBytes(value);
  }
}

export const defaultPrekeyIdFactory: PrekeyIdFactory = {
  signedPrekeyId(now) {
    const day = new Date(now).toISOString().slice(0, 10);
    return `spk-${day}-${randomHex(4)}`;
  },
  oneTimePrekeyId() {
    return `opk-${randomHex(6)}`;
  },
};

function requireKeyId(value: string, label: string): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value) || value.length > MAX_KEY_ID_CHARS) {
    throw invalid('INVALID_KEY', `${label} must match ${KEY_ID_PATTERN.source}`);
  }
  return value;
}

function requireKeyGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_KEY_GENERATION) {
    throw invalid('INVALID_KEY', 'key_generation is out of range');
  }
  return value;
}

function validateKeyIdFactory(factory: PrekeyIdFactory): PrekeyIdFactory {
  if (
    typeof factory?.signedPrekeyId !== 'function' ||
    typeof factory?.oneTimePrekeyId !== 'function'
  ) {
    throw new E2eeError('INVALID_KEY', 'prekey id factory is invalid');
  }
  return factory;
}

export async function createSignedPrekeyRecord(
  identity: LoadedDeviceIdentity,
  options: { readonly now?: number; readonly keyId?: string } = {},
): Promise<SignedPrekeyRecord> {
  const now = options.now ?? Date.now();
  const keyId = requireKeyId(
    options.keyId ?? defaultPrekeyIdFactory.signedPrekeyId(now),
    'signed_prekey.key_id',
  );
  const pair = await generateX25519KeyPair();
  const signature = await signSpk(identity.signingPrivateKey, keyId, pair.publicKeyBytes);
  return {
    v: 1,
    keyId,
    publicKey: encodePrekeyPublicKey(pair.publicKeyBytes),
    signature: encodePrekeySignature(signature),
    privateKey: pair.privateKey,
    createdAt: now,
    expiresAt: signedPrekeyExpiry(now),
    retiredAt: null,
  };
}

export async function createOneTimePrekeyRecord(
  keyId: string,
  now = Date.now(),
): Promise<OneTimePrekeyRecord> {
  requireKeyId(keyId, 'one_time_prekey.key_id');
  const pair = await generateX25519KeyPair();
  return {
    v: 1,
    keyId,
    publicKey: encodePrekeyPublicKey(pair.publicKeyBytes),
    privateKey: pair.privateKey,
    createdAt: now,
    expiresAt: oneTimePrekeyExpiry(now),
  };
}

export interface EnsureSignedPrekeyOptions {
  readonly now?: number;
  readonly force?: boolean;
  readonly keyId?: string;
  readonly activeSessionSpkIds?: ReadonlySet<string>;
}

export interface EnsuredSignedPrekey {
  readonly record: SignedPrekeyRecord;
  readonly rotated: boolean;
  readonly destroyed: readonly string[];
}

/** Installs an SPK when missing/30 days old/expired, keeping F2 retention. */
export async function ensureSignedPrekey(
  storage: E2eeStorage,
  identity: LoadedDeviceIdentity,
  options: EnsureSignedPrekeyOptions = {},
): Promise<EnsuredSignedPrekey> {
  const now = options.now ?? Date.now();
  const current = await getCurrentSignedPrekey(storage);
  const due =
    options.force === true ||
    current === null ||
    now >= current.expiresAt ||
    now - current.createdAt >= SPK_ROTATION_INTERVAL_MS;
  if (!due && current !== null) {
    return { record: current, rotated: false, destroyed: [] };
  }
  const record = await createSignedPrekeyRecord(identity, { now, keyId: options.keyId });
  try {
    const rotation = await rotateSignedPrekey(storage, record, {
      now,
      activeSessionSpkIds: options.activeSessionSpkIds,
    });
    return { record: rotation.current, rotated: true, destroyed: rotation.destroyed };
  } catch (error) {
    if (isE2eeError(error)) throw error;
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'signed prekey rotation failed');
  }
}

export interface EnsureOneTimePrekeysOptions {
  readonly now?: number;
  readonly target?: number;
  readonly lowWater?: number;
  readonly max?: number;
  readonly idFactory?: PrekeyIdFactory;
}

export interface EnsuredOneTimePrekeys {
  readonly created: readonly OneTimePrekeyRecord[];
  readonly available: number;
}

/**
 * Low-water replenishment. The count is re-checked inside the write
 * transaction, so two tabs replenishing concurrently cannot overshoot the cap
 * or duplicate a key id.
 */
export async function ensureOneTimePrekeys(
  storage: E2eeStorage,
  options: EnsureOneTimePrekeysOptions = {},
): Promise<EnsuredOneTimePrekeys> {
  const now = options.now ?? Date.now();
  const max = Math.min(options.max ?? DEFAULT_OPK_MAX, DEFAULT_OPK_MAX);
  const target = Math.min(options.target ?? DEFAULT_OPK_TARGET, max);
  const lowWater = Math.min(options.lowWater ?? DEFAULT_OPK_LOW_WATER, target);
  if (target < 0 || lowWater < 0 || max < 1) {
    throw invalid('INVALID_KEY', 'one-time prekey limits are invalid');
  }
  const factory = validateKeyIdFactory(options.idFactory ?? defaultPrekeyIdFactory);

  await pruneExpiredOneTimePrekeys(storage, now);
  const available = await countAvailableOneTimePrekeys(storage, now);
  if (available >= lowWater) return { created: [], available };

  const desired = Math.min(target - available, max - available);
  if (desired <= 0) return { created: [], available };

  const candidates: OneTimePrekeyRecord[] = [];
  for (let index = 0; index < desired; index += 1) {
    const keyId = requireKeyId(factory.oneTimePrekeyId(index), 'one_time_prekey.key_id');
    candidates.push(await createOneTimePrekeyRecord(keyId, now));
  }

  const created = await storage.transact(['prekeys'], 'readwrite', async (transaction) => {
    const currentAvailable = await countAvailableOneTimePrekeysInTransaction(transaction, now);
    if (currentAvailable >= lowWater) return [];
    const allowed = Math.min(candidates.length, max - currentAvailable, target - currentAvailable);
    const inserted: OneTimePrekeyRecord[] = [];
    for (const candidate of candidates.slice(0, Math.max(0, allowed))) {
      try {
        await putOneTimePrekeyInTransaction(transaction, candidate);
        inserted.push(candidate);
      } catch (error) {
        // A key-id collision must never overwrite a key; skip this candidate.
        if (isE2eeError(error) && error.code === 'INVALID_KEY') continue;
        throw error;
      }
    }
    return inserted;
  });

  return { created, available: available + created.length };
}

export function toWireSignedPrekey(record: SignedPrekeyRecord) {
  return {
    key_id: record.keyId,
    public_key: record.publicKey,
    signature: record.signature,
  };
}

export function toWireOneTimePrekey(record: OneTimePrekeyRecord) {
  return { key_id: record.keyId, public_key: record.publicKey };
}

/** All unexpired OPK publics that may be sent on registration (max 200). */
export async function registrationOneTimePrekeys(
  storage: E2eeStorage,
  now = Date.now(),
): Promise<readonly OneTimePrekeyRecord[]> {
  const records = await listOneTimePrekeys(storage);
  return records.filter((record) => now <= record.expiresAt).slice(0, DEFAULT_OPK_MAX);
}

export async function readPendingPrekeyUpload(
  storage: E2eeStorage,
): Promise<PendingPrekeyUpload | null> {
  const value = await storage.get<PendingPrekeyUpload>('keys', PENDING_PREKEY_UPLOAD_KEY);
  if (value === null) return null;
  if (value.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending prekey upload version is unsupported');
  }
  if (!isUuid(value.deviceId)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending prekey upload device_id is invalid');
  }
  requireKeyGeneration(value.keyGeneration);
  if (!isUuid(value.idempotencyKey)) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'pending prekey upload idempotency key is invalid',
    );
  }
  if (value.spkKeyId !== null) requireKeyId(value.spkKeyId, 'pending spk_id');
  if (!Array.isArray(value.opkIds)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending prekey upload opk ids are invalid');
  }
  for (const id of value.opkIds) requireKeyId(id, 'pending opk_id');
  const body = value.body;
  if (typeof body !== 'object' || body === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending prekey upload body is invalid');
  }
  if (body.signed_prekey !== undefined) {
    requireKeyId(body.signed_prekey.key_id, 'pending signed_prekey.key_id');
  }
  const bodyOpkIds = (body.one_time_prekeys ?? []).map((prekey) => prekey.key_id);
  if (bodyOpkIds.length !== value.opkIds.length) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending prekey upload ids are inconsistent');
  }
  for (const id of bodyOpkIds) requireKeyId(id, 'pending one_time_prekey.key_id');
  return value;
}

async function pendingPrekeyUploadIsUsable(
  storage: E2eeStorage,
  pending: PendingPrekeyUpload,
  identity: LoadedDeviceIdentity,
): Promise<boolean> {
  const record = identity.record;
  if (record.deviceId === null || pending.deviceId !== record.deviceId) return false;
  if (pending.keyGeneration !== record.keyGeneration) return false;
  if (pending.spkKeyId === null && pending.opkIds.length === 0) return false;
  const current = await getCurrentSignedPrekey(storage);
  if (pending.spkKeyId !== null && current?.keyId !== pending.spkKeyId) return false;
  for (const keyId of pending.opkIds) {
    if ((await getOneTimePrekey(storage, keyId)) === null) return false;
  }
  return true;
}

export interface PreparePrekeyUploadOptions {
  readonly now?: number;
  readonly idFactory?: PrekeyIdFactory;
  readonly opkTarget?: number;
  readonly opkLowWater?: number;
  readonly opkMax?: number;
  readonly activeSessionSpkIds?: ReadonlySet<string>;
  readonly idempotencyKey?: string;
  /** `false` discards a reusable pending body and re-plans (tests/recovery). */
  readonly reusePending?: boolean;
}

function assertIdentityCanUpload(identity: LoadedDeviceIdentity): string {
  const record = identity.record;
  if (record.deviceId === null || record.state === 'unregistered') {
    throw new E2eeError('DEVICE_NOT_REGISTERED', 'device is not registered');
  }
  if (record.state === 'revoked') {
    throw new E2eeError('KEY_CHANGE_DETECTED', 'device identity was revoked');
  }
  if (record.state === 'conflict') {
    throw new E2eeError(
      'DEVICE_IDENTITY_CONFLICT',
      'device identity is already registered elsewhere',
    );
  }
  if (record.state === 'legacy') {
    throw new E2eeError('DEVICE_IDENTITY_INVALID', 'legacy devices cannot upload prekeys');
  }
  if (record.state === 'invalid') {
    throw new E2eeError('DEVICE_IDENTITY_INVALID', 'device identity was rejected by the server');
  }
  return record.deviceId;
}

/**
 * Decides whether an upload is needed and returns the exact body + idempotency
 * key. Nothing is uploaded here; the caller uses the transport adapter.
 */
export async function preparePrekeyUpload(
  storage: E2eeStorage,
  identity: LoadedDeviceIdentity,
  options: PreparePrekeyUploadOptions = {},
): Promise<PrekeyUploadPlan> {
  const deviceId = assertIdentityCanUpload(identity);
  const now = options.now ?? Date.now();

  const pending = await readPendingPrekeyUpload(storage);
  if (pending !== null) {
    if (
      options.reusePending !== false &&
      (await pendingPrekeyUploadIsUsable(storage, pending, identity))
    ) {
      return {
        kind: 'upload',
        pending,
        availableOpks: await countAvailableOneTimePrekeys(storage, now),
      };
    }
    await storage.delete('keys', PENDING_PREKEY_UPLOAD_KEY);
  }

  const activeSessionSpkIds =
    options.activeSessionSpkIds ?? (await collectActiveSessionSpkIds(storage));
  const spk = await ensureSignedPrekey(storage, identity, {
    now,
    activeSessionSpkIds,
    keyId: options.idFactory?.signedPrekeyId(now),
  });
  const opks = await ensureOneTimePrekeys(storage, {
    now,
    target: options.opkTarget ?? DEFAULT_OPK_TARGET,
    lowWater: options.opkLowWater ?? DEFAULT_OPK_LOW_WATER,
    max: options.opkMax ?? DEFAULT_OPK_MAX,
    idFactory: options.idFactory ?? defaultPrekeyIdFactory,
  });

  if (!spk.rotated && opks.created.length === 0) {
    return { kind: 'sufficient', availableOpks: opks.available };
  }

  const body: PendingPrekeyUpload['body'] = {};
  if (spk.rotated) body.signed_prekey = toWireSignedPrekey(spk.record);
  if (opks.created.length > 0) {
    body.one_time_prekeys = opks.created.map(toWireOneTimePrekey);
  }

  const idempotencyKey = options.idempotencyKey ?? randomUuid();
  if (!isUuid(idempotencyKey)) {
    throw invalid('INVALID_ENCODING', 'idempotency key must be a canonical UUID');
  }
  const next: PendingPrekeyUpload = {
    v: 1,
    deviceId,
    keyGeneration: identity.record.keyGeneration,
    idempotencyKey,
    body,
    spkKeyId: spk.rotated ? spk.record.keyId : null,
    opkIds: opks.created.map((record) => record.keyId),
    createdAt: now,
  };
  await storage.put('keys', PENDING_PREKEY_UPLOAD_KEY, next);
  return {
    kind: 'upload',
    pending: next,
    availableOpks: opks.available,
  };
}

export interface CompletePrekeyUploadOptions {
  readonly now?: number;
}

export async function completePrekeyUpload(
  storage: E2eeStorage,
  identity: LoadedDeviceIdentity,
  pending: PendingPrekeyUpload,
  result: {
    readonly device_id: string;
    readonly key_generation: number;
    readonly signed_prekey_id?: string | null;
    readonly one_time_prekeys_stored?: number;
    readonly one_time_prekeys_available: number;
    readonly one_time_prekeys_limit?: 200;
  },
  _options: CompletePrekeyUploadOptions = {},
): Promise<PrekeyUploadResultSummary> {
  assertIdentityCanUpload(identity);
  if (!isUuid(result.device_id) || result.device_id !== pending.deviceId) {
    throw new E2eeError('INVALID_RESPONSE', 'prekey upload response device_id does not match');
  }
  const keyGeneration = requireKeyGeneration(result.key_generation);
  if (keyGeneration !== identity.record.keyGeneration) {
    throw new E2eeError('KEY_GENERATION_STALE', 'device key generation changed during upload');
  }
  if (result.signed_prekey_id !== undefined && result.signed_prekey_id !== null) {
    requireKeyId(result.signed_prekey_id, 'response signed_prekey_id');
  }
  if (pending.spkKeyId !== null && result.signed_prekey_id !== pending.spkKeyId) {
    throw new E2eeError('INVALID_RESPONSE', 'server did not confirm the uploaded signed prekey');
  }
  if (result.one_time_prekeys_stored !== undefined) {
    if (
      !Number.isInteger(result.one_time_prekeys_stored) ||
      result.one_time_prekeys_stored < 0 ||
      result.one_time_prekeys_stored > DEFAULT_OPK_MAX ||
      result.one_time_prekeys_stored > pending.opkIds.length
    ) {
      throw new E2eeError('INVALID_RESPONSE', 'one_time_prekeys_stored is out of range');
    }
  }
  if (
    !Number.isInteger(result.one_time_prekeys_available) ||
    result.one_time_prekeys_available < 0 ||
    result.one_time_prekeys_available > DEFAULT_OPK_MAX
  ) {
    throw new E2eeError('INVALID_RESPONSE', 'one_time_prekeys_available is out of range');
  }
  if (
    result.one_time_prekeys_limit !== undefined &&
    result.one_time_prekeys_limit !== DEFAULT_OPK_MAX
  ) {
    throw new E2eeError('INVALID_RESPONSE', 'one_time_prekeys_limit must be 200');
  }
  await storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<PendingPrekeyUpload>('keys', PENDING_PREKEY_UPLOAD_KEY);
    if (current !== null && current.idempotencyKey === pending.idempotencyKey) {
      await transaction.delete('keys', PENDING_PREKEY_UPLOAD_KEY);
    }
  });

  return {
    status: 'uploaded',
    availableOpks: result.one_time_prekeys_available,
    storedOpks: result.one_time_prekeys_stored ?? 0,
    spkKeyId: pending.spkKeyId,
  };
}

export interface MutatePrekeyOptions extends PreparePrekeyUploadOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function retryDelay(error: unknown, attempt: number, options: MutatePrekeyOptions): number {
  const base = options.baseDelayMs ?? 250;
  const cap = options.maxDelayMs ?? 4_000;
  const exponential = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  if (isDeviceTransportError(error) && error.retryAfterSeconds !== undefined) {
    return Math.max(exponential, Math.min(cap, error.retryAfterSeconds * 1_000));
  }
  return exponential;
}

async function markPrekeyFailure(storage: E2eeStorage, error: unknown): Promise<void> {
  if (!isDeviceTransportError(error)) return;
  if (error.kind === 'legacy_device') {
    await markDeviceIdentityState(storage, 'legacy');
  } else if (error.kind === 'device_revoked') {
    await markDeviceIdentityState(storage, 'revoked');
  } else if (error.kind === 'identity_key_conflict') {
    await markDeviceIdentityState(storage, 'conflict');
  } else if (error.kind === 'invalid_identity_binding' || error.kind === 'invalid_spk_signature') {
    await markDeviceIdentityState(storage, 'invalid');
  }
}

/**
 * Uploads the planned prekey batch. Retries reuse the exact same body and
 * `Idempotency-Key` (§4.6); keys are never regenerated between attempts.
 */
export async function uploadPrekeys(
  storage: E2eeStorage,
  identity: LoadedDeviceIdentity,
  transport: PrekeyUploadTransport,
  options: MutatePrekeyOptions = {},
): Promise<PrekeyUploadResultSummary> {
  const plan = await preparePrekeyUpload(storage, identity, options);
  if (plan.kind === 'sufficient') {
    return {
      status: 'sufficient',
      availableOpks: plan.availableOpks,
      storedOpks: 0,
      spkKeyId: null,
    };
  }
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await transport.uploadPrekeys(
        plan.pending.deviceId,
        plan.pending.body,
        plan.pending.idempotencyKey,
      );
      return await completePrekeyUpload(storage, identity, plan.pending, result);
    } catch (error) {
      const retryable = isRetryableDeviceTransportError(error);
      if (!retryable || attempt >= maxAttempts) {
        await markPrekeyFailure(storage, error);
        throw error;
      }
      await sleep(retryDelay(error, attempt, options));
    }
  }
}

export const replenishPrekeys = uploadPrekeys;

export async function discardPendingPrekeyUpload(storage: E2eeStorage): Promise<void> {
  await storage.delete('keys', PENDING_PREKEY_UPLOAD_KEY);
}

/**
 * Device identity pair provisioning and storage (§2.1–§2.3, §3.1).
 *
 * IK_sig (Ed25519) signs the SPK, the prekey preamble and the identity-binding
 * self-signature; IK_dh (X25519) is the long-term DH key. Both private keys are
 * persisted as non-extractable `CryptoKey`s. Loading verifies, in addition to
 * the public binding signature, that each stored private key actually matches
 * the recorded public key, so a swapped/corrupted private key is refused rather
 * than silently used.
 */
import { KEY_BYTES, MAX_KEY_GENERATION, SIGNATURE_BYTES, UUID_BYTES } from '../constants';
import { E2eeError, invalid } from '../errors';
import { areBytesEqual, bytesToHex, isUuid, utf8, zeroBytes } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { randomBytes } from '../crypto/random';
import {
  ed25519Sign,
  generateEd25519KeyPair,
  ed25519Verify,
  type Ed25519KeyPair,
} from '../crypto/ed25519';
import {
  generateX25519KeyPair,
  importX25519PublicKey,
  x25519SharedSecret,
  type X25519KeyPair,
} from '../crypto/x25519';
import { assertPrivateKey } from '../crypto/keyGuards';
import { signIdentityBinding, verifyIdentityBinding } from '../protocol/signatures';
import { deviceFingerprint } from '../verification/fingerprint';
import { E2EE_STORE_NAMES, type E2eeStorage } from '../storage/types';
import type {
  DeviceIdentityRecord,
  DeviceIdentityState,
  LoadedDeviceIdentity,
  PendingDeviceRegistration,
} from './types';

export const DEVICE_IDENTITY_RECORD_KEY = 'identity:v1';
export const DEVICE_IDENTITY_SIGNING_KEY = 'ik-sig:private:v1';
export const DEVICE_IDENTITY_DH_KEY = 'ik-dh:private:v1';
export const PENDING_DEVICE_REGISTRATION_KEY = 'device-registration:pending:v1';

const PRIVATE_KEY_CHECK_MESSAGE = utf8('Krug/E2EE/v1/device-key-check');
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEVICE_IDENTITY_STATES: ReadonlySet<string> = new Set<DeviceIdentityState>([
  'unregistered',
  'registered',
  'revoked',
  'conflict',
  'legacy',
  'invalid',
]);

/** UUID v4 from the CSPRNG (no `Math.random` fallback inside E2EE). */
export function randomUuid(): string {
  const bytes = randomBytes(UUID_BYTES);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(
    16,
    20,
  )}-${hex.slice(20)}`;
}

export function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw invalid('INVALID_KEY', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireKeyGeneration(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_KEY_GENERATION) {
    throw invalid('INVALID_KEY', 'key_generation is out of range');
  }
  return value;
}

function decodeKey(value: string, label: string): Uint8Array {
  try {
    return decodeBase64Url(value, KEY_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be canonical b64u32`);
  }
}

function decodeSignature(value: string, label: string): Uint8Array {
  try {
    return decodeBase64Url(value, SIGNATURE_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be canonical b64u64`);
  }
}

export function validateDeviceIdentityRecord(value: unknown): DeviceIdentityRecord {
  if (typeof value !== 'object' || value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity record is not an object');
  }
  const record = value as Partial<DeviceIdentityRecord>;
  if (record.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity record version is unsupported');
  }
  if (record.userId !== null && !isUuid(record.userId)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity user_id is malformed');
  }
  if (record.deviceId !== null && !isUuid(record.deviceId)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity device_id is malformed');
  }
  if (typeof record.identitySigningKey !== 'string') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity signing key is missing');
  }
  if (typeof record.identityDhKey !== 'string') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity DH key is missing');
  }
  if (typeof record.identityBindingSignature !== 'string') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity binding signature is missing');
  }
  if (typeof record.fingerprint !== 'string') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity fingerprint is missing');
  }
  if (!Number.isInteger(record.keyGeneration)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity key_generation is invalid');
  }
  const keyGeneration = requireKeyGeneration(record.keyGeneration ?? 0);
  if (record.state === undefined || !DEVICE_IDENTITY_STATES.has(record.state)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity state is invalid');
  }
  if (!Number.isInteger(record.createdAt) || (record.createdAt ?? -1) < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity createdAt is invalid');
  }
  if (record.registeredAt !== null) {
    if (!Number.isInteger(record.registeredAt) || (record.registeredAt ?? -1) < 0) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity registeredAt is invalid');
    }
  }
  return { ...(record as DeviceIdentityRecord), keyGeneration };
}

async function readRecord(storage: E2eeStorage): Promise<DeviceIdentityRecord | null> {
  const value = await storage.get<DeviceIdentityRecord>('keys', DEVICE_IDENTITY_RECORD_KEY);
  return value === null ? null : validateDeviceIdentityRecord(value);
}

/** Public-record-only read (no private-key checks) for storage scoping. */
export async function loadDeviceIdentityRecord(
  storage: E2eeStorage,
): Promise<DeviceIdentityRecord | null> {
  return readRecord(storage);
}

async function assertEd25519PairMatches(
  privateKey: CryptoKey,
  publicKeyBytes: Uint8Array,
): Promise<void> {
  const signature = await ed25519Sign(privateKey, PRIVATE_KEY_CHECK_MESSAGE);
  const verified = await ed25519Verify(publicKeyBytes, PRIVATE_KEY_CHECK_MESSAGE, signature);
  if (!verified) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'stored signing key does not match its public key',
    );
  }
}

/**
 * X25519 has no "derive public from private" API for non-extractable keys.
 * DH symmetry proves the pairing: `DH(priv, E_pub) == DH(E_priv, pub)`.
 */
async function assertX25519PairMatches(
  privateKey: CryptoKey,
  publicKeyBytes: Uint8Array,
): Promise<void> {
  const ephemeral = await generateX25519KeyPair();
  const peerPublic = await importX25519PublicKey(publicKeyBytes);
  const [left, right] = await Promise.all([
    x25519SharedSecret(privateKey, ephemeral.publicKey),
    x25519SharedSecret(ephemeral.privateKey, peerPublic),
  ]);
  try {
    if (!areBytesEqual(left, right)) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored DH key does not match its public key');
    }
  } finally {
    zeroBytes(left, right);
  }
}

async function loadPrivateKey(
  storage: E2eeStorage,
  key: string,
  label: string,
): Promise<CryptoKey> {
  const value = await storage.get<CryptoKey>('keys', key);
  if (value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is missing`);
  }
  try {
    return assertPrivateKey(value, label);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a non-extractable key`);
  }
}

export interface LoadDeviceIdentityOptions {
  /**
   * Currently authenticated user. Required (CR1c P1-04): `null` is only for an
   * identity created before authentication (one-time bound later). A persisted
   * identity bound to another user is rejected with
   * `DEVICE_IDENTITY_MISMATCH` before any private key is used.
   */
  readonly userId: string | null;
}

/**
 * Loads and fully validates the local identity. A malformed or tampered record
 * is a hard `KEY_STORAGE_UNAVAILABLE`; it never silently regenerates keys. The
 * optional `userId` is the account-scope check: an identity bound to another
 * user is never handed out.
 */
export async function loadDeviceIdentity(
  storage: E2eeStorage,
  options: LoadDeviceIdentityOptions,
): Promise<LoadedDeviceIdentity | null> {
  if (options === undefined || options.userId === undefined) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity scope must name the account');
  }
  const record = await readRecord(storage);
  if (record === null) return null;
  assertIdentityUser(record, options.userId);
  try {
    const signingPublic = decodeKey(record.identitySigningKey, 'identity_signing_key');
    const dhPublic = decodeKey(record.identityDhKey, 'identity_dh_key');
    const bindingSignature = decodeSignature(
      record.identityBindingSignature,
      'identity_binding_signature',
    );
    const fingerprint = await deviceFingerprint(signingPublic, dhPublic);
    if (encodeBase64Url(fingerprint) !== record.fingerprint) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity fingerprint is inconsistent');
    }
    const bindingValid = await verifyIdentityBinding(
      signingPublic,
      dhPublic,
      signingPublic,
      bindingSignature,
    );
    if (!bindingValid) {
      throw new E2eeError(
        'KEY_STORAGE_UNAVAILABLE',
        'device identity binding signature is invalid',
      );
    }
    const signingPrivateKey = await loadPrivateKey(
      storage,
      DEVICE_IDENTITY_SIGNING_KEY,
      'identity signing private key',
    );
    const dhPrivateKey = await loadPrivateKey(
      storage,
      DEVICE_IDENTITY_DH_KEY,
      'identity DH private key',
    );
    await assertEd25519PairMatches(signingPrivateKey, signingPublic);
    await assertX25519PairMatches(dhPrivateKey, dhPublic);
    return { record, signingPrivateKey, dhPrivateKey };
  } catch (error) {
    if (error instanceof E2eeError && error.code === 'KEY_STORAGE_UNAVAILABLE') throw error;
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity material is inconsistent');
  }
}

export interface CreateDeviceIdentityOptions {
  readonly userId?: string | null;
  readonly now?: number;
}

function identityRecordFromPair(
  signingPair: Ed25519KeyPair,
  dhPair: X25519KeyPair,
  bindingSignature: Uint8Array,
  fingerprint: Uint8Array,
  options: CreateDeviceIdentityOptions,
): DeviceIdentityRecord {
  const userId = options.userId ?? null;
  if (userId !== null) requireUuid(userId, 'user_id');
  return {
    v: 1,
    userId,
    deviceId: null,
    identitySigningKey: encodeBase64Url(signingPair.publicKeyBytes),
    identityDhKey: encodeBase64Url(dhPair.publicKeyBytes),
    identityBindingSignature: encodeBase64Url(bindingSignature),
    fingerprint: encodeBase64Url(fingerprint),
    keyGeneration: 1,
    state: 'unregistered',
    createdAt: options.now ?? Date.now(),
    registeredAt: null,
  };
}

/**
 * Creates the identity exactly once. Two tabs racing at first launch converge
 * on the record created inside one storage transaction; the loser discards its
 * freshly generated key pairs.
 */
export async function createDeviceIdentity(
  storage: E2eeStorage,
  options: CreateDeviceIdentityOptions = {},
): Promise<LoadedDeviceIdentity> {
  const existing = await loadDeviceIdentity(storage, { userId: options.userId ?? null });
  if (existing) {
    assertIdentityUser(existing.record, options.userId ?? null);
    return existing;
  }

  const [signingPair, dhPair] = await Promise.all([
    generateEd25519KeyPair(),
    generateX25519KeyPair(),
  ]);
  const bindingSignature = await signIdentityBinding(
    signingPair.privateKey,
    dhPair.publicKeyBytes,
    signingPair.publicKeyBytes,
  );
  const fingerprint = await deviceFingerprint(signingPair.publicKeyBytes, dhPair.publicKeyBytes);
  const record = identityRecordFromPair(
    signingPair,
    dhPair,
    bindingSignature,
    fingerprint,
    options,
  );

  const created = await storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<DeviceIdentityRecord>('keys', DEVICE_IDENTITY_RECORD_KEY);
    if (current !== null) {
      const validated = validateDeviceIdentityRecord(current);
      assertIdentityUser(validated, options.userId ?? null);
      return false;
    }
    assertPrivateKey(signingPair.privateKey, 'identity signing private key');
    assertPrivateKey(dhPair.privateKey, 'identity DH private key');
    await transaction.put('keys', DEVICE_IDENTITY_SIGNING_KEY, signingPair.privateKey);
    await transaction.put('keys', DEVICE_IDENTITY_DH_KEY, dhPair.privateKey);
    await transaction.put('keys', DEVICE_IDENTITY_RECORD_KEY, record);
    return true;
  });

  if (!created) {
    const winner = await loadDeviceIdentity(storage, { userId: options.userId ?? null });
    if (!winner) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity creation raced and lost');
    }
    return winner;
  }
  return { record, signingPrivateKey: signingPair.privateKey, dhPrivateKey: dhPair.privateKey };
}

function assertIdentityUser(record: DeviceIdentityRecord, userId: string | null): void {
  if (userId === null) return;
  requireUuid(userId, 'user_id');
  if (record.userId !== null && record.userId !== userId) {
    throw new E2eeError(
      'DEVICE_IDENTITY_MISMATCH',
      'stored device identity belongs to a different user',
    );
  }
}

/** Binds a freshly created identity to the authenticated user (§5.1). */
export async function bindDeviceIdentityUser(
  storage: E2eeStorage,
  userId: string,
): Promise<DeviceIdentityRecord> {
  requireUuid(userId, 'user_id');
  return storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<DeviceIdentityRecord>('keys', DEVICE_IDENTITY_RECORD_KEY);
    if (current === null) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity is missing');
    }
    const record = validateDeviceIdentityRecord(current);
    if (record.userId !== null && record.userId !== userId) {
      throw new E2eeError(
        'DEVICE_IDENTITY_MISMATCH',
        'stored device identity belongs to a different user',
      );
    }
    if (record.userId === userId) return record;
    const updated: DeviceIdentityRecord = { ...record, userId };
    await transaction.put('keys', DEVICE_IDENTITY_RECORD_KEY, updated);
    return updated;
  });
}

const MUTABLE_STATES: ReadonlySet<DeviceIdentityState> = new Set([
  'unregistered',
  'registered',
  'revoked',
  'conflict',
  'legacy',
  'invalid',
]);

export async function markDeviceIdentityState(
  storage: E2eeStorage,
  state: DeviceIdentityState,
): Promise<DeviceIdentityRecord> {
  if (!MUTABLE_STATES.has(state)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown device identity state');
  }
  return storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<DeviceIdentityRecord>('keys', DEVICE_IDENTITY_RECORD_KEY);
    if (current === null) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity is missing');
    }
    const record = validateDeviceIdentityRecord(current);
    if (record.state === state) return record;
    const updated: DeviceIdentityRecord = { ...record, state };
    await transaction.put('keys', DEVICE_IDENTITY_RECORD_KEY, updated);
    return updated;
  });
}

export interface RegistrationUpdate {
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly userId?: string | null;
  readonly now?: number;
}

/** Commits the server-assigned device id and generation, clearing the pending body. */
export async function commitDeviceRegistration(
  storage: E2eeStorage,
  update: RegistrationUpdate,
): Promise<DeviceIdentityRecord> {
  requireUuid(update.deviceId, 'device_id');
  requireKeyGeneration(update.keyGeneration);
  const userId = update.userId ?? null;
  if (userId !== null) requireUuid(userId, 'user_id');
  const now = update.now ?? Date.now();

  return storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<DeviceIdentityRecord>('keys', DEVICE_IDENTITY_RECORD_KEY);
    if (current === null) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device identity is missing');
    }
    const record = validateDeviceIdentityRecord(current);
    if (record.deviceId !== null && record.deviceId !== update.deviceId) {
      throw new E2eeError(
        'DEVICE_IDENTITY_MISMATCH',
        'server assigned a different device id for this identity',
      );
    }
    if (record.userId !== null && userId !== null && record.userId !== userId) {
      throw new E2eeError(
        'DEVICE_IDENTITY_MISMATCH',
        'device registration response belongs to a different user',
      );
    }
    if (record.state === 'revoked' || record.state === 'conflict') {
      throw new E2eeError('KEY_CHANGE_DETECTED', 'device identity is no longer registrable');
    }
    const updated: DeviceIdentityRecord = {
      ...record,
      userId: record.userId ?? userId,
      deviceId: update.deviceId,
      keyGeneration: update.keyGeneration,
      state: 'registered',
      registeredAt: record.registeredAt ?? now,
    };
    await transaction.put('keys', DEVICE_IDENTITY_RECORD_KEY, updated);
    await transaction.delete('keys', PENDING_DEVICE_REGISTRATION_KEY);
    return updated;
  });
}

export async function readPendingDeviceRegistration(
  storage: E2eeStorage,
): Promise<PendingDeviceRegistration | null> {
  const value = await storage.get<PendingDeviceRegistration>(
    'keys',
    PENDING_DEVICE_REGISTRATION_KEY,
  );
  if (value === null) return null;
  if (value.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending registration version is unsupported');
  }
  if (!isUuid(value.idempotencyKey)) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'pending registration idempotency key is invalid',
    );
  }
  if (value.userId !== null && !isUuid(value.userId)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending registration user_id is invalid');
  }
  if (typeof value.body !== 'object' || value.body === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pending registration body is invalid');
  }
  return value;
}

export async function writePendingDeviceRegistration(
  storage: E2eeStorage,
  pending: PendingDeviceRegistration,
): Promise<void> {
  await storage.put('keys', PENDING_DEVICE_REGISTRATION_KEY, pending);
}

export async function clearPendingDeviceRegistration(storage: E2eeStorage): Promise<void> {
  await storage.delete('keys', PENDING_DEVICE_REGISTRATION_KEY);
}

/**
 * Destroys every account-scoped E2EE record in one transaction (CR1b P1-04):
 * `keys` (identity, `K_storage`, pending registration/upload), `prekeys`,
 * `pins`, `sessions`, `outbox` and `localMessages`. Clearing all stores — not
 * only the key material — means a logout leaves no sealed ciphertext, no
 * pending envelopes and no local message copies for the next account.
 *
 * This is the explicit full-wipe path (tests/factory reset); the production
 * logout hook uses the account/device-scoped wipe from `account/scope.ts` so a
 * second account in the same origin profile is not destroyed (E7-F5F). The
 * caller is expected to close the storage afterwards.
 */
export async function destroyDeviceIdentity(storage: E2eeStorage): Promise<void> {
  await storage.transact([...E2EE_STORE_NAMES], 'readwrite', async (transaction) => {
    for (const store of E2EE_STORE_NAMES) {
      for (const key of await transaction.keys(store)) {
        await transaction.delete(store, key);
      }
    }
  });
}

/**
 * Full-wipe alias retained for explicit reset/tests. Production logout calls
 * `clearE2eeAccountScope` (account/scope.ts) instead.
 */
export const clearDeviceE2eeAccountState = destroyDeviceIdentity;

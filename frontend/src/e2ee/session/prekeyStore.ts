/**
 * One-time and signed prekey storage (§2.3, §3.4.5.1).
 *
 * Invariants enforced here, not in the future send/receive code:
 * - an OPK private key is consumed (read + delete) in exactly one transaction,
 *   so a replayed or concurrent first message cannot use it twice;
 * - a failed AEAD never reaches this transaction, so a failed decrypt keeps
 *   the OPK available (§3.4.5.1);
 * - at most `SPK_RETAIN_PRIVATE = 3` signed-prekey privates survive rotation and
 *   nothing older than the 90-day window survives. There is **no** shorter
 *   "unused" TTL: an SPK may have been handed out by a claim and still be
 *   needed by an undelivered prekey message, which the device cannot detect
 *   locally (CR1b P1-03).
 *
 * Private keys are non-extractable `CryptoKey`s in IndexedDB; raw public keys
 * and signatures are canonical b64u strings that may be uploaded.
 */
import {
  KEY_ID_PATTERN,
  KEY_BYTES,
  OPK_TTL_MS,
  SIGNATURE_BYTES,
  SPK_RETAIN_PRIVATE,
  SPK_RETAIN_WINDOW_MS,
  SPK_ROTATION_INTERVAL_MS,
} from '../constants';
import { E2eeError, invalid } from '../errors';
import { isUuid } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { assertPrivateKey } from '../crypto/keyGuards';
import { type E2eeStorage, type E2eeTransaction } from '../storage/types';

export interface OneTimePrekeyRecord {
  readonly v: 1;
  readonly keyId: string;
  readonly publicKey: string;
  readonly privateKey: CryptoKey;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface SignedPrekeyRecord {
  readonly v: 1;
  readonly keyId: string;
  readonly publicKey: string;
  readonly signature: string;
  readonly privateKey: CryptoKey;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly retiredAt: number | null;
}

export interface CurrentSignedPrekeyPointer {
  readonly v: 1;
  readonly keyId: string;
}

export interface ConsumedOneTimePrekey {
  readonly keyId: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: CryptoKey;
  readonly createdAt: number;
}

export interface SignedPrekeyRotationResult {
  readonly current: SignedPrekeyRecord;
  readonly retained: readonly SignedPrekeyRecord[];
  readonly destroyed: readonly string[];
}

const OPK_PREFIX = 'opk:';
const SPK_PREFIX = 'spk:';
const CURRENT_SPK_KEY = 'spk:current';

function requireKeyId(keyId: string, label: string): string {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a valid key id`);
  }
  return keyId;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a valid timestamp`);
  }
  return value;
}

function requirePublicKey(value: string, label: string): Uint8Array {
  try {
    return decodeBase64Url(value, KEY_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be canonical b64u32`);
  }
}

function requireSignature(value: string, label: string): Uint8Array {
  try {
    return decodeBase64Url(value, SIGNATURE_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be canonical b64u64`);
  }
}

function opkKey(keyId: string): string {
  return `${OPK_PREFIX}${keyId}`;
}

function spkKey(keyId: string): string {
  return `${SPK_PREFIX}${keyId}`;
}

function validateOneTimePrekey(record: OneTimePrekeyRecord): OneTimePrekeyRecord {
  if (record.v !== 1) throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'OPK version is unsupported');
  requireKeyId(record.keyId, 'opk_id');
  requirePublicKey(record.publicKey, 'OPK public key');
  assertPrivateKey(record.privateKey, 'OPK private key');
  const createdAt = requireTimestamp(record.createdAt, 'OPK createdAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'OPK expiresAt');
  if (expiresAt <= createdAt) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'OPK expiry must follow creation');
  }
  return record;
}

function validateSignedPrekey(record: SignedPrekeyRecord): SignedPrekeyRecord {
  if (record.v !== 1) throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'SPK version is unsupported');
  requireKeyId(record.keyId, 'spk_id');
  requirePublicKey(record.publicKey, 'SPK public key');
  requireSignature(record.signature, 'SPK signature');
  assertPrivateKey(record.privateKey, 'SPK private key');
  const createdAt = requireTimestamp(record.createdAt, 'SPK createdAt');
  const expiresAt = requireTimestamp(record.expiresAt, 'SPK expiresAt');
  if (record.retiredAt !== null) requireTimestamp(record.retiredAt, 'SPK retiredAt');
  if (expiresAt <= createdAt) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'SPK expiry must follow creation');
  }
  return record;
}

/**
 * Atomic insert used by E7-F3 provisioning. Existing `opk_id` is never
 * overwritten: a key id must not be reused, not even with the same bytes.
 */
export async function putOneTimePrekeyInTransaction(
  transaction: E2eeTransaction,
  record: OneTimePrekeyRecord,
): Promise<void> {
  validateOneTimePrekey(record);
  const existing = await transaction.get<OneTimePrekeyRecord>('prekeys', opkKey(record.keyId));
  if (existing !== null) {
    throw new E2eeError('INVALID_KEY', 'one-time prekey already exists');
  }
  await transaction.put('prekeys', opkKey(record.keyId), record);
}

export async function putOneTimePrekey(
  storage: E2eeStorage,
  record: OneTimePrekeyRecord,
): Promise<void> {
  await storage.transact(['prekeys'], 'readwrite', async (transaction) =>
    putOneTimePrekeyInTransaction(transaction, record),
  );
}

export async function getOneTimePrekey(
  storage: E2eeStorage,
  keyId: string,
): Promise<OneTimePrekeyRecord | null> {
  requireKeyId(keyId, 'opk_id');
  return storage.get<OneTimePrekeyRecord>('prekeys', opkKey(keyId));
}

export async function listOneTimePrekeys(storage: E2eeStorage): Promise<OneTimePrekeyRecord[]> {
  const keys = await storage.keys('prekeys');
  const records: OneTimePrekeyRecord[] = [];
  for (const key of keys) {
    if (!key.startsWith(OPK_PREFIX)) continue;
    const record = await storage.get<OneTimePrekeyRecord>('prekeys', key);
    if (record) records.push(validateOneTimePrekey(record));
  }
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

/** Read-only count inside an existing transaction (E7-F3 replenish race guard). */
export async function countAvailableOneTimePrekeysInTransaction(
  transaction: E2eeTransaction,
  now = Date.now(),
): Promise<number> {
  let available = 0;
  for (const key of await transaction.keys('prekeys')) {
    if (!key.startsWith(OPK_PREFIX)) continue;
    const record = await transaction.get<OneTimePrekeyRecord>('prekeys', key);
    if (record === null) continue;
    validateOneTimePrekey(record);
    if (now <= record.expiresAt) available += 1;
  }
  return available;
}

export async function countAvailableOneTimePrekeys(
  storage: E2eeStorage,
  now = Date.now(),
): Promise<number> {
  const records = await listOneTimePrekeys(storage);
  return records.filter((record) => now <= record.expiresAt).length;
}

/**
 * Atomic read+delete. Must be called in the *same* transaction that persists
 * the successfully decrypted first message and the shifted session state.
 */
export async function consumeOneTimePrekeyInTransaction(
  transaction: E2eeTransaction,
  keyId: string,
  now = Date.now(),
): Promise<ConsumedOneTimePrekey> {
  requireKeyId(keyId, 'opk_id');
  const storageKey = opkKey(keyId);
  const record = await transaction.get<OneTimePrekeyRecord>('prekeys', storageKey);
  if (record === null) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'one-time prekey is unknown or already used');
  }
  validateOneTimePrekey(record);
  await transaction.delete('prekeys', storageKey);
  if (now > record.expiresAt) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'one-time prekey has expired');
  }
  return {
    keyId: record.keyId,
    publicKey: requirePublicKey(record.publicKey, 'OPK public key'),
    privateKey: record.privateKey,
    createdAt: record.createdAt,
  };
}

export async function consumeOneTimePrekey(
  storage: E2eeStorage,
  keyId: string,
  now = Date.now(),
): Promise<ConsumedOneTimePrekey> {
  return storage.transact(['prekeys'], 'readwrite', async (transaction) =>
    consumeOneTimePrekeyInTransaction(transaction, keyId, now),
  );
}

export async function pruneExpiredOneTimePrekeys(
  storage: E2eeStorage,
  now = Date.now(),
): Promise<string[]> {
  const destroyed: string[] = [];
  await storage.transact(['prekeys'], 'readwrite', async (transaction) => {
    const keys = await transaction.keys('prekeys');
    for (const key of keys) {
      if (!key.startsWith(OPK_PREFIX)) continue;
      const record = await transaction.get<OneTimePrekeyRecord>('prekeys', key);
      if (record === null) continue;
      validateOneTimePrekey(record);
      if (now > record.expiresAt) {
        await transaction.delete('prekeys', key);
        destroyed.push(record.keyId);
      }
    }
  });
  return destroyed;
}

async function readCurrentPointer(
  transaction: E2eeTransaction,
): Promise<CurrentSignedPrekeyPointer | null> {
  const pointer = await transaction.get<CurrentSignedPrekeyPointer>('prekeys', CURRENT_SPK_KEY);
  if (pointer === null) return null;
  if (pointer.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'current SPK pointer is malformed');
  }
  requireKeyId(pointer.keyId, 'current spk_id');
  return pointer;
}

export async function getCurrentSignedPrekey(
  storage: E2eeStorage,
): Promise<SignedPrekeyRecord | null> {
  const pointer = await storage.get<CurrentSignedPrekeyPointer>('prekeys', CURRENT_SPK_KEY);
  if (pointer === null) return null;
  if (pointer.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'current SPK pointer is malformed');
  }
  const record = await storage.get<SignedPrekeyRecord>('prekeys', spkKey(pointer.keyId));
  return record ? validateSignedPrekey(record) : null;
}

export async function getSignedPrekey(
  storage: E2eeStorage,
  keyId: string,
): Promise<SignedPrekeyRecord | null> {
  requireKeyId(keyId, 'spk_id');
  const record = await storage.get<SignedPrekeyRecord>('prekeys', spkKey(keyId));
  return record ? validateSignedPrekey(record) : null;
}

export async function listSignedPrekeys(storage: E2eeStorage): Promise<SignedPrekeyRecord[]> {
  const keys = await storage.keys('prekeys');
  const records: SignedPrekeyRecord[] = [];
  for (const key of keys) {
    if (!key.startsWith(SPK_PREFIX) || key === CURRENT_SPK_KEY) continue;
    const record = await storage.get<SignedPrekeyRecord>('prekeys', key);
    if (record) records.push(validateSignedPrekey(record));
  }
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Installs `record` as current, retires the previous one, and destroys private
 * SPKs outside the normative retention: current + 2 previous, max 90 days.
 *
 * CR1b P1-03: `activeSessionSpkIds` is accepted for telemetry/compatibility but
 * must not shorten retention. A claimed-but-undelivered prekey message has no
 * local session yet, so "unused" cannot be distinguished from "still in
 * flight"; destroying such an SPK would break `SPK_RETAIN_WINDOW` (90 days).
 */
export async function rotateSignedPrekey(
  storage: E2eeStorage,
  record: SignedPrekeyRecord,
  options: {
    readonly now?: number;
    readonly activeSessionSpkIds?: ReadonlySet<string>;
  } = {},
): Promise<SignedPrekeyRotationResult> {
  validateSignedPrekey(record);
  const now = options.now ?? Date.now();
  if (record.retiredAt !== null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'new SPK must not be retired');
  }

  return storage.transact(['prekeys'], 'readwrite', async (transaction) => {
    const previousCurrent = await readCurrentPointer(transaction);
    const all = new Map<string, SignedPrekeyRecord>();
    for (const key of await transaction.keys('prekeys')) {
      if (!key.startsWith(SPK_PREFIX) || key === CURRENT_SPK_KEY) continue;
      const existing = await transaction.get<SignedPrekeyRecord>('prekeys', key);
      if (existing) all.set(existing.keyId, validateSignedPrekey(existing));
    }

    if (previousCurrent !== null && previousCurrent.keyId !== record.keyId) {
      const previous = all.get(previousCurrent.keyId);
      if (previous && previous.retiredAt === null) {
        const retired: SignedPrekeyRecord = { ...previous, retiredAt: now };
        all.set(retired.keyId, retired);
        await transaction.put('prekeys', spkKey(retired.keyId), retired);
      }
    }

    all.set(record.keyId, record);
    await transaction.put('prekeys', spkKey(record.keyId), record);
    await transaction.put<CurrentSignedPrekeyPointer>('prekeys', CURRENT_SPK_KEY, {
      v: 1,
      keyId: record.keyId,
    });

    const ordered = [...all.values()].sort(
      (a, b) => b.createdAt - a.createdAt || b.keyId.localeCompare(a.keyId),
    );
    const previous = ordered.filter((candidate) => candidate.keyId !== record.keyId);
    const candidateSet = [record, ...previous.slice(0, SPK_RETAIN_PRIVATE - 1)];
    const keep = new Set<string>();
    for (const candidate of candidateSet) {
      // Only the 90-day window and the current+2 count bound the private SPKs.
      if (now - candidate.createdAt <= SPK_RETAIN_WINDOW_MS) keep.add(candidate.keyId);
    }

    const retained: SignedPrekeyRecord[] = [];
    const destroyed: string[] = [];
    for (const candidate of ordered) {
      if (keep.has(candidate.keyId)) {
        retained.push(candidate);
      } else {
        await transaction.delete('prekeys', spkKey(candidate.keyId));
        destroyed.push(candidate.keyId);
      }
    }

    return {
      current: all.get(record.keyId) as SignedPrekeyRecord,
      retained,
      destroyed,
    };
  });
}

/** Removes one SPK; repairs the current pointer to the newest remaining SPK. */
export async function deleteSignedPrekey(storage: E2eeStorage, keyId: string): Promise<void> {
  requireKeyId(keyId, 'spk_id');
  await storage.transact(['prekeys'], 'readwrite', async (transaction) => {
    await transaction.delete('prekeys', spkKey(keyId));
    const pointer = await readCurrentPointer(transaction);
    if (pointer?.keyId !== keyId) return;
    const remaining: SignedPrekeyRecord[] = [];
    for (const key of await transaction.keys('prekeys')) {
      if (!key.startsWith(SPK_PREFIX) || key === CURRENT_SPK_KEY) continue;
      const record = await transaction.get<SignedPrekeyRecord>('prekeys', key);
      if (record) remaining.push(record);
    }
    remaining.sort((a, b) => b.createdAt - a.createdAt);
    const next = remaining[0];
    if (next) {
      await transaction.put<CurrentSignedPrekeyPointer>('prekeys', CURRENT_SPK_KEY, {
        v: 1,
        keyId: next.keyId,
      });
    } else {
      await transaction.delete('prekeys', CURRENT_SPK_KEY);
    }
  });
}

/** Device revoke / profile reset: destroy every private prekey at once. */
export async function destroyPrekeyMaterial(storage: E2eeStorage): Promise<void> {
  await storage.clear('prekeys');
}

export function encodePrekeyPublicKey(bytes: Uint8Array): string {
  if (bytes.length !== KEY_BYTES)
    throw invalid('INVALID_KEY', 'prekey public key must be 32 bytes');
  return encodeBase64Url(bytes);
}

export function encodePrekeySignature(bytes: Uint8Array): string {
  if (bytes.length !== SIGNATURE_BYTES)
    throw invalid('INVALID_KEY', 'SPK signature must be 64 bytes');
  return encodeBase64Url(bytes);
}

/** Default OPK expiry helper for provisioning (E7-F3). */
export function oneTimePrekeyExpiry(createdAt: number): number {
  return createdAt + OPK_TTL_MS;
}

export function signedPrekeyExpiry(createdAt: number): number {
  return createdAt + SPK_ROTATION_INTERVAL_MS;
}

/** Guard used by registration code: a device id must be a UUID. */
export function assertDeviceId(deviceId: string): string {
  return requireUuid(deviceId, 'device_id');
}

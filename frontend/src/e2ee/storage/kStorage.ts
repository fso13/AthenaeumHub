/**
 * `K_storage` — the device-local AES-256-GCM key that encrypts session secrets,
 * outbox payloads and local message copies at rest in IndexedDB (§2.3).
 *
 * Honest boundary (P1-11): a non-extractable `CryptoKey` is not at-rest
 * encryption. It cannot be exported by JS and it keeps secrets out of plaintext
 * records, but any script in the origin (or a stolen browser profile) can use
 * it without a user passphrase. v1 has no passphrase/WebAuthn unlock and never
 * reports `STORAGE_LOCKED`.
 *
 * AAD layout — NORMATIVE, fixed width, 50 bytes (E7-F2F closes CR1 P1-07):
 *
 *     offset  size  field
 *     0       16    owner device_id       RFC 4122 network-order uuid bytes
 *     16      16    session_id            16-byte protocol session id
 *     32      16    client_message_id     RFC 4122 uuid bytes (or 0×16)
 *     48      1     record_type           u8, `RECORD_TYPES`
 *     49      1     local record version  u8, `LOCAL_RECORD_VERSION` (= 1)
 *
 * There are no length prefixes, no optional presence bits and no endianness
 * choices beyond RFC 4122 byte order for UUIDs. An absent optional id is the
 * 16-zero sentinel; a present id is never zero, because nil UUIDs and all-zero
 * session ids are rejected here (`assertNonNil`). That makes the encoding
 * injective: `null` and a hypothetical nil UUID cannot produce the same AAD.
 *
 * The local copy's `local_message_id` is bound through its storage key (which
 * now contains chat/direction/sender/id) and through the `K_storage`-sealed
 * payload cross-check, not through this 50-byte AAD. Changing the layout above
 * requires a new `LOCAL_RECORD_VERSION`, not a wire-version change.
 */
import {
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  KEY_BYTES,
  LOCAL_RECORD_VERSION,
} from '../constants';
import { E2eeError, isE2eeError } from '../errors';
import {
  assertBytesLength,
  concatBytes,
  isUuid,
  u8,
  uuidToBytes,
  zeroBytes,
  zeros,
} from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { randomBytes } from '../crypto/random';
import { aesGcmDecryptWithKey, aesGcmEncryptWithKey } from '../crypto/aead';
import { assertSecretKey } from '../crypto/keyGuards';
import { getSubtle } from '../crypto/support';
import { bufferSource } from '../crypto/bufferSource';
import { type E2eeStorage } from './types';

export const K_STORAGE_RECORD_KEY = 'k-storage:v1';

/**
 * The record stored under `K_STORAGE_RECORD_KEY` is not a bare `CryptoKey`: it
 * carries the owner scope next to the key (CR1b P1-04). A profile that switches
 * accounts therefore cannot load the previous account's key, and a key with a
 * missing/foreign owner marker fails closed instead of being silently reused.
 * The owner fields are not secret; the key itself stays non-extractable.
 */
export interface StoredKStorageRecord {
  readonly v: 1;
  readonly userId: string | null;
  readonly deviceId: string;
  readonly createdAt: number;
  readonly key: CryptoKey;
}

export interface KStorageScope {
  /**
   * Authenticated user that owns the device. Required (CR1c P1-04): callers
   * must state the account scope explicitly; `null` means "created before
   * authentication" and is one-time bound by `bindOwnerUser`.
   */
  readonly userId: string | null;
}
/** Normative AAD byte offsets; the total is `K_STORAGE_AAD_BYTES` (50). */
export const K_STORAGE_AAD_OFFSETS = {
  deviceId: 0,
  sessionId: 16,
  clientMessageId: 32,
  recordType: 48,
  version: 49,
} as const;
export const K_STORAGE_AAD_BYTES = 16 + 16 + 16 + 1 + 1;

export const RECORD_TYPES = {
  session: 1,
  outbox: 2,
  localCopy: 3,
  // E7-F3: TOFU pin, key-change state and chat security-mode pin are sealed
  // with the same device `K_storage`; no pin key/fingerprint is stored plaintext.
  pin: 4,
  keyChange: 5,
  modePin: 6,
} as const;

export type RecordType = keyof typeof RECORD_TYPES;

const RECORD_TYPE_CODES = new Map<number, RecordType>(
  Object.entries(RECORD_TYPES).map(([name, code]) => [code, name as RecordType]),
);

export interface EncryptedRecord {
  readonly v: 1;
  /** Random 12-byte AES-GCM nonce, canonical b64u. */
  readonly nonce: string;
  /** `ciphertext || tag16`, canonical b64u. */
  readonly ciphertext: string;
}

export interface KStorageAadFields {
  readonly ownerDeviceId: string;
  readonly sessionId?: string | null;
  readonly clientMessageId?: string | null;
  readonly recordType: RecordType;
}

export interface KStorage {
  readonly ownerDeviceId: string;
  encrypt(
    plaintext: Uint8Array,
    fields: Omit<KStorageAadFields, 'ownerDeviceId'>,
  ): Promise<EncryptedRecord>;
  decrypt(
    record: EncryptedRecord,
    fields: Omit<KStorageAadFields, 'ownerDeviceId'>,
  ): Promise<Uint8Array>;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

/**
 * Rejects the all-zero value so the fixed-width zero sentinel can only mean
 * "absent". Without this, `sessionId: null` and a nil UUID would share AAD.
 */
function assertNonNil(bytes: Uint8Array, label: string): Uint8Array {
  let aggregate = 0;
  for (const byte of bytes) aggregate |= byte;
  if (aggregate === 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must not be the nil sentinel`);
  }
  return bytes;
}

function sessionIdBytes(sessionId: string | null | undefined): Uint8Array {
  if (sessionId === null || sessionId === undefined) return zeros(16);
  try {
    return assertNonNil(decodeBase64Url(sessionId, 16), 'session_id');
  } catch (error) {
    if (isE2eeError(error) && error.code === 'KEY_STORAGE_UNAVAILABLE') throw error;
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session_id must be canonical b64u16');
  }
}

export function buildKStorageAad(fields: KStorageAadFields): Uint8Array {
  const deviceBytes = assertNonNil(
    uuidToBytes(requireUuid(fields.ownerDeviceId, 'device_id')),
    'device_id',
  );
  const recordCode = RECORD_TYPES[fields.recordType];
  if (!recordCode) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown storage record type');
  }
  const aad = concatBytes(
    deviceBytes,
    sessionIdBytes(fields.sessionId),
    fields.clientMessageId === null || fields.clientMessageId === undefined
      ? zeros(16)
      : assertNonNil(
          uuidToBytes(requireUuid(fields.clientMessageId, 'client_message_id')),
          'client_message_id',
        ),
    u8(recordCode),
    u8(LOCAL_RECORD_VERSION),
  );
  if (aad.length !== K_STORAGE_AAD_BYTES) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'K_storage AAD must be 50 bytes');
  }
  return aad;
}

function validateEncryptedRecord(record: unknown): EncryptedRecord {
  if (typeof record !== 'object' || record === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'encrypted record is not an object');
  }
  const candidate = record as Partial<EncryptedRecord>;
  if (candidate.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'encrypted record version is unsupported');
  }
  if (typeof candidate.nonce !== 'string' || typeof candidate.ciphertext !== 'string') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'encrypted record is malformed');
  }
  try {
    decodeBase64Url(candidate.nonce, AES_GCM_NONCE_BYTES);
    const ciphertext = decodeBase64Url(candidate.ciphertext);
    if (ciphertext.length < AES_GCM_TAG_BYTES) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'encrypted record ciphertext is truncated');
    }
  } catch (error) {
    if (isE2eeError(error) && error.code === 'KEY_STORAGE_UNAVAILABLE') throw error;
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'encrypted record is malformed');
  }
  return candidate as EncryptedRecord;
}

function validateStorageKey(key: CryptoKey): CryptoKey {
  assertSecretKey(key, 'K_storage');
  const algorithm = key.algorithm as { name?: string; length?: number };
  if (algorithm.name !== 'AES-GCM' || algorithm.length !== KEY_BYTES * 8) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'K_storage must be AES-256-GCM');
  }
  return key;
}

async function importKStorageKey(raw: Uint8Array): Promise<CryptoKey> {
  assertBytesLength(raw, KEY_BYTES, 'K_storage raw key');
  const key = await getSubtle().importKey('raw', bufferSource(raw), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
  return validateStorageKey(key);
}

function validateStoredKStorage(value: unknown): StoredKStorageRecord {
  if (typeof value !== 'object' || value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored K_storage record is invalid');
  }
  const record = value as Partial<StoredKStorageRecord>;
  if (record.v !== 1) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'stored K_storage record version is unsupported',
    );
  }
  if (record.userId !== null) {
    if (typeof record.userId !== 'string' || !isUuid(record.userId)) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored K_storage owner user_id is malformed');
    }
  }
  if (typeof record.deviceId !== 'string' || !isUuid(record.deviceId)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored K_storage owner device_id is malformed');
  }
  if (!Number.isInteger(record.createdAt) || (record.createdAt ?? -1) < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored K_storage createdAt is malformed');
  }
  try {
    validateStorageKey(record.key as CryptoKey);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored K_storage has an unexpected algorithm');
  }
  return {
    v: 1,
    userId: (record.userId as string | null | undefined) ?? null,
    deviceId: record.deviceId,
    createdAt: record.createdAt as number,
    key: record.key as CryptoKey,
  };
}

/**
 * Reads the owner-scoped record without creating anything. A malformed or
 * legacy (bare-key) record is a hard `KEY_STORAGE_UNAVAILABLE`: it is never
 * treated as "no key" and never silently replaced.
 */
export async function readKStorageRecord(
  storage: E2eeStorage,
): Promise<StoredKStorageRecord | null> {
  const value = await storage.get<unknown>('keys', K_STORAGE_RECORD_KEY);
  return value === null ? null : validateStoredKStorage(value);
}

function assertOwnerDevice(record: StoredKStorageRecord, ownerDeviceId: string): void {
  if (record.deviceId !== ownerDeviceId) {
    throw new E2eeError(
      'DEVICE_IDENTITY_MISMATCH',
      'stored K_storage belongs to a different device',
    );
  }
}

function assertOwnerUser(
  record: StoredKStorageRecord,
  expectedUserId: string | null | undefined,
): void {
  if (expectedUserId !== undefined && expectedUserId !== null && record.userId !== expectedUserId) {
    throw new E2eeError('DEVICE_IDENTITY_MISMATCH', 'stored K_storage belongs to a different user');
  }
}

/**
 * Binds a previously unbound (created before authentication) key to the
 * authenticated user, once, under the same transaction. A key already bound to
 * another user is never adopted. The device check runs before this.
 */
async function bindOwnerUser(
  storage: E2eeStorage,
  record: StoredKStorageRecord,
  expectedUserId: string | null | undefined,
): Promise<StoredKStorageRecord> {
  if (expectedUserId === undefined || expectedUserId === null || record.userId === expectedUserId) {
    return record;
  }
  if (record.userId !== null) {
    throw new E2eeError('DEVICE_IDENTITY_MISMATCH', 'stored K_storage belongs to a different user');
  }
  return storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<unknown>('keys', K_STORAGE_RECORD_KEY);
    if (current === null) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored K_storage disappeared during binding');
    }
    const validated = validateStoredKStorage(current);
    assertOwnerDevice(validated, record.deviceId);
    if (validated.userId === expectedUserId) return validated;
    if (validated.userId !== null) {
      throw new E2eeError(
        'DEVICE_IDENTITY_MISMATCH',
        'stored K_storage belongs to a different user',
      );
    }
    const updated: StoredKStorageRecord = { ...validated, userId: expectedUserId };
    await transaction.put('keys', K_STORAGE_RECORD_KEY, updated);
    return updated;
  });
}

function kStorageFromRecord(record: StoredKStorageRecord, ownerDeviceId: string): KStorage {
  return {
    ownerDeviceId,
    async encrypt(plaintext, fields) {
      const aad = buildKStorageAad({ ...fields, ownerDeviceId });
      const nonce = randomBytes(AES_GCM_NONCE_BYTES);
      const ciphertext = await aesGcmEncryptWithKey(record.key, nonce, plaintext, aad);
      return {
        v: 1,
        nonce: encodeBase64Url(nonce),
        ciphertext: encodeBase64Url(ciphertext),
      };
    },
    async decrypt(recordValue, fields) {
      const validated = validateEncryptedRecord(recordValue);
      const aad = buildKStorageAad({ ...fields, ownerDeviceId });
      const nonce = decodeBase64Url(validated.nonce, AES_GCM_NONCE_BYTES);
      const ciphertext = decodeBase64Url(validated.ciphertext);
      return aesGcmDecryptWithKey(record.key, nonce, ciphertext, aad);
    },
  };
}

/**
 * Loads the owner-scoped device `K_storage` or provisions a fresh random one.
 * Creation is double-checked inside one storage transaction, so two tabs racing
 * at first launch converge on the same key instead of overwriting each other's
 * records. A stored key whose owner device/user does not match the expected
 * scope is rejected (`DEVICE_IDENTITY_MISMATCH`), never re-used.
 */
export async function loadOrCreateKStorage(
  storage: E2eeStorage,
  ownerDeviceId: string,
  scope: KStorageScope,
): Promise<KStorage> {
  requireUuid(ownerDeviceId, 'device_id');
  if (scope === undefined || scope.userId === undefined) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'K_storage scope must name the account');
  }
  const expectedUserId = scope.userId;
  if (expectedUserId !== undefined && expectedUserId !== null) {
    requireUuid(expectedUserId, 'user_id');
  }

  const existing = await readKStorageRecord(storage);
  if (existing !== null) {
    assertOwnerDevice(existing, ownerDeviceId);
    const scoped = await bindOwnerUser(storage, existing, expectedUserId);
    assertOwnerUser(scoped, expectedUserId);
    return kStorageFromRecord(scoped, ownerDeviceId);
  }

  const raw = randomBytes(KEY_BYTES);
  let key: CryptoKey;
  try {
    key = await importKStorageKey(raw);
  } finally {
    zeroBytes(raw);
  }

  const candidate: StoredKStorageRecord = {
    v: 1,
    userId: expectedUserId ?? null,
    deviceId: ownerDeviceId,
    createdAt: Date.now(),
    key,
  };
  const winner = await storage.transact(['keys'], 'readwrite', async (transaction) => {
    const current = await transaction.get<unknown>('keys', K_STORAGE_RECORD_KEY);
    if (current !== null) return validateStoredKStorage(current);
    await transaction.put('keys', K_STORAGE_RECORD_KEY, candidate);
    return candidate;
  });
  assertOwnerDevice(winner, ownerDeviceId);
  const scopedWinner = await bindOwnerUser(storage, winner, expectedUserId);
  assertOwnerUser(scopedWinner, expectedUserId);
  return kStorageFromRecord(scopedWinner, ownerDeviceId);
}

/**
 * Deletes the owner-scoped storage key and its marker; every record encrypted
 * with it becomes unreadable.
 */
export async function destroyKStorage(storage: E2eeStorage): Promise<void> {
  await storage.delete('keys', K_STORAGE_RECORD_KEY);
}

/** Exposed for retention tests; never used to inspect key bytes in product code. */
export function recordTypeLabel(code: number): RecordType | null {
  return RECORD_TYPE_CODES.get(code) ?? null;
}

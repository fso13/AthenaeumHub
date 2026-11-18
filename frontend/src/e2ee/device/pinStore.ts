/**
 * Sealed TOFU-pin storage (E7-F3, CR1 P1-05).
 *
 * Pins, key-change state and chat-mode pins are security decisions, not a
 * cache, so they are encrypted with the device `K_storage` (AES-256-GCM) and
 * never written as plaintext into IndexedDB. The K_storage AAD layout is fixed
 * by E7-F2 and is not changed here; for pins the two 16-byte AAD slots carry:
 *
 *   sessionId      ← target device UUID (pin/key-change) or chat UUID (mode)
 *   clientMessageId← user UUID (account scope) or 0×16 (mode pin)
 *   record_type    ← pin | keyChange | modePin
 *
 * This binds a sealed pin to `(owner device, user, target device)` (or
 * `(owner device, chat)`), so ciphertext cannot be swapped between accounts,
 * devices or chats. A missing/corrupted `K_storage` or record is a hard
 * `KEY_STORAGE_UNAVAILABLE` — never "no pin" and never a silent first contact.
 *
 * Mutation is optimistic: the transaction compares the sealed bytes it read
 * and retries on a racing tab instead of overwriting another decision.
 */
import { UUID_BYTES } from '../constants';
import { E2eeError } from '../errors';
import { isUuid, uuidToBytes } from '../encoding/bytes';
import { encodeBase64Url } from '../encoding/base64url';
import {
  loadOrCreateKStorage,
  readKStorageRecord,
  type EncryptedRecord,
  type KStorage,
  type KStorageAadFields,
} from '../storage/kStorage';
import { type E2eeStorage } from '../storage/types';
import { loadDeviceIdentityRecord } from './identity';

export const PIN_PREFIX = 'pin:';
export const KEY_CHANGE_PREFIX = 'key-change:';
export const MODE_PIN_PREFIX = 'mode:';

export type AadFields = Omit<KStorageAadFields, 'ownerDeviceId'>;

interface SealedScope {
  readonly kStorage: KStorage;
}

interface EntrySpec {
  readonly key: string;
  readonly fields: AadFields;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

export function pinStorageKey(userId: string, deviceId: string): string {
  requireUuid(userId, 'user_id');
  requireUuid(deviceId, 'device_id');
  return `${PIN_PREFIX}${userId}:${deviceId}`;
}

export function keyChangeStorageKey(userId: string, deviceId: string): string {
  requireUuid(userId, 'user_id');
  requireUuid(deviceId, 'device_id');
  return `${KEY_CHANGE_PREFIX}${userId}:${deviceId}`;
}

export function modePinStorageKey(chatId: string): string {
  requireUuid(chatId, 'chat_id');
  return `${MODE_PIN_PREFIX}${chatId}`;
}

/**
 * Normative pin/key-change scope (CR1b P2-18). The 50-byte `K_storage` AAD is
 * reused without a new prefix; its two optional 16-byte slots carry:
 *
 *   sessionId       ← target device UUID (not a DR session id)
 *   clientMessageId ← target user UUID (peer account scope)
 *
 * `record_type` distinguishes `pin` (4) from `keyChange` (5). Because both
 * slots are present and non-zero, the same sealed bytes cannot be moved to
 * another user/device (see `docs/E2EE-SPEC.md` §2.3.2).
 */
export function pinAad(
  userId: string,
  deviceId: string,
  recordType: 'pin' | 'keyChange',
): AadFields {
  const deviceBytes = uuidToBytes(requireUuid(deviceId, 'device_id'));
  if (deviceBytes.length !== UUID_BYTES) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'device_id must encode to 16 bytes');
  }
  return {
    // Fixed-width b64u16 so `K_storage`'s AAD layout stays exactly 50 bytes.
    sessionId: encodeBase64Url(deviceBytes),
    clientMessageId: requireUuid(userId, 'user_id'),
    recordType,
  };
}

/**
 * Normative mode-pin scope (CR1b P2-18): `sessionId` carries the chat UUID and
 * `clientMessageId` is the all-zero sentinel (`0×16`), `record_type=modePin`.
 */
export function modeAad(chatId: string): AadFields {
  return {
    sessionId: encodeBase64Url(uuidToBytes(requireUuid(chatId, 'chat_id'))),
    clientMessageId: null,
    recordType: 'modePin',
  };
}

function pinEntry(userId: string, deviceId: string): EntrySpec {
  return {
    key: pinStorageKey(userId, deviceId),
    fields: pinAad(userId, deviceId, 'pin'),
  };
}

function keyChangeEntry(userId: string, deviceId: string): EntrySpec {
  return {
    key: keyChangeStorageKey(userId, deviceId),
    fields: pinAad(userId, deviceId, 'keyChange'),
  };
}

function modeEntry(chatId: string): EntrySpec {
  return { key: modePinStorageKey(chatId), fields: modeAad(chatId) };
}

async function loadScope(
  storage: E2eeStorage,
  owner?: { readonly userId?: string | null; readonly deviceId?: string | null },
): Promise<SealedScope> {
  const identity = await loadDeviceIdentityRecord(storage);
  if (!identity || identity.deviceId === null) {
    throw new E2eeError('DEVICE_NOT_REGISTERED', 'device is not registered');
  }
  if (identity.state !== 'registered') {
    throw new E2eeError('KEY_CHANGE_DETECTED', 'device identity is not usable for pin storage');
  }
  // E7-F5G P1-04: the caller must name the local account it is acting for. A
  // pin store read for another account is a hard failure (fail-closed), never
  // a cross-account read.
  if (owner !== undefined) {
    if (owner.userId !== undefined && identity.userId !== owner.userId) {
      throw new E2eeError(
        'KEY_STORAGE_UNAVAILABLE',
        'pin storage belongs to a different local account',
      );
    }
    if (owner.deviceId !== undefined && identity.deviceId !== owner.deviceId) {
      throw new E2eeError(
        'KEY_STORAGE_UNAVAILABLE',
        'pin storage belongs to a different local device',
      );
    }
  }
  let existingKey: Awaited<ReturnType<typeof readKStorageRecord>>;
  try {
    existingKey = await readKStorageRecord(storage);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pin storage key is invalid');
  }
  if (existingKey === null && (await storage.keys('pins')).length > 0) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'pin storage key is missing; existing pins cannot be trusted',
    );
  }
  const kStorage = await loadOrCreateKStorage(storage, identity.deviceId, {
    userId: identity.userId,
  });
  return { kStorage };
}

function sameSealed(left: EncryptedRecord | null, right: EncryptedRecord | null): boolean {
  if (left === null || right === null) return left === right;
  return left.nonce === right.nonce && left.ciphertext === right.ciphertext;
}

async function decryptValue(
  scope: SealedScope,
  sealed: EncryptedRecord,
  fields: AadFields,
  key: string,
): Promise<unknown> {
  try {
    const plaintext = await scope.kStorage.decrypt(sealed, fields);
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as unknown;
    } finally {
      plaintext.fill(0);
    }
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `sealed record ${key} cannot be decrypted`);
  }
}

async function encryptValue(
  scope: SealedScope,
  value: unknown,
  fields: AadFields,
): Promise<EncryptedRecord> {
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    return await scope.kStorage.encrypt(plaintext, fields);
  } finally {
    plaintext.fill(0);
  }
}

interface MutationWrite {
  readonly spec: EntrySpec;
  /** `undefined` = leave the stored entry untouched. */
  readonly value: unknown | null | undefined;
}

/**
 * Reads entries, computes a mutation and writes it only if the sealed bytes
 * did not change in the meantime. Returns the caller-provided result.
 */
async function mutateSealed<T>(
  storage: E2eeStorage,
  specs: readonly EntrySpec[],
  compute: (values: readonly unknown[]) => {
    readonly writes: readonly MutationWrite[];
    readonly result: T;
  },
): Promise<T> {
  const scope = await loadScope(storage);
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const raw = await Promise.all(
      specs.map((spec) => storage.get<EncryptedRecord>('pins', spec.key)),
    );
    const values: unknown[] = [];
    for (let index = 0; index < specs.length; index += 1) {
      const sealed = raw[index] ?? null;
      const spec = specs[index] as EntrySpec;
      values.push(
        sealed === null ? null : await decryptValue(scope, sealed, spec.fields, spec.key),
      );
    }
    const mutation = compute(values);
    const encrypted = new Map<string, EncryptedRecord | null>();
    for (const write of mutation.writes) {
      if (write.value === undefined) continue;
      encrypted.set(
        write.spec.key,
        write.value === null ? null : await encryptValue(scope, write.value, write.spec.fields),
      );
    }
    const committed = await storage.transact(['pins'], 'readwrite', async (transaction) => {
      for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index] as EntrySpec;
        const current = await transaction.get<EncryptedRecord>('pins', spec.key);
        if (!sameSealed(current, raw[index] ?? null)) return false;
      }
      for (const [key, value] of encrypted) {
        if (value === null) await transaction.delete('pins', key);
        else await transaction.put('pins', key, value);
      }
      return true;
    });
    if (committed) return mutation.result;
  }
  throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pin storage is contended; retry the operation');
}

async function readSealed(storage: E2eeStorage, spec: EntrySpec): Promise<unknown | null> {
  const scope = await loadScope(storage);
  const sealed = await storage.get<EncryptedRecord>('pins', spec.key);
  if (sealed === null) return null;
  return decryptValue(scope, sealed, spec.fields, spec.key);
}

export async function readSealedPin(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<unknown | null> {
  return readSealed(storage, pinEntry(userId, deviceId));
}

export async function readSealedKeyChange(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<unknown | null> {
  return readSealed(storage, keyChangeEntry(userId, deviceId));
}

export async function readSealedModePin(
  storage: E2eeStorage,
  chatId: string,
): Promise<unknown | null> {
  return readSealed(storage, modeEntry(chatId));
}

export async function mutateSealedPinRecords<T>(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
  compute: (
    pin: unknown | null,
    keyChange: unknown | null,
  ) => {
    readonly pin: unknown | null | undefined;
    readonly keyChange: unknown | null | undefined;
    readonly result: T;
  },
): Promise<T> {
  const pinSpec = pinEntry(userId, deviceId);
  const changeSpec = keyChangeEntry(userId, deviceId);
  return mutateSealed(storage, [pinSpec, changeSpec], (values) => {
    const mutation = compute(values[0] ?? null, values[1] ?? null);
    return {
      writes: [
        { spec: pinSpec, value: mutation.pin },
        { spec: changeSpec, value: mutation.keyChange },
      ],
      result: mutation.result,
    };
  });
}

export async function mutateSealedModePin<T>(
  storage: E2eeStorage,
  chatId: string,
  compute: (pin: unknown | null) => {
    readonly pin: unknown | null | undefined;
    readonly result: T;
  },
): Promise<T> {
  const spec = modeEntry(chatId);
  return mutateSealed(storage, [spec], (values) => {
    const mutation = compute(values[0] ?? null);
    return {
      writes: [{ spec, value: mutation.pin }],
      result: mutation.result,
    };
  });
}

export interface SealedPinEntry {
  /** Peer user the pin belongs to. */
  readonly userId: string;
  /** Peer device the pin belongs to. */
  readonly deviceId: string;
  readonly value: unknown;
}

/**
 * E7-F5G P1-04 list scope. `userId`/`deviceId` are the **local** account and
 * device: pins are single-slot per origin, so listing them for another local
 * account must fail closed. `peerUserId`/`peerDeviceId` optionally narrow the
 * result to target devices.
 */
export interface SealedPinListScope {
  readonly userId: string | null;
  readonly deviceId?: string | null;
  readonly peerUserId?: string | null;
  readonly peerDeviceId?: string | null;
}

export async function listSealedPins(
  storage: E2eeStorage,
  scopeInput: SealedPinListScope,
): Promise<SealedPinEntry[]> {
  const scope = await loadScope(storage, {
    userId: scopeInput.userId,
    deviceId: scopeInput.deviceId,
  });
  const entries: SealedPinEntry[] = [];
  for (const key of await storage.keys('pins')) {
    if (!key.startsWith(PIN_PREFIX)) continue;
    const parts = key.slice(PIN_PREFIX.length).split(':');
    if (parts.length !== 2) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'pin storage key is malformed');
    }
    const userId = parts[0] as string;
    const deviceId = parts[1] as string;
    if (scopeInput.peerUserId !== undefined && scopeInput.peerUserId !== null) {
      if (userId !== scopeInput.peerUserId) continue;
    }
    if (scopeInput.peerDeviceId !== undefined && scopeInput.peerDeviceId !== null) {
      if (deviceId !== scopeInput.peerDeviceId) continue;
    }
    const spec = pinEntry(userId, deviceId);
    const sealed = await storage.get<EncryptedRecord>('pins', key);
    if (sealed === null) continue;
    entries.push({
      userId,
      deviceId,
      value: await decryptValue(scope, sealed, spec.fields, spec.key),
    });
  }
  return entries;
}

/** Deletes both entries without requiring a decrypt (explicit "forget device"). */
export async function deleteSealedPin(
  storage: E2eeStorage,
  userId: string,
  deviceId: string,
): Promise<void> {
  const pinKey = pinStorageKey(userId, deviceId);
  const changeKey = keyChangeStorageKey(userId, deviceId);
  await storage.transact(['pins'], 'readwrite', async (transaction) => {
    await transaction.delete('pins', pinKey);
    await transaction.delete('pins', changeKey);
  });
}

export async function deleteSealedModePin(storage: E2eeStorage, chatId: string): Promise<void> {
  await storage.delete('pins', modePinStorageKey(chatId));
}

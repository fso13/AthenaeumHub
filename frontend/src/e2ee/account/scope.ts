/**
 * Account-scoped E2EE wipe (E7-F5F, CR1c P1-04 / P2-24).
 *
 * The browser storage is shared by the origin (`krug-e2ee`), and one profile may
 * briefly hold state for more than one account/device (two tabs, account
 * switch, a crashed logout). A full-store wipe would destroy the other
 * account's still-live state, so logout removes only records that can be
 * attributed to the current `(userId, deviceId)` scope:
 *
 * - `sessions` / `sessions` peer index: keyed by the **local** device id;
 * - `outbox`: its plaintext `senderDeviceId` is the local device;
 * - `localMessages`: matched by the sessions/outbox ids of that device, or by
 *   `direction='outgoing'` and the local device id (incoming copies carry the
 *   peer device id);
 * - `keys`, `prekeys`, `pins`: global to the device identity, therefore removed
 *   only when the persisted identity itself belongs to the scope. If another
 *   account owns the identity record, they are left untouched.
 *
 * This is deliberately conservative: an unknown/other-account record is never
 * deleted, and log out never guesses from a record it cannot attribute. Sealed
 * records are not decrypted here; only plaintext scope metadata is used.
 */
import {
  DEVICE_IDENTITY_DH_KEY,
  DEVICE_IDENTITY_RECORD_KEY,
  DEVICE_IDENTITY_SIGNING_KEY,
  PENDING_DEVICE_REGISTRATION_KEY,
  loadDeviceIdentityRecord,
} from '../device/identity';
import { PENDING_PREKEY_UPLOAD_KEY } from '../device/prekeys';
import type {
  DeviceIdentityRecord,
  PendingDeviceRegistration,
  PendingPrekeyUpload,
} from '../device/types';
import type { StoredLocalMessageCopy, StoredOutboxEntry } from '../outbox/types';
import type { StoredSessionRecord } from '../session/types';
import { K_STORAGE_RECORD_KEY, readKStorageRecord } from '../storage/kStorage';
import { E2EE_STORE_NAMES, type E2eeStorage } from '../storage/types';

/** Stable store-key prefixes (`sessionStore.ts` / `outboxStore.ts`). */
const SESSION_PREFIX = 'session:';
const PEER_INDEX_PREFIX = 'peer:';

export interface E2eeAccountScope {
  /** Authenticated user id, if known. `null` means "unknown, use identity". */
  readonly userId: string | null;
  /** Keyed device id (`X-Device-Id`), if known. `null` means "unknown". */
  readonly deviceId: string | null;
}

interface WipePlan {
  readonly sessionKeys: string[];
  readonly outboxKeys: string[];
  readonly localCopyKeys: string[];
  /** Remove identity/K_storage/prekeys/pins only for the owning account. */
  readonly ownsIdentity: boolean;
  /**
   * An identity-less profile whose K_storage still belongs to the scope: the
   * orphaned key is removed, but nothing owned by another identity is touched.
   */
  readonly ownsOrphanedKStorage: boolean;
}

function peerIndexDeviceId(key: string): string | null {
  if (!key.startsWith(PEER_INDEX_PREFIX)) return null;
  const rest = key.slice(PEER_INDEX_PREFIX.length);
  const separator = rest.indexOf(':');
  return separator <= 0 ? null : rest.slice(0, separator);
}

async function buildPlan(storage: E2eeStorage, scope: E2eeAccountScope): Promise<WipePlan> {
  let identity: DeviceIdentityRecord | null = null;
  try {
    identity = await loadDeviceIdentityRecord(storage);
  } catch {
    // A malformed identity cannot name an owner; never delete global stores.
    identity = null;
  }
  let kStorageOwner: { userId: string | null; deviceId: string } | null = null;
  try {
    const record = await readKStorageRecord(storage);
    if (record !== null) {
      kStorageOwner = { userId: record.userId, deviceId: record.deviceId };
    }
  } catch {
    kStorageOwner = null;
  }

  const ownsIdentity =
    identity !== null &&
    (scope.userId === null || identity.userId === null || identity.userId === scope.userId) &&
    (scope.deviceId === null || identity.deviceId === null || identity.deviceId === scope.deviceId);

  const ownsOrphanedKStorage =
    identity === null &&
    kStorageOwner !== null &&
    (scope.deviceId === null || kStorageOwner.deviceId === scope.deviceId) &&
    (scope.userId === null ||
      kStorageOwner.userId === null ||
      kStorageOwner.userId === scope.userId);

  const deviceIds = new Set<string>();
  if (scope.deviceId !== null) deviceIds.add(scope.deviceId);
  if (ownsIdentity && identity?.deviceId) deviceIds.add(identity.deviceId);

  const sessionKeys: string[] = [];
  const outboxKeys: string[] = [];
  const localCopyKeys: string[] = [];
  const ownedSessionIds = new Set<string>();

  for (const key of await storage.keys('sessions')) {
    if (key.startsWith(SESSION_PREFIX)) {
      const record = await storage.get<StoredSessionRecord>('sessions', key);
      if (record !== null && deviceIds.has(record.deviceId)) {
        sessionKeys.push(key);
        ownedSessionIds.add(record.sessionId);
      }
    } else {
      const indexedDeviceId = peerIndexDeviceId(key);
      if (indexedDeviceId !== null && deviceIds.has(indexedDeviceId)) sessionKeys.push(key);
    }
  }

  for (const key of await storage.keys('outbox')) {
    const record = await storage.get<StoredOutboxEntry>('outbox', key);
    if (record !== null && deviceIds.has(record.senderDeviceId)) {
      outboxKeys.push(key);
      ownedSessionIds.add(record.sessionId);
    }
  }

  for (const key of await storage.keys('localMessages')) {
    const record = await storage.get<StoredLocalMessageCopy>('localMessages', key);
    if (record === null) continue;
    const belongsToOwnedSession = ownedSessionIds.has(record.sessionId);
    const isOwnOutgoingCopy =
      record.direction === 'outgoing' && deviceIds.has(record.senderDeviceId);
    if (belongsToOwnedSession || isOwnOutgoingCopy) localCopyKeys.push(key);
  }

  return { sessionKeys, outboxKeys, localCopyKeys, ownsIdentity, ownsOrphanedKStorage };
}

/**
 * Deletes only the records attributable to `scope`. Unattributable records are
 * preserved by design (no cross-account data loss). Logout treats a failure as
 * best effort at the call site (`account/logout.ts`).
 */
export async function clearE2eeAccountScope(
  storage: E2eeStorage,
  scope: E2eeAccountScope,
): Promise<void> {
  const plan = await buildPlan(storage, scope);

  await storage.transact([...E2EE_STORE_NAMES], 'readwrite', async (transaction) => {
    for (const key of plan.sessionKeys) await transaction.delete('sessions', key);
    for (const key of plan.outboxKeys) await transaction.delete('outbox', key);
    for (const key of plan.localCopyKeys) await transaction.delete('localMessages', key);

    if (plan.ownsIdentity || plan.ownsOrphanedKStorage) {
      // Identity, K_storage, prekeys and pins are single-slot per origin and
      // belong to the account that owns the persisted identity.
      for (const key of await transaction.keys('prekeys')) {
        await transaction.delete('prekeys', key);
      }
      for (const key of await transaction.keys('pins')) {
        await transaction.delete('pins', key);
      }
    }

    if (plan.ownsIdentity) {
      for (const key of await transaction.keys('keys')) {
        await transaction.delete('keys', key);
      }
      return;
    }

    // Another account owns the identity: remove only pending records that
    // explicitly carry this scope, never identity/K_storage/private keys.
    const pendingRegistration = await transaction.get<PendingDeviceRegistration>(
      'keys',
      PENDING_DEVICE_REGISTRATION_KEY,
    );
    if (
      pendingRegistration !== null &&
      scope.userId !== null &&
      pendingRegistration.userId === scope.userId
    ) {
      await transaction.delete('keys', PENDING_DEVICE_REGISTRATION_KEY);
    }
    const pendingUpload = await transaction.get<PendingPrekeyUpload>(
      'keys',
      PENDING_PREKEY_UPLOAD_KEY,
    );
    if (
      pendingUpload !== null &&
      scope.deviceId !== null &&
      pendingUpload.deviceId === scope.deviceId
    ) {
      await transaction.delete('keys', PENDING_PREKEY_UPLOAD_KEY);
    }
    if (plan.ownsOrphanedKStorage) {
      await transaction.delete('keys', K_STORAGE_RECORD_KEY);
      await transaction.delete('keys', DEVICE_IDENTITY_SIGNING_KEY);
      await transaction.delete('keys', DEVICE_IDENTITY_DH_KEY);
      await transaction.delete('keys', DEVICE_IDENTITY_RECORD_KEY);
    }
  });
}

/**
 * Production logout hook (CR1b P1-04, E7-F5F per-account wipe).
 *
 * Logout removes the **current account/device** E2EE state: identity,
 * `K_storage`, sessions, outbox rows, local message copies, prekeys and pins.
 * `clearAuthStorage()` calls this hook, and `clearRuntimeAuth()` (the path used
 * by the real and mock OIDC providers) awaits it before redirecting.
 *
 * The scope is explicit (`userId` from the auth provider, `deviceId` captured
 * from the auth runtime) with a fallback to the persisted identity. A shared
 * origin database is not wiped wholesale: a second account's records are kept
 * (see `account/scope.ts`).
 *
 * Failure policy: logout must never be blocked by an unavailable/broken
 * IndexedDB, so this function swallows storage errors. That is fail-closed, not
 * fail-open: `loadDeviceIdentity`/`loadOrCreateKStorage` reject an owner
 * mismatch, and sealed records cannot be decrypted without `K_storage`.
 */
import { clearE2eeAccountScope, type E2eeAccountScope } from './scope';
import { loadDeviceIdentityRecord } from '../device/identity';
import type { DeviceIdentityRecord } from '../device/types';
import { getE2eeStorage, resetE2eeStorage } from '../storage/runtime';
import type { E2eeStorage } from '../storage/types';

export interface LogoutScope {
  readonly userId?: string | null;
  readonly deviceId?: string | null;
}

export async function clearE2eeAccountStateOnLogout(scope: LogoutScope = {}): Promise<void> {
  let storage: E2eeStorage;
  try {
    storage = getE2eeStorage();
  } catch {
    // No IndexedDB in this context: there is no persisted E2EE state to wipe.
    return;
  }
  try {
    let identity: DeviceIdentityRecord | null = null;
    try {
      identity = await loadDeviceIdentityRecord(storage);
    } catch {
      // Do not let a malformed identity block logout; the scope below falls
      // back to the explicit auth parameters and deletes only attributable rows.
      identity = null;
    }
    const userId = scope.userId ?? identity?.userId ?? null;
    // The persisted identity is authoritative for the device id only when it
    // belongs to the user being logged out. If another account owns the
    // identity, keep the explicit auth-runtime device id (never wipe that
    // other account's keys).
    const sameAccount =
      identity === null ||
      scope.userId === null ||
      scope.userId === undefined ||
      identity.userId === null ||
      identity.userId === scope.userId;
    const resolved: E2eeAccountScope = {
      userId,
      deviceId: sameAccount && identity?.deviceId ? identity.deviceId : (scope.deviceId ?? null),
    };
    await clearE2eeAccountScope(storage, resolved);
  } catch {
    // Best effort; see the failure policy above.
  } finally {
    try {
      await storage.close();
    } catch {
      // Closing a broken connection must not block logout either.
    }
    resetE2eeStorage();
  }
}

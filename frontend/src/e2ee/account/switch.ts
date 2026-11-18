/**
 * Explicit E2EE account switch (E7-F5G, P1-04).
 *
 * The profile is single-slot: identity, `K_storage`, prekeys and pins belong to
 * the account that created them. Logging out already wipes that account
 * (`account/logout.ts`), but an account switch without logout (a new OIDC user
 * in the same tab) used to fail with `DEVICE_IDENTITY_MISMATCH` and no recovery
 * flow. The supported flow is "wipe the previous owner's E2EE state, then
 * register the new account": the switch is explicit at the bridge boundary and
 * only runs when the persisted identity names a *different* user.
 *
 * The wipe is the same conservative per-account scope used by logout: the new
 * account's unattributable rows are not guessed at. Because the previous
 * owner's `K_storage` is removed, its sealed sessions cannot be decrypted
 * afterwards; this is a documented consequence of the single-slot model
 * (per-user DB remains the F7/P2-24 follow-up).
 */
import { loadDeviceIdentityRecord } from '../device/identity';
import type { E2eeStorage } from '../storage/types';
import { clearE2eeAccountScope } from './scope';

export interface E2eeAccountSwitchInput {
  /** Authenticated user id the bridge is initializing. */
  readonly userId: string;
  /** Explicit device id when the auth runtime already knows it. */
  readonly deviceId?: string | null;
}

export type E2eeAccountSwitchResult = 'none' | 'switched';

/**
 * Wipes the previously persisted account when it does not match `userId`.
 * Returns `none` when there is no identity yet, it is unbound, or it already
 * belongs to the requested account.
 */
export async function switchE2eeAccountIfNeeded(
  storage: E2eeStorage,
  input: E2eeAccountSwitchInput,
): Promise<E2eeAccountSwitchResult> {
  let identity;
  try {
    identity = await loadDeviceIdentityRecord(storage);
  } catch {
    // A malformed identity cannot be attributed; let registration fail closed
    // instead of deleting records on a guess.
    return 'none';
  }
  if (identity === null || identity.userId === null || identity.userId === input.userId) {
    return 'none';
  }
  await clearE2eeAccountScope(storage, {
    userId: identity.userId,
    deviceId: identity.deviceId ?? input.deviceId ?? null,
  });
  return 'switched';
}

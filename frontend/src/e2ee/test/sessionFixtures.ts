/**
 * Test-only worlds for the E7-F4 session tests: a registered device with its
 * own `K_storage`, identity, SPK and OPK batch, plus helpers to build the claim
 * bundle / verified identity that a peer would receive.
 *
 * Production code never imports this module.
 */
import { createMemoryE2eeStorage } from '../storage/memory';
import { loadOrCreateKStorage, type KStorage } from '../storage/kStorage';
import type { E2eeStorage } from '../storage/types';
import { createDeviceIdentity, loadDeviceIdentity } from '../device/identity';
import { completeDeviceRegistration, prepareDeviceRegistration } from '../device/registration';
import {
  getCurrentSignedPrekey,
  listOneTimePrekeys,
  type OneTimePrekeyRecord,
  type SignedPrekeyRecord,
} from '../session/prekeyStore';
import { decodePrekeyBundle } from '../api/deviceKeys';
import { verifyClaimedBundle } from '../device/binding';
import type {
  LoadedDeviceIdentity,
  VerifiedClaimedBundle,
  VerifiedDeviceIdentity,
} from '../device/types';
import { makeDeviceResponse, makeWireBundle } from './deviceFixtures';

export interface TestWorld {
  readonly storage: E2eeStorage;
  readonly kStorage: KStorage;
  readonly identity: LoadedDeviceIdentity;
  readonly userId: string;
  readonly deviceId: string;
  readonly now: number;
  readonly spk: SignedPrekeyRecord;
}

export interface TestWorldOptions {
  readonly storage?: E2eeStorage;
  readonly userId?: string;
  readonly deviceId?: string;
  readonly now?: number;
  readonly opkCount?: number;
}

export const SESSION_IDS = {
  userA: '11111111-1111-4111-8111-111111111111',
  userB: '22222222-2222-4222-8222-222222222222',
  a1: '33333333-3333-4333-8333-333333333333',
  a2: '44444444-4444-4444-8444-444444444444',
  b1: '55555555-5555-4555-8555-555555555555',
  b2: '66666666-6666-4666-8666-666666666666',
  chat: '77777777-7777-4777-8777-777777777777',
} as const;

export const DEFAULT_NOW = 1_700_000_000_000;

export async function createTestWorld(options: TestWorldOptions = {}): Promise<TestWorld> {
  const now = options.now ?? DEFAULT_NOW;
  const userId = options.userId ?? SESSION_IDS.userA;
  const deviceId = options.deviceId ?? SESSION_IDS.a1;
  const storage = options.storage ?? createMemoryE2eeStorage();
  const kStorage = await loadOrCreateKStorage(storage, deviceId, { userId });
  let identity = await loadDeviceIdentity(storage, { userId });
  if (identity === null) {
    identity = await createDeviceIdentity(storage, { userId, now });
  }
  const prepared = await prepareDeviceRegistration(storage, {
    userId,
    name: 'E7-F4 test device',
    appVersion: '0.7.0',
    opkCount: options.opkCount ?? 2,
    now,
  });
  if (prepared.kind !== 'ready') {
    throw new Error(`test fixture: unexpected registration state ${prepared.kind}`);
  }
  const spk = await getCurrentSignedPrekey(storage);
  if (spk === null) throw new Error('test fixture: missing SPK');
  const device = makeDeviceResponse(prepared.identity, spk, {
    id: deviceId,
    key_generation: prepared.identity.record.keyGeneration,
  });
  const registered = await completeDeviceRegistration(storage, prepared, device, { now });
  const identityNow = { ...identity, record: registered };
  return { storage, kStorage, identity: identityNow, userId, deviceId, now, spk };
}

/** Reloads the identity (e.g. after a "page reload") from persisted storage. */
export async function reloadWorld(world: TestWorld): Promise<TestWorld> {
  const identity = await loadDeviceIdentity(world.storage, { userId: world.userId });
  if (identity === null) throw new Error('test fixture: identity disappeared');
  const spk = await getCurrentSignedPrekey(world.storage);
  if (spk === null) throw new Error('test fixture: SPK disappeared');
  return { ...world, identity, spk };
}

async function firstAvailableOpk(world: TestWorld): Promise<OneTimePrekeyRecord | null> {
  const opks = await listOneTimePrekeys(world.storage);
  return opks.find((record) => record.expiresAt >= world.now) ?? null;
}

/** Verified claim bundle for `world`, including one OPK when available. */
export async function claimBundleFromWorld(
  world: TestWorld,
  options: { readonly withOpk?: boolean } = {},
): Promise<VerifiedClaimedBundle> {
  const opk = options.withOpk === false ? null : await firstAvailableOpk(world);
  const wire = makeWireBundle(world.identity, world.spk, {
    user_id: world.userId,
    device_id: world.deviceId,
    key_generation: world.identity.record.keyGeneration,
    one_time_prekey: opk === null ? null : { key_id: opk.keyId, public_key: opk.publicKey },
    otp_exhausted: opk === null,
  });
  return verifyClaimedBundle(decodePrekeyBundle(wire), { now: world.now });
}

/** Verified identity only (what `GET /chats/{id}/keys` would provide). */
export async function verifiedIdentityOf(world: TestWorld): Promise<VerifiedDeviceIdentity> {
  const bundle = await claimBundleFromWorld(world, { withOpk: false });
  return bundle.identity;
}

export function recipientPlan(
  bundle: VerifiedClaimedBundle,
  options: { readonly freshPrekey?: boolean; readonly isSelfDevice?: boolean } = {},
) {
  return {
    identity: bundle.identity,
    bundle,
    ...(options.freshPrekey === undefined ? {} : { freshPrekey: options.freshPrekey }),
    ...(options.isSelfDevice === undefined ? {} : { isSelfDevice: options.isSelfDevice }),
  };
}

/** Convenience: registered worlds for A1, A2, B1 with distinct users/devices. */
export async function createThreeWorlds(): Promise<{
  a1: TestWorld;
  a2: TestWorld;
  b1: TestWorld;
}> {
  const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
  const a2 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a2 });
  const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
  return { a1, a2, b1 };
}

/**
 * Test-only fixtures for E7-F3 device registration / prekeys / TOFU tests.
 * Production code never imports this module.
 */
import { createMemoryE2eeStorage } from '../storage/memory';
import { type E2eeStorage } from '../storage/types';
import { encodeBase64Url } from '../encoding/base64url';
import { createDeviceIdentity } from '../device/identity';
import { ensureSignedPrekey } from '../device/prekeys';
import { prepareDeviceRegistration, completeDeviceRegistration } from '../device/registration';
import { getCurrentSignedPrekey, type SignedPrekeyRecord } from '../session/prekeyStore';
import type { LoadedDeviceIdentity, PendingPrekeyUpload } from '../device/types';
import type {
  WireChatKeysResponse,
  WireDevice,
  WireDeviceKeyInfo,
  WireKeyClaimResponse,
  WirePrekeyBundle,
  WirePrekeyUploadResult,
} from '../api/deviceKeys';

export const DEVICE_IDS = {
  user: '11111111-1111-4111-8111-111111111111',
  peerUser: '22222222-2222-4222-8222-222222222222',
  device: '33333333-3333-4333-8333-333333333333',
  peerDevice: '44444444-4444-4444-8444-444444444444',
  peerDevice2: '55555555-5555-4555-8555-555555555555',
  chat: '66666666-6666-4666-8666-666666666666',
  idempotency: '77777777-7777-4777-8777-777777777777',
  clientMessage: '88888888-8888-4888-8888-888888888888',
} as const;

export function b64(bytes: Uint8Array): string {
  return encodeBase64Url(bytes);
}

export interface DeviceFixture {
  readonly storage: E2eeStorage;
  readonly identity: LoadedDeviceIdentity;
  readonly spk: SignedPrekeyRecord;
}

export async function makeDeviceFixture(
  options: {
    readonly storage?: E2eeStorage;
    readonly userId?: string;
    readonly now?: number;
  } = {},
): Promise<DeviceFixture> {
  const storage = options.storage ?? createMemoryE2eeStorage();
  const identity = await createDeviceIdentity(storage, {
    userId: options.userId ?? DEVICE_IDS.user,
    now: options.now,
  });
  const ensured = await ensureSignedPrekey(storage, identity, { now: options.now });
  return { storage, identity, spk: ensured.record };
}

export async function currentSpk(storage: E2eeStorage): Promise<SignedPrekeyRecord> {
  const spk = await getCurrentSignedPrekey(storage);
  if (!spk) throw new Error('test fixture: no current SPK');
  return spk;
}

export function makeDeviceResponse(
  identity: LoadedDeviceIdentity,
  spk: SignedPrekeyRecord,
  overrides: Partial<WireDevice> = {},
): WireDevice {
  const record = identity.record;
  return {
    id: DEVICE_IDS.device,
    name: 'Test device',
    platform: 'WEB',
    status: 'ACTIVE',
    e2ee_capable: true,
    key_generation: record.keyGeneration,
    identity_signing_key: record.identitySigningKey,
    identity_dh_key: record.identityDhKey,
    identity_binding_signature: record.identityBindingSignature,
    identity_key_alg: 'Ed25519+X25519',
    fingerprint: record.fingerprint,
    signed_prekey: {
      key_id: spk.keyId,
      public_key: spk.publicKey,
      signature: spk.signature,
    },
    one_time_prekeys_available: 0,
    created_at: new Date(record.createdAt).toISOString(),
    last_seen_at: null,
    ...overrides,
  };
}

export function makeWireBundle(
  identity: LoadedDeviceIdentity,
  spk: SignedPrekeyRecord,
  overrides: Partial<WirePrekeyBundle> = {},
): WirePrekeyBundle {
  const record = identity.record;
  return {
    user_id: DEVICE_IDS.peerUser,
    device_id: DEVICE_IDS.peerDevice,
    key_generation: record.keyGeneration,
    identity_signing_key: record.identitySigningKey,
    identity_dh_key: record.identityDhKey,
    identity_binding_signature: record.identityBindingSignature,
    identity_key_alg: 'Ed25519+X25519',
    signed_prekey: {
      key_id: spk.keyId,
      public_key: spk.publicKey,
      signature: spk.signature,
      created_at: new Date(spk.createdAt).toISOString(),
      expires_at: new Date(spk.expiresAt).toISOString(),
    },
    one_time_prekey: {
      key_id: 'opk-test-1',
      public_key: encodeBase64Url(new Uint8Array(32).fill(9)),
    },
    otp_exhausted: false,
    ...overrides,
  };
}

export function makeClaimResponse(
  bundle: WirePrekeyBundle,
  unavailable: WireKeyClaimResponse['unavailable'] = [],
): WireKeyClaimResponse {
  return { bundles: [bundle], unavailable };
}

export function makeDeviceKeyInfo(
  identity: LoadedDeviceIdentity,
  overrides: Partial<WireDeviceKeyInfo> = {},
): WireDeviceKeyInfo {
  const record = identity.record;
  return {
    device_id: DEVICE_IDS.peerDevice,
    user_id: DEVICE_IDS.peerUser,
    platform: 'WEB',
    status: 'ACTIVE',
    identity_signing_key: record.identitySigningKey,
    identity_dh_key: record.identityDhKey,
    identity_binding_signature: record.identityBindingSignature,
    identity_key_alg: 'Ed25519+X25519',
    fingerprint: record.fingerprint,
    key_generation: record.keyGeneration,
    signed_prekey_id: 'spk-test',
    is_self: false,
    verified: null,
    verified_at: null,
    verification_method: null,
    last_seen_at: null,
    ...overrides,
  };
}

export function makeChatKeysResponse(
  self: LoadedDeviceIdentity,
  peer: LoadedDeviceIdentity,
  overrides: Partial<WireChatKeysResponse> = {},
): WireChatKeysResponse {
  return {
    chat_id: DEVICE_IDS.chat,
    security_mode: 'E2EE',
    my_device_id: DEVICE_IDS.device,
    verifier_device_id: DEVICE_IDS.device,
    verified_count: 0,
    verified_by_other_devices_count: 0,
    devices_total: 2,
    devices: [
      makeDeviceKeyInfo(self, {
        device_id: DEVICE_IDS.device,
        user_id: DEVICE_IDS.user,
        is_self: true,
      }),
      makeDeviceKeyInfo(peer),
    ],
    ...overrides,
  };
}

export function makePrekeyUploadResult(
  pending: PendingPrekeyUpload,
  overrides: Partial<WirePrekeyUploadResult> = {},
): WirePrekeyUploadResult {
  return {
    device_id: pending.deviceId,
    key_generation: pending.keyGeneration,
    signed_prekey_id: pending.spkKeyId,
    signed_prekey_expires_at: null,
    one_time_prekeys_stored: pending.opkIds.length,
    one_time_prekeys_available: pending.opkIds.length,
    one_time_prekeys_limit: 200,
    ...overrides,
  };
}

/** Registers the fixture identity locally (without a network call). */
export async function registerFixtureDevice(
  fixture: DeviceFixture,
  options: { readonly now?: number; readonly opkCount?: number } = {},
): Promise<WireDevice> {
  const prepared = await prepareDeviceRegistration(fixture.storage, {
    userId: fixture.identity.record.userId ?? DEVICE_IDS.user,
    name: 'Test device',
    appVersion: '0.7.0',
    opkCount: options.opkCount ?? 2,
    now: options.now,
  });
  if (prepared.kind !== 'ready') throw new Error('test fixture: expected ready registration');
  const device = makeDeviceResponse(prepared.identity, fixture.spk);
  await completeDeviceRegistration(fixture.storage, prepared, device, options);
  return device;
}

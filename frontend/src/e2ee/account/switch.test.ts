/**
 * E7-F5G P1-04: explicit account switch without logout.
 *
 * Logout already preserves a second account's sessions. The remaining gap was
 * the in-place switch: `initializeE2ee(B)` on an identity owned by A used to
 * fail with `DEVICE_IDENTITY_MISMATCH` and never recover. The supported flow is
 * wipe + re-register; these tests prove A's state is removed, B registers, and
 * switching back works.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createE2eeBridge, type E2eeDeviceTransport } from '../app/chatBridge';
import { createSession } from '../test/sessionTestWrites';
import { createTestWorld, DEFAULT_NOW } from '../test/sessionFixtures';
import { createTestSession } from '../test/fixtures';
import { DEVICE_IDS } from '../test/deviceFixtures';
import { loadDeviceIdentity } from '../device/identity';
import { listSessionIds } from '../session/sessionStore';
import type { WireDevice, WireDeviceRegistration } from '../api/deviceKeys';
import type { DeviceRegistrationResponse } from '../device/types';
import { switchE2eeAccountIfNeeded } from './switch';

const USER_A = DEVICE_IDS.user;
const USER_B = DEVICE_IDS.peerUser;
const DEVICE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function responseFromBody(body: WireDeviceRegistration, id: string): DeviceRegistrationResponse {
  const device: WireDevice = {
    id,
    name: 'switch test',
    platform: 'WEB',
    status: 'ACTIVE',
    e2ee_capable: true,
    key_generation: 1,
    identity_signing_key: body.identity_signing_key,
    identity_dh_key: body.identity_dh_key,
    identity_binding_signature: body.identity_binding_signature,
    identity_key_alg: 'Ed25519+X25519',
    signed_prekey: body.signed_prekey,
    created_at: new Date(DEFAULT_NOW).toISOString(),
  };
  return { device, replayed: false };
}

function makeTransport(ids: string[]): E2eeDeviceTransport {
  let index = 0;
  return {
    async registerDevice(body) {
      const id = ids[index] ?? ids[ids.length - 1] ?? DEVICE_B;
      index += 1;
      return responseFromBody(body, id);
    },
    async uploadPrekeys() {
      throw new Error('prekey upload is best effort in this test');
    },
    async claimPrekeys() {
      throw new Error('claim is not used by the switch test');
    },
    async getChatKeys() {
      throw new Error('chat keys are not used by the switch test');
    },
    async verifyDevice() {
      throw new Error('verification is not used by the switch test');
    },
  };
}

describe('E2EE account switch', () => {
  it('is a no-op when the identity matches or is absent', async () => {
    const world = await createTestWorld({ userId: USER_A, deviceId: DEVICE_IDS.device });
    expect(await switchE2eeAccountIfNeeded(world.storage, { userId: USER_A })).toBe('none');
    expect(await switchE2eeAccountIfNeeded(world.storage, { userId: USER_B })).toBe('switched');
    expect(await loadDeviceIdentity(world.storage, { userId: USER_B })).toBeNull();
    expect(await switchE2eeAccountIfNeeded(world.storage, { userId: USER_B })).toBe('none');
  });

  it('wipes A, registers B and can switch back (wipe + re-register)', async () => {
    const world = await createTestWorld({
      userId: USER_A,
      deviceId: DEVICE_IDS.device,
      now: DEFAULT_NOW,
    });
    const session = await createSession(
      world.storage,
      world.kStorage,
      await createTestSession({ deviceId: world.deviceId }),
    );
    expect(await listSessionIds(world.storage)).toContain(session.sessionId);

    const bridge = createE2eeBridge({
      storage: world.storage,
      transport: makeTransport([DEVICE_B, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc']),
      now: () => DEFAULT_NOW,
    });

    const asB = await bridge.initialize({
      userId: USER_B,
      name: 'switch test',
      appVersion: '0.7.0',
    });
    expect(asB.userId).toBe(USER_B);
    // A's session was attributable and is gone; the old identity is replaced.
    expect(await listSessionIds(world.storage)).not.toContain(session.sessionId);
    const identityB = await loadDeviceIdentity(world.storage, { userId: USER_B });
    expect(identityB).not.toBeNull();

    // Switching back is the same wipe + re-register flow, not a crash.
    const asA = await bridge.initialize({
      userId: USER_A,
      name: 'switch test',
      appVersion: '0.7.0',
    });
    expect(asA.userId).toBe(USER_A);
    const identityA = await loadDeviceIdentity(world.storage, { userId: USER_A });
    expect(identityA).not.toBeNull();
    expect(identityA?.record.deviceId).not.toBe(identityB?.record.deviceId);
  });
});

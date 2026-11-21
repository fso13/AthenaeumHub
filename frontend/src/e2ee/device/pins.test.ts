import { describe, expect, it } from 'vitest';
import {
  acceptKeyChange,
  acceptObservedKeyChange,
  assertDeviceNotBlocked,
  checkBundlePin,
  deletePin,
  evaluateChatKeysPins,
  evaluateClaimPins,
  getKeyChangeRecord,
  listPins,
  readPin,
} from './pins';
import { verifyClaimedBundle } from './binding';
import { decodePrekeyBundle } from '../api/deviceKeys';
import { encodeBase64Url } from '../encoding/base64url';
import { loadDeviceIdentity } from './identity';
import { pinAad } from './pinStore';
import { loadOrCreateKStorage } from '../storage/kStorage';
import { createMemoryE2eeStorage } from '../storage/memory';
import { getCurrentSignedPrekey } from '../session/prekeyStore';
import {
  DEVICE_IDS,
  makeChatKeysResponse,
  makeClaimResponse,
  makeDeviceFixture,
  makeWireBundle,
  registerFixtureDevice,
} from '../test/deviceFixtures';
import type { VerifiedClaimedBundle, LoadedDeviceIdentity } from './types';
import type { WirePrekeyBundle } from '../api/deviceKeys';
import type { E2eeStorage } from '../storage/types';

async function pinningDevice(): Promise<{
  storage: E2eeStorage;
  identity: LoadedDeviceIdentity;
}> {
  const fixture = await makeDeviceFixture();
  await registerFixtureDevice(fixture, { opkCount: 0 });
  const identity = await loadDeviceIdentity(fixture.storage, { userId: null });
  if (!identity) throw new Error('local identity missing');
  return { storage: fixture.storage, identity };
}

async function peerBundle(
  overrides: Partial<WirePrekeyBundle> = {},
): Promise<VerifiedClaimedBundle> {
  const storage = createMemoryE2eeStorage();
  const fixture = await makeDeviceFixture({ storage, userId: DEVICE_IDS.peerUser });
  const spk = await getCurrentSignedPrekey(storage);
  if (!spk) throw new Error('missing spk');
  return verifyClaimedBundle(decodePrekeyBundle(makeWireBundle(fixture.identity, spk, overrides)));
}

describe('TOFU pinning', () => {
  it('pins a first contact after verification, unverified and sealed', async () => {
    const { storage } = await pinningDevice();
    const bundle = await peerBundle();
    const check = await checkBundlePin(storage, bundle, { now: 1000, source: 'claim' });

    expect(check.status).toBe('first_contact');
    expect(check.keyChange).toBeNull();
    expect(check.pin.verified).toBe(false);
    expect(check.pin.firstSeen).toBe(1000);
    expect(check.pin.pinSource).toBe('claim');
    expect(check.pin.fingerprint).toBe(bundle.identity.fingerprintBase64Url);
    expect(await readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice)).toEqual(check.pin);

    const raw = await storage.get<Record<string, unknown>>(
      'pins',
      `pin:${DEVICE_IDS.peerUser}:${DEVICE_IDS.peerDevice}`,
    );
    expect(raw).not.toBeNull();
    expect(typeof raw?.ciphertext).toBe('string');
    expect(raw?.identitySigningKey).toBeUndefined();
    expect(JSON.stringify(raw)).not.toContain(bundle.identity.fingerprintBase64Url);
  });

  it('seals a pin with the normative device/user AAD slots (P2-18)', async () => {
    const { storage, identity } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    const raw = await storage.get<{ v: 1; nonce: string; ciphertext: string }>(
      'pins',
      `pin:${DEVICE_IDS.peerUser}:${DEVICE_IDS.peerDevice}`,
    );
    if (!raw) throw new Error('sealed pin missing');
    const deviceId = identity.record.deviceId;
    if (deviceId === null) throw new Error('device id missing');
    const kStorage = await loadOrCreateKStorage(storage, deviceId, {
      userId: identity.record.userId,
    });
    const fields = pinAad(DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice, 'pin');
    const plaintext = await kStorage.decrypt(raw, fields);
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as {
      userId: string;
      deviceId: string;
    };
    expect(decoded.userId).toBe(DEVICE_IDS.peerUser);
    expect(decoded.deviceId).toBe(DEVICE_IDS.peerDevice);

    // The user slot is authenticated: a different peer user cannot decrypt.
    await expect(
      kStorage.decrypt(raw, pinAad(DEVICE_IDS.user, DEVICE_IDS.peerDevice, 'pin')),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('fails closed when pins are listed for another local account (P1-04)', async () => {
    const fixture = await makeDeviceFixture();
    await registerFixtureDevice(fixture, { opkCount: 0 });
    const identity = await loadDeviceIdentity(fixture.storage, { userId: DEVICE_IDS.user });
    if (!identity) throw new Error('local identity missing');
    await checkBundlePin(fixture.storage, await peerBundle(), { now: 1000 });

    const own = await listPins(fixture.storage, {
      userId: identity.record.userId,
      deviceId: identity.record.deviceId,
    });
    expect(own).toHaveLength(1);

    // Target-device narrowing still works.
    expect(
      await listPins(fixture.storage, {
        userId: identity.record.userId,
        peerDeviceId: DEVICE_IDS.peerDevice,
      }),
    ).toHaveLength(1);
    expect(
      await listPins(fixture.storage, {
        userId: identity.record.userId,
        peerDeviceId: DEVICE_IDS.peerDevice2,
      }),
    ).toHaveLength(0);

    // A different local account must never read the single-slot pin store.
    await expect(listPins(fixture.storage, { userId: DEVICE_IDS.peerUser })).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });

  it('never touches a matching pin again', async () => {
    const { storage } = await pinningDevice();
    const bundle = await peerBundle();
    const first = await checkBundlePin(storage, bundle, { now: 1000 });
    const second = await checkBundlePin(storage, bundle, { now: 999_999 });

    expect(second.status).toBe('unchanged');
    expect(second.pin).toEqual(first.pin);
    expect(await listPins(storage, { userId: DEVICE_IDS.user })).toHaveLength(1);
  });

  it('detects a changed identity key, blocks and never overwrites the pin', async () => {
    const { storage } = await pinningDevice();
    const original = await peerBundle();
    const pin = await checkBundlePin(storage, original, { now: 1000 });
    const changed = await peerBundle({ device_id: DEVICE_IDS.peerDevice });
    const check = await checkBundlePin(storage, changed, { now: 2000 });

    expect(check.status).toBe('key_change');
    expect(check.pin).toEqual(pin.pin);
    expect(check.keyChange?.blocked).toBe(true);
    expect(check.keyChange?.detectedAt).toBe(2000);
    expect(check.keyChange?.pinned.fingerprint).toBe(pin.pin.fingerprint);
    expect(check.keyChange?.observed.fingerprint).toBe(changed.identity.fingerprintBase64Url);
    await expect(
      assertDeviceNotBlocked(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });
  });

  it('keeps the first key-change detection time on repeated mismatches', async () => {
    const { storage } = await pinningDevice();
    const original = await peerBundle();
    await checkBundlePin(storage, original, { now: 1000 });
    const changed = await peerBundle();
    const first = await checkBundlePin(storage, changed, { now: 2000 });
    const second = await checkBundlePin(storage, changed, { now: 3000 });
    expect(first.keyChange?.detectedAt).toBe(2000);
    expect(second.keyChange?.detectedAt).toBe(2000);
    expect(await listPins(storage, { userId: DEVICE_IDS.user })).toHaveLength(1);
  });

  it('treats a key_generation change as a key change', async () => {
    const { storage } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    const regenerated = await peerBundle({ key_generation: 2 });
    const check = await checkBundlePin(storage, regenerated, { now: 2000 });
    expect(check.status).toBe('key_change');
    expect(check.keyChange?.observed.keyGeneration).toBe(2);
  });

  it('accepts a new key only through an explicit action', async () => {
    const { storage } = await pinningDevice();
    const original = await peerBundle();
    await checkBundlePin(storage, original, { now: 1000 });
    const changed = await peerBundle();
    await checkBundlePin(storage, changed, { now: 2000 });
    await expect(
      assertDeviceNotBlocked(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).rejects.toBeDefined();

    const accepted = await acceptKeyChange(storage, changed, { now: 3000 });
    expect(accepted.identitySigningKey).toBe(encodeBase64Url(changed.identity.identitySigningKey));
    expect(accepted.verified).toBe(false);
    expect(accepted.verifiedAt).toBeNull();
    expect(accepted.acceptedAt).toBe(3000);
    expect(accepted.firstSeen).toBe(1000);
    expect(
      await getKeyChangeRecord(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).toBeNull();
    await expect(
      assertDeviceNotBlocked(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).resolves.toBeUndefined();
    const again = await checkBundlePin(storage, changed, { now: 4000 });
    expect(again.status).toBe('unchanged');
  });

  it('refuses to accept a substituted bundle that is not the persisted observed key', async () => {
    const { storage } = await pinningDevice();
    const original = await peerBundle();
    await checkBundlePin(storage, original, { now: 1000 });
    const changed = await peerBundle();
    const warning = await checkBundlePin(storage, changed, { now: 2000 });
    expect(warning.status).toBe('key_change');

    // A third key appears after the warning: the user never saw it.
    const substituted = await peerBundle();
    await expect(acceptKeyChange(storage, substituted, { now: 3000 })).rejects.toMatchObject({
      code: 'KEY_CHANGE_DETECTED',
    });

    // Nothing was overwritten: the old pin and the persisted observed remain.
    const pinned = await readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice);
    expect(pinned?.fingerprint).toBe(original.identity.fingerprintBase64Url);
    const persisted = await getKeyChangeRecord(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice);
    expect(persisted?.observed.fingerprint).toBe(changed.identity.fingerprintBase64Url);
    await expect(
      assertDeviceNotBlocked(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });

    // Accepting by (user, device) reads exactly the persisted observation.
    const accepted = await acceptObservedKeyChange(
      storage,
      DEVICE_IDS.peerUser,
      DEVICE_IDS.peerDevice,
      { now: 4000 },
    );
    expect(accepted.fingerprint).toBe(changed.identity.fingerprintBase64Url);
    expect(accepted.fingerprint).not.toBe(substituted.identity.fingerprintBase64Url);
    expect(
      await getKeyChangeRecord(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).toBeNull();
  });

  it('refuses to overwrite a pin when no key-change warning exists', async () => {
    const { storage } = await pinningDevice();
    const bundle = await peerBundle();
    await checkBundlePin(storage, bundle, { now: 1000 });
    await expect(acceptKeyChange(storage, bundle, { now: 2000 })).rejects.toMatchObject({
      code: 'KEY_CHANGE_DETECTED',
    });
    expect(
      await getKeyChangeRecord(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).toBeNull();
    expect((await readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice))?.acceptedAt).toBe(
      null,
    );
  });

  it('does not auto-accept on a later claim', async () => {
    const { storage } = await pinningDevice();
    const original = await peerBundle();
    await checkBundlePin(storage, original, { now: 1000 });
    const changed = await peerBundle();
    await checkBundlePin(storage, changed, { now: 2000 });
    const repeated = await checkBundlePin(storage, changed, { now: 3000 });
    expect(repeated.status).toBe('key_change');
    expect((await readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice))?.fingerprint).toBe(
      original.identity.fingerprintBase64Url,
    );
  });

  it('is keyed by (user, device): another device does not inherit trust', async () => {
    const { storage } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    const otherDevice = await peerBundle({ device_id: DEVICE_IDS.peerDevice2 });
    const check = await checkBundlePin(storage, otherDevice, { now: 2000 });
    expect(check.status).toBe('first_contact');
    expect(await listPins(storage, { userId: DEVICE_IDS.user })).toHaveLength(2);
  });

  it('deletes pins only on an explicit forget', async () => {
    const { storage } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    const changed = await peerBundle();
    await checkBundlePin(storage, changed, { now: 2000 });
    await deletePin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice);
    expect(await readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice)).toBeNull();
    expect(
      await getKeyChangeRecord(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).toBeNull();
    expect(await listPins(storage, { userId: DEVICE_IDS.user })).toHaveLength(0);
    expect((await checkBundlePin(storage, changed, { now: 3000 })).status).toBe('first_contact');
  });

  it('binds a sealed pin to its account and device scope', async () => {
    const { storage } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    const raw = await storage.get<unknown>(
      'pins',
      `pin:${DEVICE_IDS.peerUser}:${DEVICE_IDS.peerDevice}`,
    );
    await storage.put('pins', `pin:${DEVICE_IDS.user}:${DEVICE_IDS.peerDevice}`, raw);
    await expect(readPin(storage, DEVICE_IDS.user, DEVICE_IDS.peerDevice)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    await storage.put('pins', `pin:${DEVICE_IDS.peerUser}:${DEVICE_IDS.peerDevice2}`, raw);
    await expect(
      readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice2),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
  });

  it('fails closed when the sealing key disappeared', async () => {
    const { storage } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    await storage.delete('keys', 'k-storage:v1');
    await expect(
      readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
  });

  it('fails closed on a tampered sealed pin', async () => {
    const { storage } = await pinningDevice();
    await checkBundlePin(storage, await peerBundle(), { now: 1000 });
    const key = `pin:${DEVICE_IDS.peerUser}:${DEVICE_IDS.peerDevice}`;
    const raw = await storage.get<{ v: 1; nonce: string; ciphertext: string }>('pins', key);
    if (!raw) throw new Error('pin missing');
    const last = raw.ciphertext.slice(-1);
    await storage.put('pins', key, {
      ...raw,
      // Flip one base64url character; appending the same suffix twice would
      // make the "tamper" a no-op and turn this into a flaky test.
      ciphertext: `${raw.ciphertext.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`,
    });
    await expect(
      readPin(storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
  });
});

describe('claim and chat-keys pin flows', () => {
  it('evaluates a claim response with one requested peer', async () => {
    const { storage } = await pinningDevice();
    const peerStorage = createMemoryE2eeStorage();
    const fixture = await makeDeviceFixture({ storage: peerStorage, userId: DEVICE_IDS.peerUser });
    const spk = await getCurrentSignedPrekey(peerStorage);
    if (!spk) throw new Error('missing spk');
    const response = makeClaimResponse(makeWireBundle(fixture.identity, spk));
    const request = {
      chat_id: DEVICE_IDS.chat,
      devices: [{ device_id: DEVICE_IDS.peerDevice, user_id: DEVICE_IDS.peerUser }],
    };
    const result = await evaluateClaimPins(storage, response, request, { now: 1000 });
    expect(result.blocked).toBe(false);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]?.status).toBe('first_contact');
    expect(result.unavailable).toEqual([]);
  });

  it('pins peers from chat keys and keeps server verified out of local trust', async () => {
    const self = await pinningDevice();
    const peer = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.peerUser,
    });
    const response = makeChatKeysResponse(self.identity, peer.identity);
    response.devices[1]!.verified = true;
    const result = await evaluateChatKeysPins(self.storage, response, {
      chatId: DEVICE_IDS.chat,
      myDeviceId: DEVICE_IDS.device,
      localIdentity: self.identity,
      now: 1000,
    });
    expect(result.blocked).toBe(false);
    expect(result.selfVerified).toBe(true);
    expect(result.devices).toHaveLength(1);
    expect(result.devices[0]?.pin.verified).toBe(false);
    expect(result.devices[0]?.pin.pinSource).toBe('chat_keys');
  });

  it('blocks chat keys when the pinned peer identity changed', async () => {
    const self = await pinningDevice();
    const peer = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.peerUser,
    });
    const initial = makeChatKeysResponse(self.identity, peer.identity);
    await evaluateChatKeysPins(self.storage, initial, {
      chatId: DEVICE_IDS.chat,
      myDeviceId: DEVICE_IDS.device,
      localIdentity: self.identity,
      now: 1000,
    });
    const replaced = await makeDeviceFixture({
      storage: createMemoryE2eeStorage(),
      userId: DEVICE_IDS.peerUser,
    });
    const changed = makeChatKeysResponse(self.identity, replaced.identity);
    const result = await evaluateChatKeysPins(self.storage, changed, {
      chatId: DEVICE_IDS.chat,
      myDeviceId: DEVICE_IDS.device,
      localIdentity: self.identity,
      now: 2000,
    });
    expect(result.blocked).toBe(true);
    expect(result.devices[0]?.status).toBe('key_change');
    expect(
      (await readPin(self.storage, DEVICE_IDS.peerUser, DEVICE_IDS.peerDevice))?.fingerprint,
    ).toBe(peer.identity.record.fingerprint);
  });
});

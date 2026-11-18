import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from '../storage/memory';
import { loadOrCreateKStorage, K_STORAGE_RECORD_KEY } from '../storage/kStorage';
import {
  DEVICE_IDENTITY_DH_KEY,
  DEVICE_IDENTITY_RECORD_KEY,
  DEVICE_IDENTITY_SIGNING_KEY,
  bindDeviceIdentityUser,
  createDeviceIdentity,
  destroyDeviceIdentity,
  loadDeviceIdentity,
  readPendingDeviceRegistration,
  writePendingDeviceRegistration,
  randomUuid,
} from './identity';
import { verifyIdentityBinding } from '../protocol/signatures';
import { deviceFingerprint } from '../verification/fingerprint';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { bytesToHex, isUuid } from '../encoding/bytes';
import { createMemoryE2eeStorage as createStorage } from '../storage/memory';
import { collectStrings, dumpStorage } from '../test/fixtures';
import { DEVICE_IDS } from '../test/deviceFixtures';
import type { DeviceIdentityRecord } from './types';
import type { E2eeStorage } from '../storage/types';

async function identityStorage(): Promise<E2eeStorage> {
  return createMemoryE2eeStorage();
}

describe('device identity', () => {
  it('generates IK_sig/IK_dh with a valid binding signature and fingerprint', async () => {
    const storage = await identityStorage();
    const identity = await createDeviceIdentity(storage, { userId: DEVICE_IDS.user });
    const record = identity.record;

    expect(record.v).toBe(1);
    expect(record.userId).toBe(DEVICE_IDS.user);
    expect(record.deviceId).toBeNull();
    expect(record.state).toBe('unregistered');
    expect(record.keyGeneration).toBe(1);

    const signing = decodeBase64Url(record.identitySigningKey, 32);
    const dh = decodeBase64Url(record.identityDhKey, 32);
    const signature = decodeBase64Url(record.identityBindingSignature, 64);
    const fingerprint = await deviceFingerprint(signing, dh);

    expect(encodeBase64Url(fingerprint)).toBe(record.fingerprint);
    await expect(verifyIdentityBinding(signing, dh, signing, signature)).resolves.toBe(true);
  });

  it('stores private keys as non-extractable CryptoKeys', async () => {
    const storage = await identityStorage();
    const identity = await createDeviceIdentity(storage);
    const signing = await storage.get<CryptoKey>('keys', DEVICE_IDENTITY_SIGNING_KEY);
    const dh = await storage.get<CryptoKey>('keys', DEVICE_IDENTITY_DH_KEY);

    expect(signing?.type).toBe('private');
    expect(signing?.extractable).toBe(false);
    expect(dh?.type).toBe('private');
    expect(dh?.extractable).toBe(false);
    expect(identity.signingPrivateKey.extractable).toBe(false);
    expect(identity.dhPrivateKey.extractable).toBe(false);
  });

  it('loads the same identity twice and keeps the private/public pairing', async () => {
    const storage = await identityStorage();
    const first = await createDeviceIdentity(storage, { userId: DEVICE_IDS.user });
    const second = await loadDeviceIdentity(storage, { userId: null });

    expect(second?.record).toEqual(first.record);
    expect(second?.signingPrivateKey).toBeInstanceOf(CryptoKey);
    expect(second?.dhPrivateKey).toBeInstanceOf(CryptoKey);
  });

  it('converges on one identity when two tabs create it concurrently', async () => {
    const storage = await identityStorage();
    const [left, right] = await Promise.all([
      createDeviceIdentity(storage, { userId: DEVICE_IDS.user }),
      createDeviceIdentity(storage, { userId: DEVICE_IDS.user }),
    ]);

    expect(left.record).toEqual(right.record);
    expect(left.record.identitySigningKey).toBe(right.record.identitySigningKey);
    expect(await storage.keys('keys')).toHaveLength(3);
  });

  it('rejects an identity bound to another user', async () => {
    const storage = await identityStorage();
    await createDeviceIdentity(storage, { userId: DEVICE_IDS.user });
    await expect(
      createDeviceIdentity(storage, { userId: DEVICE_IDS.peerUser }),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });
  });

  it('binds a fresh identity to the authenticated user', async () => {
    const storage = await identityStorage();
    await createDeviceIdentity(storage);
    const record = await bindDeviceIdentityUser(storage, DEVICE_IDS.user);
    expect(record.userId).toBe(DEVICE_IDS.user);
    await expect(bindDeviceIdentityUser(storage, DEVICE_IDS.peerUser)).rejects.toMatchObject({
      code: 'DEVICE_IDENTITY_MISMATCH',
    });
  });

  it('rejects a tampered public record instead of silently regenerating keys', async () => {
    const storage = await identityStorage();
    const identity = await createDeviceIdentity(storage);
    const tampered: DeviceIdentityRecord = {
      ...identity.record,
      identityDhKey: encodeBase64Url(new Uint8Array(32).fill(1)),
    };
    await storage.put('keys', DEVICE_IDENTITY_RECORD_KEY, tampered);
    await expect(loadDeviceIdentity(storage, { userId: null })).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });

  it('rejects a swapped private signing key', async () => {
    const storage = await identityStorage();
    await createDeviceIdentity(storage);
    const otherStorage = await createStorage();
    const other = await createDeviceIdentity(otherStorage);
    await storage.put('keys', DEVICE_IDENTITY_SIGNING_KEY, other.signingPrivateKey);
    await expect(loadDeviceIdentity(storage, { userId: null })).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });

    expect(other.record.identitySigningKey).toBeDefined();
  });

  it('rejects a swapped private DH key', async () => {
    const storage = await identityStorage();
    await createDeviceIdentity(storage);
    const other = await createDeviceIdentity(await createStorage());
    await storage.put('keys', DEVICE_IDENTITY_DH_KEY, other.dhPrivateKey);
    await expect(loadDeviceIdentity(storage, { userId: null })).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });

  it('does not persist message plaintext together with device keys', async () => {
    const storage = await identityStorage();
    await createDeviceIdentity(storage, { userId: DEVICE_IDS.user });
    const dump = await dumpStorage(storage);
    expect(collectStrings(dump).join('|')).not.toContain('secret message text');
    expect(Object.keys(dump.keys ?? {})).toContain(DEVICE_IDENTITY_RECORD_KEY);
  });

  it('destroys identity material, K_storage, pins and pending registration', async () => {
    const storage = await identityStorage();
    await createDeviceIdentity(storage);
    await loadOrCreateKStorage(storage, DEVICE_IDS.device, { userId: null });
    await storage.put('pins', 'pin:test', { sealed: true });
    await writePendingDeviceRegistration(storage, {
      v: 1,
      idempotencyKey: randomUuid(),
      userId: null,
      body: { name: 'x', platform: 'WEB', app_version: '1' },
      createdAt: Date.now(),
    });
    expect(await readPendingDeviceRegistration(storage)).not.toBeNull();
    await destroyDeviceIdentity(storage);
    expect(await loadDeviceIdentity(storage, { userId: null })).toBeNull();
    expect(await readPendingDeviceRegistration(storage)).toBeNull();
    expect(await storage.get('keys', K_STORAGE_RECORD_KEY)).toBeNull();
    expect(await storage.keys('pins')).toEqual([]);
  });

  it('generates canonical UUIDs from the CSPRNG', () => {
    const uuid = randomUuid();
    expect(isUuid(uuid)).toBe(true);
    expect(uuid).not.toBe(randomUuid());
    expect(bytesToHex(decodeBase64Url(encodeBase64Url(new Uint8Array(3))))).toBe('000000');
  });
});

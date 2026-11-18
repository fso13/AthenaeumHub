/**
 * `K_storage` tests (§2.3, §3.4.6): non-extractable AES-GCM key, random nonce,
 * AAD separation, corruption handling and the honest "no at-rest promise"
 * boundary (clearing the key makes old ciphertext unreadable).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from './storage/memory';
import { createIndexedDbStorage } from './storage/indexedDb';
import {
  K_STORAGE_AAD_BYTES,
  K_STORAGE_AAD_OFFSETS,
  K_STORAGE_RECORD_KEY,
  buildKStorageAad,
  destroyKStorage,
  loadOrCreateKStorage,
  readKStorageRecord,
  type StoredKStorageRecord,
} from './storage/kStorage';
import { bytesToHex, hexToBytes } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';
import { bufferSource } from './crypto/bufferSource';
import { dumpStorage, dumpText, b64, bytes } from './test/fixtures';

const DEVICE = '11111111-1111-4111-8111-111111111111';
const OTHER_DEVICE = '22222222-2222-4222-8222-222222222222';
const USER = '44444444-4444-4444-8444-444444444444';
const OTHER_USER = '55555555-5555-4555-8555-555555555555';
const SESSION = b64(new Uint8Array(16).fill(1));
const CLIENT = '33333333-3333-4333-8333-333333333333';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * `K_storage` KAT (CR1 P1-07). Fixed key, nonce, AAD and plaintext; the
 * expected 50-byte AAD hex and the AES-256-GCM ciphertext||tag are pinned so a
 * layout change cannot pass silently. The vector is test-only; product code
 * always uses a random nonce and never exports the key.
 */
const KAT = {
  keyHex: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  deviceId: DEVICE,
  sessionId: b64(new Uint8Array(16).fill(0x22)),
  clientMessageId: CLIENT,
  nonceHex: '000102030405060708090a0b',
  plaintext: 'K_storage KAT v1',
  // UUID bytes are the RFC 4122 string bytes (version/variant nibbles included).
  aadHex:
    '11111111111141118111111111111111' +
    '22222222222222222222222222222222' +
    '33333333333343338333333333333333' +
    '01' +
    '01',
  ciphertextHex: '0c5da56faa97a37ce861dccae5c90e5c' + 'c22c1e5e0c3e4e636599666700217eae',
} as const;

let databaseCounter = 0;
function nextDatabaseName(): string {
  databaseCounter += 1;
  return `krug-e2ee-kstorage-${databaseCounter}`;
}

describe('K_storage', () => {
  it('creates a non-extractable AES-256-GCM key and persists it', async () => {
    const storage = createMemoryE2eeStorage();
    const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: USER });
    const record = await readKStorageRecord(storage);
    expect(record).not.toBeNull();
    expect(record?.userId).toBe(USER);
    expect(record?.deviceId).toBe(DEVICE);
    expect(record?.key.type).toBe('secret');
    expect(record?.key.extractable).toBe(false);
    expect((record?.key.algorithm as { name?: string }).name).toBe('AES-GCM');
    expect((record?.key.algorithm as { length?: number }).length).toBe(256);
    await expect(crypto.subtle.exportKey('raw', record?.key as CryptoKey)).rejects.toBeTruthy();
    expect(kStorage.ownerDeviceId).toBe(DEVICE);
    await storage.close();
  });

  it('reuses the same key on a later load', async () => {
    const storage = createMemoryE2eeStorage();
    const first = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    const record = await first.encrypt(bytes(8, 1), {
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'session',
    });
    const second = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    await expect(
      second.decrypt(record, {
        sessionId: SESSION,
        clientMessageId: CLIENT,
        recordType: 'session',
      }),
    ).resolves.toEqual(bytes(8, 1));
    await storage.close();
  });

  it('round-trips secrets with a random nonce per record', async () => {
    const storage = createMemoryE2eeStorage();
    const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    const fields = {
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'outbox' as const,
    };
    const first = await kStorage.encrypt(new TextEncoder().encode('hello'), fields);
    const second = await kStorage.encrypt(new TextEncoder().encode('hello'), fields);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    const decrypted = await kStorage.decrypt(first, fields);
    expect(new TextDecoder().decode(decrypted)).toBe('hello');
    await storage.close();
  });

  it('binds every AAD component: session, client message, record type, device', async () => {
    const storage = createMemoryE2eeStorage();
    const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    const record = await kStorage.encrypt(new TextEncoder().encode('bound'), {
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'session',
    });
    const wrong = [
      {
        sessionId: b64(new Uint8Array(16).fill(2)),
        clientMessageId: CLIENT,
        recordType: 'session' as const,
      },
      { sessionId: SESSION, clientMessageId: null, recordType: 'session' as const },
      { sessionId: SESSION, clientMessageId: CLIENT, recordType: 'outbox' as const },
      { sessionId: SESSION, clientMessageId: CLIENT, recordType: 'localCopy' as const },
    ];
    for (const fields of wrong) {
      await expect(kStorage.decrypt(record, fields)).rejects.toMatchObject({
        code: 'DECRYPT_FAILED',
      });
    }
    // CR1b P1-04: a different device/user scope cannot even load this key.
    await expect(
      loadOrCreateKStorage(storage, OTHER_DEVICE, { userId: null }),
    ).rejects.toMatchObject({
      code: 'DEVICE_IDENTITY_MISMATCH',
    });
    await loadOrCreateKStorage(storage, DEVICE, { userId: USER });
    await expect(
      loadOrCreateKStorage(storage, DEVICE, { userId: OTHER_USER }),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });
    await storage.close();
  });

  it('builds a deterministic 50-byte AAD and rejects malformed ids', () => {
    const aad = buildKStorageAad({
      ownerDeviceId: DEVICE,
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'session',
    });
    expect(aad.length).toBe(50);
    expect(
      buildKStorageAad({
        ownerDeviceId: DEVICE,
        sessionId: null,
        clientMessageId: null,
        recordType: 'session',
      }).length,
    ).toBe(50);
    expect(() =>
      buildKStorageAad({
        ownerDeviceId: 'not-a-uuid',
        recordType: 'session',
      }),
    ).toThrowError(expect.objectContaining({ code: 'KEY_STORAGE_UNAVAILABLE' }));
  });

  it('rejects malformed or corrupted encrypted records', async () => {
    const storage = createMemoryE2eeStorage();
    const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    const fields = { sessionId: SESSION, clientMessageId: CLIENT, recordType: 'session' as const };
    await expect(
      kStorage.decrypt({ v: 2, nonce: 'AAAA', ciphertext: 'AAAA' } as never, fields),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    await expect(
      kStorage.decrypt({ v: 1, nonce: 'AAAA', ciphertext: 'AAAA' }, fields),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    await storage.close();
  });

  it('does not store plaintext or the raw key in the record dump', async () => {
    const storage = createMemoryE2eeStorage();
    const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    await kStorage.encrypt(new TextEncoder().encode('TOP-SECRET-PLAINTEXT'), {
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'localCopy',
    });
    const text = dumpText(await dumpStorage(storage));
    expect(text).not.toContain('TOP-SECRET-PLAINTEXT');
    await storage.close();
  });

  it('converges on one key when two tabs provision concurrently', async () => {
    const databaseName = nextDatabaseName();
    const first = createIndexedDbStorage({ databaseName });
    const second = createIndexedDbStorage({ databaseName });
    const [a, b] = await Promise.all([
      loadOrCreateKStorage(first, DEVICE, { userId: null }),
      loadOrCreateKStorage(second, DEVICE, { userId: null }),
    ]);
    const record = await a.encrypt(bytes(16, 2), {
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'session',
    });
    await expect(
      b.decrypt(record, {
        sessionId: SESSION,
        clientMessageId: CLIENT,
        recordType: 'session',
      }),
    ).resolves.toEqual(bytes(16, 2));
    await first.close();
    await second.close();
  });

  it('makes old ciphertext unreadable after K_storage destruction (no unlock, no recovery)', async () => {
    const storage = createMemoryE2eeStorage();
    const first = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    const record = await first.encrypt(bytes(8, 3), {
      sessionId: SESSION,
      clientMessageId: CLIENT,
      recordType: 'session',
    });
    await destroyKStorage(storage);
    expect(await readKStorageRecord(storage)).toBeNull();
    const replacement = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
    await expect(
      replacement.decrypt(record, {
        sessionId: SESSION,
        clientMessageId: CLIENT,
        recordType: 'session',
      }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    await storage.close();
  });

  it('rejects a stored non-AES key as K_storage', async () => {
    const storage = createMemoryE2eeStorage();
    const ed25519 = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    await storage.put('keys', K_STORAGE_RECORD_KEY, ed25519.privateKey);
    await expect(loadOrCreateKStorage(storage, DEVICE, { userId: null })).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    await storage.close();
  });
});

describe('K_storage AAD KAT and injectivity (CR1 P1-07)', () => {
  it('pins the exact 50-byte AAD layout through buildKStorageAad', () => {
    const aad = buildKStorageAad({
      ownerDeviceId: KAT.deviceId,
      sessionId: KAT.sessionId,
      clientMessageId: KAT.clientMessageId,
      recordType: 'session',
    });
    expect(aad.length).toBe(K_STORAGE_AAD_BYTES);
    expect(aad.length).toBe(50);
    expect(bytesToHex(aad)).toBe(KAT.aadHex);
    expect(K_STORAGE_AAD_OFFSETS).toEqual({
      deviceId: 0,
      sessionId: 16,
      clientMessageId: 32,
      recordType: 48,
      version: 49,
    });
    expect(bytesToHex(aad.subarray(0, 16))).toBe('11111111111141118111111111111111');
    expect(bytesToHex(aad.subarray(16, 32))).toBe('22'.repeat(16));
    expect(bytesToHex(aad.subarray(32, 48))).toBe('33333333333343338333333333333333');
    expect(aad[K_STORAGE_AAD_OFFSETS.recordType]).toBe(1);
    expect(aad[K_STORAGE_AAD_OFFSETS.version]).toBe(1);
  });

  it('decrypts the fixed KAT ciphertext under the normative layout', async () => {
    const storage = createMemoryE2eeStorage();
    const raw = hexToBytes(KAT.keyHex);
    const key = await crypto.subtle.importKey('raw', bufferSource(raw), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ]);
    const stored: StoredKStorageRecord = {
      v: 1,
      userId: null,
      deviceId: KAT.deviceId,
      createdAt: 0,
      key,
    };
    await storage.put('keys', K_STORAGE_RECORD_KEY, stored);
    const kStorage = await loadOrCreateKStorage(storage, KAT.deviceId, { userId: null });
    const record = {
      v: 1 as const,
      nonce: encodeBase64Url(hexToBytes(KAT.nonceHex)),
      ciphertext: encodeBase64Url(hexToBytes(KAT.ciphertextHex)),
    };
    const fields = {
      sessionId: KAT.sessionId,
      clientMessageId: KAT.clientMessageId,
      recordType: 'session' as const,
    };
    const plaintext = await kStorage.decrypt(record, fields);
    expect(new TextDecoder().decode(plaintext)).toBe(KAT.plaintext);
    await expect(
      kStorage.decrypt(record, { ...fields, recordType: 'outbox' }),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    await expect(kStorage.decrypt(record, { ...fields, sessionId: null })).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
    await storage.close();
  });

  it('encodes absent ids as the zero sentinel and rejects nil values (injectivity)', () => {
    const absent = buildKStorageAad({
      ownerDeviceId: DEVICE,
      sessionId: null,
      clientMessageId: null,
      recordType: 'localCopy',
    });
    expect(bytesToHex(absent.subarray(16, 48))).toBe('0'.repeat(64));

    const rejects = [
      () => buildKStorageAad({ ownerDeviceId: NIL_UUID, recordType: 'session' }),
      () =>
        buildKStorageAad({
          ownerDeviceId: DEVICE,
          sessionId: b64(new Uint8Array(16)),
          recordType: 'session',
        }),
      () =>
        buildKStorageAad({
          ownerDeviceId: DEVICE,
          clientMessageId: NIL_UUID,
          recordType: 'localCopy',
        }),
      () =>
        buildKStorageAad({
          ownerDeviceId: DEVICE,
          sessionId: NIL_UUID,
          recordType: 'session',
        }),
    ];
    for (const call of rejects) {
      expect(call).toThrowError(expect.objectContaining({ code: 'KEY_STORAGE_UNAVAILABLE' }));
    }
  });
});

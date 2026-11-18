/**
 * Account/device isolation and logout wipe (E7-F2G, CR1b P1-04).
 *
 * Covers: A's identity/`K_storage` are not handed to B; logout clears every
 * E2EE store (not only keys/prekeys/pins) and a reload starts from scratch; the
 * production `clearAuthStorage()` hook is wired to the wipe.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { clearAuthStorage } from '../auth/storage';
import {
  commitDeviceRegistration,
  createDeviceIdentity,
  destroyDeviceIdentity,
  loadDeviceIdentity,
} from './device/identity';
import { clearE2eeAccountScope } from './account/scope';
import { clearE2eeAccountStateOnLogout } from './account/logout';
import {
  K_STORAGE_RECORD_KEY,
  destroyKStorage,
  loadOrCreateKStorage,
  readKStorageRecord,
} from './storage/kStorage';
import { createIndexedDbStorage } from './storage/indexedDb';
import { createMemoryE2eeStorage } from './storage/memory';
import { configureE2eeStorage } from './storage/runtime';
import { E2EE_STORE_NAMES, type E2eeStorage } from './storage/types';
import { utf8 } from './encoding/bytes';
import type { EncryptedRecord } from './storage/kStorage';

const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE_A = '11111111-1111-4111-8111-111111111111';
const DEVICE_B = '22222222-2222-4222-8222-222222222222';
const SESSION = 'IiIiIiIiIiIiIiIiIiIiIg';
const SESSION_B = 'MzMzMzMzMzMzMzMzMzMzMw';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const CLIENT_A = '44444444-4444-4444-8444-444444444444';
const CLIENT_B = '55555555-5555-4555-8555-555555555555';
const CHAT = '66666666-6666-4666-8666-666666666666';

const SEAL_FIELDS = {
  sessionId: SESSION,
  clientMessageId: CLIENT,
  recordType: 'session' as const,
};

let databaseCounter = 0;
function nextDatabaseName(): string {
  databaseCounter += 1;
  return `krug-e2ee-account-${databaseCounter}`;
}

afterEach(() => {
  configureE2eeStorage(null);
});

async function seededAccount(
  storage: E2eeStorage,
  account: string,
  device: string,
): Promise<EncryptedRecord> {
  await createDeviceIdentity(storage, { userId: account });
  await commitDeviceRegistration(storage, {
    deviceId: device,
    keyGeneration: 1,
    userId: account,
  });
  const kStorage = await loadOrCreateKStorage(storage, device, { userId: account });
  const sealed = await kStorage.encrypt(utf8(`${account} session secret`), SEAL_FIELDS);
  // Metadata mirrors the real records: the scoped wipe attributes rows by the
  // local device id and never decrypts them.
  await storage.put('sessions', `session:${SESSION}`, {
    v: 1,
    sessionId: SESSION,
    deviceId: device,
    chatId: CHAT,
    peerUserId: ACCOUNT_B,
    peerDeviceId: DEVICE_B,
    secrets: sealed,
  });
  await storage.put('outbox', `outbox:${CLIENT}`, {
    v: 1,
    clientMessageId: CLIENT,
    chatId: CHAT,
    sessionId: SESSION,
    senderDeviceId: device,
    status: 'pending',
    payload: sealed,
  });
  await storage.put('localMessages', `local:${CLIENT}`, {
    v: 1,
    key: `local:${CLIENT}`,
    localMessageId: CLIENT,
    clientMessageId: CLIENT,
    chatId: CHAT,
    sessionId: SESSION,
    direction: 'outgoing',
    senderDeviceId: device,
    status: 'pending',
    content: sealed,
  });
  await storage.put('prekeys', 'opk:test', sealed);
  await storage.put('pins', `pin:${account}:${DEVICE_B}`, sealed);
  return sealed;
}

/**
 * Seeds rows that carry the local device id in plaintext metadata, exactly as
 * the real session/outbox/local-copy records do. Only the fields the scoped
 * wipe reads are populated; the test never decrypts them.
 */
async function seedScopedRows(
  storage: E2eeStorage,
  input: {
    readonly deviceId: string;
    readonly peerUserId: string;
    readonly peerDeviceId: string;
    readonly sessionId: string;
    readonly clientMessageId: string;
  },
): Promise<{ readonly sessionKey: string; readonly outboxKey: string; readonly localKey: string }> {
  const sessionKey = `session:${input.sessionId}`;
  const outboxKey = `outbox:${input.clientMessageId}`;
  const localKey = `local:${CHAT}:outgoing:${input.deviceId}:c:${input.clientMessageId}`;
  await storage.put('sessions', sessionKey, {
    v: 1,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    chatId: CHAT,
    peerUserId: input.peerUserId,
    peerDeviceId: input.peerDeviceId,
  });
  await storage.put('sessions', `peer:${input.deviceId}:${CHAT}:${input.peerDeviceId}`, {
    v: 1,
    sessionIds: [input.sessionId],
  });
  await storage.put('outbox', outboxKey, {
    v: 1,
    clientMessageId: input.clientMessageId,
    chatId: CHAT,
    sessionId: input.sessionId,
    senderDeviceId: input.deviceId,
    status: 'pending',
  });
  await storage.put('localMessages', localKey, {
    v: 1,
    key: localKey,
    localMessageId: input.clientMessageId,
    clientMessageId: input.clientMessageId,
    chatId: CHAT,
    sessionId: input.sessionId,
    direction: 'outgoing',
    senderDeviceId: input.deviceId,
    status: 'pending',
  });
  return { sessionKey, outboxKey, localKey };
}

describe('account / device scope (P1-04)', () => {
  it('does not hand account A identity or K_storage to account B', async () => {
    const storage = createMemoryE2eeStorage();
    const sealed = await seededAccount(storage, ACCOUNT_A, DEVICE_A);

    // B can never load A's identity.
    await expect(loadDeviceIdentity(storage, { userId: ACCOUNT_B })).rejects.toMatchObject({
      code: 'DEVICE_IDENTITY_MISMATCH',
    });
    await expect(createDeviceIdentity(storage, { userId: ACCOUNT_B })).rejects.toMatchObject({
      code: 'DEVICE_IDENTITY_MISMATCH',
    });

    // B can never load A's K_storage, neither under A's device nor its own.
    await expect(
      loadOrCreateKStorage(storage, DEVICE_A, { userId: ACCOUNT_B }),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });
    await expect(
      loadOrCreateKStorage(storage, DEVICE_B, { userId: ACCOUNT_B }),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });

    // A's own scope still works, and A's sealed ciphertext is intact.
    const alice = await loadOrCreateKStorage(storage, DEVICE_A, { userId: ACCOUNT_A });
    const plaintext = await alice.decrypt(sealed, SEAL_FIELDS);
    expect(new TextDecoder().decode(plaintext)).toBe(`${ACCOUNT_A} session secret`);
    await storage.close();
  });

  it('binds an unauthenticated K_storage to the first scoped user exactly once', async () => {
    const storage = createMemoryE2eeStorage();
    const unbound = await loadOrCreateKStorage(storage, DEVICE_A, { userId: null });
    expect(unbound.ownerDeviceId).toBe(DEVICE_A);
    expect((await readKStorageRecord(storage))?.userId).toBeNull();

    // Binding happens atomically on first authenticated load.
    const bound = await loadOrCreateKStorage(storage, DEVICE_A, { userId: ACCOUNT_A });
    expect((await readKStorageRecord(storage))?.userId).toBe(ACCOUNT_A);
    expect(bound.ownerDeviceId).toBe(DEVICE_A);

    // Once bound, another account cannot adopt it.
    await expect(
      loadOrCreateKStorage(storage, DEVICE_A, { userId: ACCOUNT_B }),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });
    await storage.close();
  });

  it('wipes every E2EE store on the logout helper (not only keys/prekeys/pins)', async () => {
    const storage = createMemoryE2eeStorage();
    await seededAccount(storage, ACCOUNT_A, DEVICE_A);
    for (const store of E2EE_STORE_NAMES) {
      expect((await storage.keys(store)).length).toBeGreaterThan(0);
    }

    await destroyDeviceIdentity(storage);

    for (const store of E2EE_STORE_NAMES) {
      expect(await storage.keys(store)).toEqual([]);
    }
    expect(await loadDeviceIdentity(storage, { userId: null })).toBeNull();
    expect(await readKStorageRecord(storage)).toBeNull();
    await storage.close();
  });

  it('leaves no account state after clearAuthStorage and reload', async () => {
    const databaseName = nextDatabaseName();
    const storage = createIndexedDbStorage({ databaseName });
    configureE2eeStorage(storage);
    await seededAccount(storage, ACCOUNT_A, DEVICE_A);

    // The production logout path (mock/real providers call clearRuntimeAuth,
    // which calls clearAuthStorage).
    await clearAuthStorage();

    const reopened = createIndexedDbStorage({ databaseName });
    for (const store of E2EE_STORE_NAMES) {
      expect(await reopened.keys(store)).toEqual([]);
    }
    expect(await loadDeviceIdentity(reopened, { userId: null })).toBeNull();
    expect(await readKStorageRecord(reopened)).toBeNull();
    await expect(
      loadOrCreateKStorage(reopened, DEVICE_A, { userId: ACCOUNT_A }),
    ).resolves.toMatchObject({ ownerDeviceId: DEVICE_A });
    await reopened.close();
  });

  it('makes old ciphertext unreadable after logout even if it survived', async () => {
    const databaseName = nextDatabaseName();
    const first = createIndexedDbStorage({ databaseName });
    await createDeviceIdentity(first, { userId: ACCOUNT_A });
    await commitDeviceRegistration(first, {
      deviceId: DEVICE_A,
      keyGeneration: 1,
      userId: ACCOUNT_A,
    });
    const kStorage = await loadOrCreateKStorage(first, DEVICE_A, { userId: ACCOUNT_A });
    const sealed = await kStorage.encrypt(utf8('legacy secret'), SEAL_FIELDS);

    // Logout normally deletes the row; simulate the residual-ciphertext case.
    await destroyKStorage(first);
    const reopened = createIndexedDbStorage({ databaseName });
    const replacement = await loadOrCreateKStorage(reopened, DEVICE_A, {
      userId: ACCOUNT_A,
    });
    await expect(replacement.decrypt(sealed, SEAL_FIELDS)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
    expect(await reopened.get('keys', K_STORAGE_RECORD_KEY)).not.toBeNull();
    await first.close();
    await reopened.close();
  });

  it('logout of A removes only A-scoped rows and keeps account B intact', async () => {
    const storage = createMemoryE2eeStorage();
    // B owns the single persisted identity/K_storage/prekeys/pins.
    await seededAccount(storage, ACCOUNT_B, DEVICE_B);
    const bRows = await seedScopedRows(storage, {
      deviceId: DEVICE_B,
      peerUserId: ACCOUNT_A,
      peerDeviceId: DEVICE_A,
      sessionId: SESSION_B,
      clientMessageId: CLIENT_B,
    });
    const aRows = await seedScopedRows(storage, {
      deviceId: DEVICE_A,
      peerUserId: ACCOUNT_B,
      peerDeviceId: DEVICE_B,
      sessionId: SESSION,
      clientMessageId: CLIENT_A,
    });

    await clearE2eeAccountScope(storage, { userId: ACCOUNT_A, deviceId: DEVICE_A });

    // A's device-scoped rows and peer index are gone.
    expect(await storage.get('sessions', aRows.sessionKey)).toBeNull();
    expect(await storage.get('outbox', aRows.outboxKey)).toBeNull();
    expect(await storage.get('localMessages', aRows.localKey)).toBeNull();
    expect(await storage.get('sessions', `peer:${DEVICE_A}:${CHAT}:${DEVICE_B}`)).toBeNull();

    // B's rows, identity and K_storage survive: logout A is not a full wipe.
    expect(await storage.get('sessions', bRows.sessionKey)).not.toBeNull();
    expect(await storage.get('outbox', bRows.outboxKey)).not.toBeNull();
    expect(await storage.get('localMessages', bRows.localKey)).not.toBeNull();
    expect(await loadDeviceIdentity(storage, { userId: ACCOUNT_B })).not.toBeNull();
    expect((await readKStorageRecord(storage))?.userId).toBe(ACCOUNT_B);
    expect((await storage.keys('prekeys')).length).toBeGreaterThan(0);
    expect((await storage.keys('pins')).length).toBeGreaterThan(0);
    await storage.close();
  });

  it('the production logout hook keeps another account when A is not the identity owner', async () => {
    const databaseName = nextDatabaseName();
    const storage = createIndexedDbStorage({ databaseName });
    configureE2eeStorage(storage);
    await seededAccount(storage, ACCOUNT_B, DEVICE_B);
    const bRows = await seedScopedRows(storage, {
      deviceId: DEVICE_B,
      peerUserId: ACCOUNT_A,
      peerDeviceId: DEVICE_A,
      sessionId: SESSION_B,
      clientMessageId: CLIENT_B,
    });
    const aRows = await seedScopedRows(storage, {
      deviceId: DEVICE_A,
      peerUserId: ACCOUNT_B,
      peerDeviceId: DEVICE_B,
      sessionId: SESSION,
      clientMessageId: CLIENT_A,
    });

    await clearE2eeAccountStateOnLogout({ userId: ACCOUNT_A, deviceId: DEVICE_A });

    const reopened = createIndexedDbStorage({ databaseName });
    expect(await reopened.get('sessions', aRows.sessionKey)).toBeNull();
    expect(await reopened.get('outbox', aRows.outboxKey)).toBeNull();
    expect(await reopened.get('sessions', bRows.sessionKey)).not.toBeNull();
    expect(await reopened.get('outbox', bRows.outboxKey)).not.toBeNull();
    expect(await loadDeviceIdentity(reopened, { userId: ACCOUNT_B })).not.toBeNull();
    await reopened.close();
  });
});

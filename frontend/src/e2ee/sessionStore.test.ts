/**
 * Session store tests (§3.4.5, §3.4.5.1, §3.4.6).
 *
 * Covers versioned round-trips, non-extractable DH keys, the peer index,
 * optimistic-concurrency (stale tab), tamper/corruption detection, skipped-key
 * retention and destruction of superseded DH private keys.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from './storage/memory';
import { createIndexedDbStorage } from './storage/indexedDb';
import { loadOrCreateKStorage, type KStorage } from './storage/kStorage';
import {
  clearSessions,
  deleteSession,
  listSessionIds,
  listSessions,
  listSessionsByPeer,
  loadSession,
  prepareSessionRecord,
  pruneIdleSessions,
  sessionStorageKey,
  writeSessionRecord,
} from './session/sessionStore';
import { createSession, saveSession } from './test/sessionTestWrites';
import type { SessionState, StoredSessionRecord } from './session/types';
import { assertSkipWindow, pruneSkippedKeys } from './session/types';
import { generateX25519KeyPair, x25519SharedSecret } from './crypto/x25519';
import { kdfChainKey, kdfRootKey, deriveMessageAeadParams } from './protocol/kdf';
import { aesGcmEncrypt } from './crypto/aead';
import { ratchetReceive } from './session/ratchet';
import { utf8 } from './encoding/bytes';
import {
  IDS,
  b64,
  bytes,
  collectCryptoKeys,
  createTestSession,
  dumpStorage,
  dumpText,
  skippedKey,
  testSessionId,
} from './test/fixtures';

const DEVICE = IDS.device;

/**
 * Test-only facade over a loaded K_storage with a different owner id. Product
 * code can no longer load two owner-scoped K_storage keys from one profile
 * (CR1b P1-04), but the session store's own device checks still need a
 * foreign-owner KStorage handle to exercise them.
 */
function kStorageAs(kStorage: KStorage, ownerDeviceId: string): KStorage {
  return {
    ownerDeviceId,
    encrypt: (plaintext, fields) => kStorage.encrypt(plaintext, fields),
    decrypt: (record, fields) => kStorage.decrypt(record, fields),
  };
}

/** A real `KDF_CK` send step (E7-F5G: forged chain jumps are rejected). */
async function sendAdvance(state: SessionState): Promise<SessionState> {
  if (state.chainSend === null) throw new Error('test state has no sending chain');
  const step = await kdfChainKey(state.chainSend);
  return {
    ...state,
    ns: state.ns + 1,
    chainSend: step.nextChainKey,
    lastUsedAt: state.lastUsedAt + 1,
  };
}

/**
 * A real DH ratchet receive step: a fresh peer DH key, the exact KDF_RK/KDF_CK
 * derivation and an AEAD ciphertext for `n = 0`. Used to prove that legitimate
 * ratchet writes stay green under the E7-F5G store invariant.
 */
async function receiveRatchet(previous: SessionState): Promise<SessionState> {
  const peer = await generateX25519KeyPair();
  const receiving = await kdfRootKey(
    previous.rootKey,
    await x25519SharedSecret(previous.dhPrivateKey, peer.publicKey),
  );
  const step = await kdfChainKey(receiving.chainKey);
  const params = await deriveMessageAeadParams(step.messageKey);
  const ad = new Uint8Array(163);
  const ciphertext = await aesGcmEncrypt(params.key, params.nonce, utf8('ratchet'), ad);
  const result = await ratchetReceive(previous, {
    header: { v: 1, dh: peer.publicKeyBytes, pn: previous.nr, n: 0 },
    ciphertext,
    buildAd: () => ad,
  });
  return result.state;
}

let databaseCounter = 0;
function nextDatabaseName(): string {
  databaseCounter += 1;
  return `krug-e2ee-session-${databaseCounter}`;
}

async function memorySetup(): Promise<{
  storage: ReturnType<typeof createMemoryE2eeStorage>;
  kStorage: Awaited<ReturnType<typeof loadOrCreateKStorage>>;
}> {
  const storage = createMemoryE2eeStorage();
  const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
  return { storage, kStorage };
}

describe('session store round-trip', () => {
  it('persists every session field and keeps the DH key non-extractable', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession({ skipped: [skippedKey(3, 1_700_000_000_000)] });
    const created = await createSession(storage, kStorage, state, { now: 1_700_000_000_000 });
    expect(created.revision).toBe(1);

    const loaded = await loadSession(storage, kStorage, state.sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded?.sessionId).toBe(state.sessionId);
    expect(loaded?.chatId).toBe(IDS.chat);
    expect(loaded?.peerDeviceId).toBe(IDS.recipientDevice);
    expect(loaded?.peerIkSig).toEqual(state.peerIkSig);
    expect(loaded?.peerIkDh).toEqual(state.peerIkDh);
    expect(loaded?.rootKey).toEqual(state.rootKey);
    expect(loaded?.dhPublicKey).toEqual(state.dhPublicKey);
    expect(loaded?.chainSend).toEqual(state.chainSend);
    expect(loaded?.chainRecv).toBeNull();
    expect(loaded?.ns).toBe(0);
    expect(loaded?.nr).toBe(0);
    expect(loaded?.pn).toBe(0);
    expect(loaded?.revision).toBe(1);
    expect(loaded?.skipped[0]?.messageKey).toEqual(state.skipped[0]?.messageKey);
    expect(loaded?.skipped[0]?.createdAt).toBe(1_700_000_000_000);

    const privateKey = loaded?.dhPrivateKey as CryptoKey;
    expect(privateKey.extractable).toBe(false);
    const peer = await generateX25519KeyPair();
    const secret = await x25519SharedSecret(privateKey, peer.publicKey);
    expect(secret.length).toBe(32);
    await storage.close();
  });

  it('round-trips through IndexedDB preserving a usable non-extractable key', async () => {
    const databaseName = nextDatabaseName();
    const first = createIndexedDbStorage({ databaseName });
    const kStorage = await loadOrCreateKStorage(first, DEVICE, { userId: null });
    const state = await createTestSession();
    await createSession(first, kStorage, state);
    await first.close();

    const second = createIndexedDbStorage({ databaseName });
    const loaded = await loadSession(second, kStorage, state.sessionId);
    expect(loaded?.dhPublicKey).toEqual(state.dhPublicKey);
    const peer = await generateX25519KeyPair();
    await expect(
      x25519SharedSecret(loaded?.dhPrivateKey as CryptoKey, peer.publicKey),
    ).resolves.toHaveLength(32);
    await second.close();
  });

  it('does not persist plaintext root/chain keys', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    await createSession(storage, kStorage, state);
    const text = dumpText(await dumpStorage(storage));
    expect(text).not.toContain(b64(state.rootKey));
    expect(text).not.toContain(b64(state.chainSend as Uint8Array));
    await storage.close();
  });
});

describe('session device scoping', () => {
  it('rejects a session owned by another local device', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    await createSession(storage, kStorage, state);
    // P1-04: a second owner-scoped K_storage cannot even be loaded.
    await expect(
      loadOrCreateKStorage(storage, '12121212-1212-4212-8212-121212121212', { userId: null }),
    ).rejects.toMatchObject({ code: 'DEVICE_IDENTITY_MISMATCH' });
    const otherDevice = kStorageAs(kStorage, '12121212-1212-4212-8212-121212121212');
    await expect(loadSession(storage, otherDevice, state.sessionId)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    expect(await listSessionsByPeer(storage, otherDevice, IDS.chat, IDS.recipientDevice)).toEqual(
      [],
    );
    await storage.close();
  });

  it('scopes the peer index by local device', async () => {
    const { storage, kStorage } = await memorySetup();
    const otherDeviceId = '12121212-1212-4212-8212-121212121212';
    const first = await createTestSession({ sessionId: testSessionId(1) });
    const second = await createTestSession({
      sessionId: testSessionId(2),
      deviceId: otherDeviceId,
    });
    await createSession(storage, kStorage, first);
    const otherKStorage = kStorageAs(kStorage, otherDeviceId);
    await createSession(storage, otherKStorage, second);
    expect(await listSessionsByPeer(storage, kStorage, IDS.chat, IDS.recipientDevice)).toHaveLength(
      1,
    );
    expect(
      await listSessionsByPeer(storage, otherKStorage, IDS.chat, IDS.recipientDevice),
    ).toHaveLength(1);
    await storage.close();
  });
});

describe('session revisions and stale tabs', () => {
  it('increments the revision on every save and rejects a stale writer', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    const created = await createSession(storage, kStorage, state);
    const tabA = await loadSession(storage, kStorage, state.sessionId);
    const tabB = await loadSession(storage, kStorage, state.sessionId);
    expect(tabA?.revision).toBe(1);

    const savedB = await saveSession(storage, kStorage, await sendAdvance(tabB as SessionState), {
      ifRevision: 1,
    });
    expect(savedB.revision).toBe(2);

    await expect(
      saveSession(storage, kStorage, { ...(tabA as SessionState), ns: 95 }, { ifRevision: 1 }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });

    const reloaded = await loadSession(storage, kStorage, state.sessionId);
    expect(reloaded?.ns).toBe(1);
    const retried = await saveSession(
      storage,
      kStorage,
      await sendAdvance(reloaded as SessionState),
      {
        ifRevision: 2,
      },
    );
    expect(retried.revision).toBe(3);
    expect(created.revision).toBe(1);
    await storage.close();
  });

  it('rejects duplicate creation and update of a missing session', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    await createSession(storage, kStorage, state);
    await expect(createSession(storage, kStorage, state)).rejects.toMatchObject({
      code: 'SESSION_STATE_STALE',
    });
    const missing = await createTestSession({ sessionId: testSessionId(77) });
    await expect(saveSession(storage, kStorage, missing, { ifRevision: 1 })).rejects.toMatchObject({
      code: 'NO_SESSION',
    });
    await storage.close();
  });
});

describe('session indexes and lifecycle', () => {
  it('keeps multiple sessions per peer and cleans indexes on delete', async () => {
    const { storage, kStorage } = await memorySetup();
    const first = await createTestSession({ sessionId: testSessionId(1) });
    const second = await createTestSession({ sessionId: testSessionId(2) });
    const otherPeer = await createTestSession({
      sessionId: testSessionId(3),
      peerDeviceId: IDS.peerDevice2,
    });
    await createSession(storage, kStorage, first);
    await createSession(storage, kStorage, second);
    await createSession(storage, kStorage, otherPeer);

    expect(await listSessionIds(storage)).toEqual(
      [testSessionId(1), testSessionId(2), testSessionId(3)].sort(),
    );
    expect(await listSessionsByPeer(storage, kStorage, IDS.chat, IDS.recipientDevice)).toHaveLength(
      2,
    );
    expect(await listSessions(storage, kStorage)).toHaveLength(3);

    await deleteSession(storage, first.sessionId);
    expect(await loadSession(storage, kStorage, first.sessionId)).toBeNull();
    expect(await listSessionsByPeer(storage, kStorage, IDS.chat, IDS.recipientDevice)).toHaveLength(
      1,
    );
    await deleteSession(storage, first.sessionId);
    await clearSessions(storage);
    expect(await listSessionIds(storage)).toEqual([]);
    await storage.close();
  });

  it('prunes idle sessions after SESSION_IDLE_TTL', async () => {
    const { storage, kStorage } = await memorySetup();
    const now = 1_000_000_000_000;
    const old = await createTestSession({
      sessionId: testSessionId(1),
      lastUsedAt: 1_000,
    });
    const fresh = await createTestSession({
      sessionId: testSessionId(2),
      lastUsedAt: now - 1000,
    });
    await createSession(storage, kStorage, old);
    await createSession(storage, kStorage, fresh);
    const removed = await pruneIdleSessions(storage, kStorage, now);
    expect(removed).toEqual([old.sessionId]);
    expect(await loadSession(storage, kStorage, fresh.sessionId)).not.toBeNull();
    await storage.close();
  });
});

describe('session integrity and DH destruction', () => {
  it('detects corrupted ciphertext and tampered metadata', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    await createSession(storage, kStorage, state);
    const key = sessionStorageKey(state.sessionId);
    const raw = (await storage.get<StoredSessionRecord>('sessions', key)) as StoredSessionRecord;

    await storage.put('sessions', key, {
      ...raw,
      secrets: { ...raw.secrets, ciphertext: b64(bytes(64, 9)) },
    });
    await expect(loadSession(storage, kStorage, state.sessionId)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });

    await storage.put('sessions', key, { ...raw, ns: 41 });
    await expect(loadSession(storage, kStorage, state.sessionId)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    await storage.close();
  });

  it('drops the previous DH private key on save (only the current pair is stored)', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    const created = await createSession(storage, kStorage, state);
    const firstPublic = b64(state.dhPublicKey);

    const ratcheted = await receiveRatchet(created);
    await saveSession(storage, kStorage, ratcheted, { ifRevision: created.revision });

    const dump = await dumpStorage(storage);
    const text = dumpText(dump);
    expect(text).not.toContain(firstPublic);
    expect(text).toContain(b64(ratcheted.dhPublicKey));
    const records = Object.entries(dump.sessions ?? {}).filter(([key]) =>
      key.startsWith('session:'),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.[1]).toMatchObject({ dhPublicKey: b64(ratcheted.dhPublicKey) });
    await storage.close();
  });

  it('destroys every superseded DH key across several ratchet turns', async () => {
    const { storage, kStorage } = await memorySetup();
    let state = await createSession(storage, kStorage, await createTestSession());
    const oldPublicKeys: string[] = [b64(state.dhPublicKey)];
    for (let turn = 0; turn < 3; turn += 1) {
      const ratcheted = await receiveRatchet(state);
      state = await saveSession(storage, kStorage, ratcheted, { ifRevision: state.revision });
      oldPublicKeys.push(b64(state.dhPublicKey));
    }
    const dump = await dumpStorage(storage);
    const text = dumpText(dump);
    for (const oldPublic of oldPublicKeys.slice(0, -1)) {
      expect(text).not.toContain(oldPublic);
    }
    expect(text).toContain(oldPublicKeys[oldPublicKeys.length - 1] as string);
    const keys = collectCryptoKeys(dump).filter(
      (key) => key.type === 'private' && (key.algorithm as { name?: string }).name === 'X25519',
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.extractable).toBe(false);
    await storage.close();
  });

  it('rejects an extractable or missing private DH key', async () => {
    const { storage, kStorage } = await memorySetup();
    const extractable = (await crypto.subtle.generateKey({ name: 'X25519' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const state = await createTestSession();
    await expect(
      createSession(storage, kStorage, { ...state, dhPrivateKey: extractable.privateKey }),
    ).rejects.toMatchObject({ code: 'INVALID_KEY' });
    await storage.close();
  });
});

describe('skipped-key retention (§3.4.5.1)', () => {
  it('enforces per-session, per-chain and age limits', () => {
    const now = 1_000_000_000_000;
    const keys = [
      skippedKey(0, now - 1000),
      skippedKey(1, now - 900),
      skippedKey(2, now - 800),
      skippedKey(3, now - 700),
      skippedKey(4, now - 31 * 86_400_000),
    ];
    const trimmed = pruneSkippedKeys(keys, { now, maxTotal: 3, maxPerChain: 10 });
    expect(trimmed.kept).toHaveLength(3);
    expect(trimmed.evicted).toBe(2);
    expect(trimmed.kept.map((key) => key.n)).toEqual([1, 2, 3]);

    const perChain = pruneSkippedKeys(keys.slice(0, 4), { now, maxPerChain: 2 });
    expect(perChain.kept.map((key) => key.n)).toEqual([2, 3]);
    expect(perChain.evicted).toBe(2);

    const byAge = pruneSkippedKeys([keys[4] as never], { now });
    expect(byAge.kept).toEqual([]);
    expect(byAge.evicted).toBe(1);
  });

  it('applies retention during save instead of growing MKSKIPPED forever', async () => {
    const { storage, kStorage } = await memorySetup();
    const now = 1_700_000_000_000;
    const state = await createTestSession({
      skipped: [skippedKey(0, now - 3000), skippedKey(1, now - 2000), skippedKey(2, now - 1000)],
    });
    const created = await createSession(storage, kStorage, state, { now });
    expect(created.skipped.map((key) => key.n)).toEqual([0, 1, 2]);
    const loaded = await loadSession(storage, kStorage, state.sessionId);
    expect(loaded?.skipped.map((key) => key.n)).toEqual([0, 1, 2]);
    await storage.close();
  });

  it('guards a chain gap larger than MAX_SKIP', () => {
    expect(() => assertSkipWindow(0, 1000)).not.toThrow();
    expect(() => assertSkipWindow(0, 1001)).toThrowError(
      expect.objectContaining({ code: 'SESSION_TOO_FAR_BEHIND' }),
    );
  });
});

describe('CR1b P1-01R — session write invariants', () => {
  it('rejects a forged prepared record revision on update', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession();
    const created = await createSession(storage, kStorage, state);
    const prepared = await prepareSessionRecord(kStorage, created, { previous: created });
    const forged = { ...prepared.record, revision: created.revision + 5 };
    await expect(
      storage.transact(['sessions'], 'readwrite', async (transaction) =>
        writeSessionRecord(transaction, forged, { ifRevision: created.revision }),
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, state.sessionId))?.ns).toBe(0);
    await storage.close();
  });

  it('rejects a rewind of ns/nr and a scope change', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession({ ns: 5, nr: 3 });
    const created = await createSession(storage, kStorage, state);
    await expect(
      saveSession(storage, kStorage, { ...created, ns: 4 }, { ifRevision: created.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    await expect(
      saveSession(storage, kStorage, { ...created, nr: 0 }, { ifRevision: created.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    await expect(
      saveSession(
        storage,
        kStorage,
        { ...created, peerDeviceId: IDS.peerDevice2 },
        { ifRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    await expect(
      saveSession(
        storage,
        kStorage,
        { ...created, peerIkDh: bytes(32, 99) },
        { ifRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    const reloaded = await loadSession(storage, kStorage, state.sessionId);
    expect(reloaded?.ns).toBe(5);
    expect(reloaded?.nr).toBe(3);
    expect(reloaded?.peerDeviceId).toBe(IDS.recipientDevice);
    await storage.close();
  });

  it('allows a DH-ratchet counter reset (pn folds the old ns)', async () => {
    const { storage, kStorage } = await memorySetup();
    const state = await createTestSession({ ns: 4, nr: 2 });
    const created = await createSession(storage, kStorage, state);
    const ratcheted = await receiveRatchet(created);
    const saved = await saveSession(storage, kStorage, ratcheted, {
      ifRevision: created.revision,
    });
    expect(saved.ns).toBe(0);
    expect(saved.pn).toBe(4);
    await storage.close();
  });

  it('rejects a forged ns=0 without a new DH sending key (CR1c P1-01R-R)', async () => {
    const { storage, kStorage } = await memorySetup();
    const created = await createSession(
      storage,
      kStorage,
      await createTestSession({ ns: 5, nr: 0, pn: 2 }),
    );
    await expect(
      saveSession(
        storage,
        kStorage,
        { ...created, ns: 0, pn: 5 },
        { ifRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, created.sessionId))?.ns).toBe(5);
    await storage.close();
  });

  it('rejects ns=0 with a new DH but the old sending chain (E7-F5F chain commitment)', async () => {
    const { storage, kStorage } = await memorySetup();
    const created = await createSession(
      storage,
      kStorage,
      await createTestSession({ ns: 5, nr: 0, pn: 2, chainSend: bytes(32, 7) }),
    );
    await expect(
      saveSession(
        storage,
        kStorage,
        {
          ...created,
          ns: 0,
          pn: 5,
          dhPublicKey: bytes(32, 43),
          chainSend: created.chainSend,
        },
        { ifRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, created.sessionId))?.ns).toBe(5);
    await storage.close();
  });

  it('rejects a forward ns advance that keeps the old sending chain (E7-F5F)', async () => {
    const { storage, kStorage } = await memorySetup();
    const created = await createSession(
      storage,
      kStorage,
      await createTestSession({ ns: 2, chainSend: bytes(32, 8) }),
    );
    await expect(
      saveSession(
        storage,
        kStorage,
        { ...created, ns: 3, chainSend: created.chainSend },
        { ifRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, created.sessionId))?.ns).toBe(2);
    await storage.close();
  });

  it('does not expose arbitrary session writers from the production module (E7-F5F)', async () => {
    const production = await import('./session/sessionStore');
    expect('saveSession' in production).toBe(false);
    expect('createSession' in production).toBe(false);
  });

  it('rejects a forged ns=0 with the real pre-send CK0 (CR1c P1-01R-R probe)', async () => {
    const { storage, kStorage } = await memorySetup();
    const ck0 = bytes(32, 0x5a);
    const created = await createSession(
      storage,
      kStorage,
      await createTestSession({ ns: 0, chainSend: ck0 }),
    );
    const s1 = await saveSession(storage, kStorage, await sendAdvance(created), {
      ifRevision: created.revision,
    });
    const s2 = await saveSession(storage, kStorage, await sendAdvance(s1), {
      ifRevision: s1.revision,
    });
    expect(s2.ns).toBe(2);

    const forgedDh = await generateX25519KeyPair();
    const forgedRemote = await generateX25519KeyPair();
    // The real old CK0 (not the current chain): F5 accepted this and re-used
    // the message key/nonce of the first send.
    await expect(
      saveSession(
        storage,
        kStorage,
        {
          ...s2,
          ns: 0,
          pn: s2.ns,
          dhPrivateKey: forgedDh.privateKey,
          dhPublicKey: forgedDh.publicKeyBytes,
          dhRemote: forgedRemote.publicKeyBytes,
          chainSend: ck0,
        },
        { ifRevision: s2.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });

    const stored = await loadSession(storage, kStorage, s2.sessionId);
    expect(stored?.ns).toBe(2);
    expect(stored?.chainSend).not.toBeNull();
    expect(b64(stored?.chainSend as Uint8Array)).toBe(b64(s2.chainSend as Uint8Array));

    // No message key/nonce repeat: the next legitimate send derives a fresh MK.
    const reused = await kdfChainKey(ck0);
    const nextSend = await kdfChainKey(stored?.chainSend as Uint8Array);
    expect(b64(reused.messageKey)).not.toBe(b64(nextSend.messageKey));
    const reusedParams = await deriveMessageAeadParams(reused.messageKey);
    const nextParams = await deriveMessageAeadParams(nextSend.messageKey);
    expect(b64(reusedParams.nonce)).not.toBe(b64(nextParams.nonce));
    await storage.close();
  });

  it('rejects an advanced-n chain rewind to the real CK0', async () => {
    const { storage, kStorage } = await memorySetup();
    const ck0 = bytes(32, 0x33);
    const created = await createSession(
      storage,
      kStorage,
      await createTestSession({ ns: 0, chainSend: ck0 }),
    );
    const sent = await saveSession(storage, kStorage, await sendAdvance(created), {
      ifRevision: created.revision,
    });
    await expect(
      saveSession(
        storage,
        kStorage,
        { ...sent, ns: sent.ns + 1, chainSend: ck0 },
        { ifRevision: sent.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, sent.sessionId))?.ns).toBe(1);
    await storage.close();
  });

  it('rejects a forged nr=0 without a new remote DH key (CR1c P1-01R-R)', async () => {
    const { storage, kStorage } = await memorySetup();
    const created = await createSession(
      storage,
      kStorage,
      await createTestSession({ ns: 1, nr: 3, pn: 1, dhRemote: bytes(32, 61) }),
    );
    await expect(
      saveSession(
        storage,
        kStorage,
        { ...created, nr: 0, pn: created.pn + 1 },
        { ifRevision: created.revision },
      ),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, created.sessionId))?.nr).toBe(3);
    await storage.close();
  });
});

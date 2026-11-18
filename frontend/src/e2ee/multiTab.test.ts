/**
 * Multi-tab consistency tests (§3.4.6, §5.2).
 *
 * Two storage adapters opened on the same IndexedDB database stand in for two
 * browser tabs; a shared fake `LockManager` stands in for the browser's
 * cross-tab Web Locks. The invariants: one writer per session, no lost chain
 * advance, no duplicate outbox send, no key loss, and a stale tab fails loudly
 * instead of clobbering the newer state.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIndexedDbStorage } from './storage/indexedDb';
import { loadOrCreateKStorage } from './storage/kStorage';
import { listSessionsByPeer, loadSession } from './session/sessionStore';
import { createSession, saveSession } from './test/sessionTestWrites';
import { consumeOneTimePrekey, getOneTimePrekey, putOneTimePrekey } from './session/prekeyStore';
import {
  commitOutgoingMessage,
  drainOutbox,
  lookupLocalCopy,
  prepareOutgoingMessage,
  restorePendingOutbox,
} from './outbox/outboxStore';
import { createE2eeLockManager, sessionLockName } from './locks/locks';
import { generateX25519KeyPair } from './crypto/x25519';
import { kdfChainKey } from './protocol/kdf';
import type { SessionState } from './session/types';
import {
  IDS,
  b64,
  createFakeWebLocks,
  createTestSession,
  makeOutgoingDraft,
  testSessionId,
} from './test/fixtures';

const DEVICE = IDS.device;

/** Real KDF_CK send step (E7-F5G store invariant). */
async function sendStep(state: SessionState): Promise<SessionState> {
  if (state.chainSend === null) throw new Error('test state has no sending chain');
  const step = await kdfChainKey(state.chainSend);
  return {
    ...state,
    ns: state.ns + 1,
    chainSend: new Uint8Array(step.nextChainKey),
    lastUsedAt: state.lastUsedAt + 1,
  };
}

let databaseCounter = 0;
function nextDatabaseName(): string {
  databaseCounter += 1;
  return `krug-e2ee-multitab-${databaseCounter}`;
}

interface TwoTabs {
  readonly tabA: ReturnType<typeof createIndexedDbStorage>;
  readonly tabB: ReturnType<typeof createIndexedDbStorage>;
  readonly locks: ReturnType<typeof createFakeWebLocks>;
  readonly firstManager: ReturnType<typeof createE2eeLockManager>;
  readonly secondManager: ReturnType<typeof createE2eeLockManager>;
  readonly cleanup: () => Promise<void>;
}

async function openTwoTabs(): Promise<TwoTabs> {
  const databaseName = nextDatabaseName();
  const tabA = createIndexedDbStorage({ databaseName });
  const tabB = createIndexedDbStorage({ databaseName });
  const locks = createFakeWebLocks();
  const firstManager = createE2eeLockManager({ locks });
  const secondManager = createE2eeLockManager({ locks });
  return {
    tabA,
    tabB,
    locks,
    firstManager,
    secondManager,
    async cleanup() {
      firstManager.close();
      secondManager.close();
      await tabA.close();
      await tabB.close();
    },
  };
}

describe('two tabs, one session writer', () => {
  it('serialises concurrent chain advances without losing an update', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession();
    await createSession(tabs.tabA, kStorage, state);

    const advance = async (
      storage: ReturnType<typeof createIndexedDbStorage>,
      manager: ReturnType<typeof createE2eeLockManager>,
    ) => {
      await manager.withLock(sessionLockName(state.sessionId), async () => {
        const current = await loadSession(storage, kStorage, state.sessionId);
        if (!current) throw new Error('missing');
        await saveSession(storage, kStorage, await sendStep(current), {
          ifRevision: current.revision,
        });
      });
    };

    await Promise.all([
      advance(tabs.tabA, tabs.firstManager),
      advance(tabs.tabB, tabs.secondManager),
    ]);

    const final = await loadSession(tabs.tabA, kStorage, state.sessionId);
    expect(final?.ns).toBe(2);
    expect(final?.revision).toBe(3);
    await tabs.cleanup();
  });

  it('fails a stale write and succeeds after reloading under the lock', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession();
    await createSession(tabs.tabA, kStorage, state);
    const stale = await loadSession(tabs.tabB, kStorage, state.sessionId);
    const fresh = await loadSession(tabs.tabA, kStorage, state.sessionId);

    await saveSession(tabs.tabA, kStorage, await sendStep(fresh as SessionState), {
      ifRevision: fresh!.revision,
    });

    await expect(
      saveSession(tabs.tabB, kStorage, { ...(stale as SessionState), ns: 9 }, { ifRevision: 1 }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });

    await tabs.secondManager.withLock(sessionLockName(state.sessionId), async () => {
      const current = await loadSession(tabs.tabB, kStorage, state.sessionId);
      expect(current?.ns).toBe(1);
      const saved = await saveSession(
        tabs.tabB,
        kStorage,
        await sendStep(current as SessionState),
        { ifRevision: current!.revision },
      );
      expect(saved.revision).toBe(3);
    });

    const final = await loadSession(tabs.tabA, kStorage, state.sessionId);
    expect(final?.ns).toBe(2);
    expect(final?.dhPrivateKey.extractable).toBe(false);
    await tabs.cleanup();
  });

  it('lets only one tab create the same session id', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession({ sessionId: testSessionId(42) });
    const results = await Promise.allSettled([
      createSession(tabs.tabA, kStorage, state),
      createSession(tabs.tabB, kStorage, state),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      await listSessionsByPeer(tabs.tabB, kStorage, IDS.chat, IDS.recipientDevice),
    ).toHaveLength(1);
    await tabs.cleanup();
  });

  it('keeps non-extractable key material usable after a tab reload', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession();
    await createSession(tabs.tabA, kStorage, state);
    await tabs.tabA.close();

    const loaded = await loadSession(tabs.tabB, kStorage, state.sessionId);
    const peer = await generateX25519KeyPair();
    const { x25519SharedSecret } = await import('./crypto/x25519');
    await expect(
      x25519SharedSecret(loaded?.dhPrivateKey as CryptoKey, peer.publicKey),
    ).resolves.toHaveLength(32);
    await tabs.cleanup();
  });
});

describe('two tabs, one outbox sender', () => {
  it('sends each outbox row exactly once', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession();
    const created = await createSession(tabs.tabA, kStorage, state);
    const draft = await makeOutgoingDraft(created);
    await commitOutgoingMessage(tabs.tabA, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: created.revision,
    });
    expect(await restorePendingOutbox(tabs.tabB, kStorage)).toHaveLength(1);
    expect(
      (await lookupLocalCopy(tabs.tabB, kStorage, IDS.chat, draft.clientMessageId)).available,
    ).toBe(true);

    const sends: string[] = [];
    const send = async () => {
      sends.push('send');
      return { serverMessageId: IDS.serverMessage, seq: 1 };
    };
    const [first, second] = await Promise.all([
      drainOutbox(tabs.tabA, kStorage, tabs.firstManager, send),
      drainOutbox(tabs.tabB, kStorage, tabs.secondManager, send),
    ]);
    expect(sends).toHaveLength(1);
    expect(first.sent.length + second.sent.length).toBe(1);
    expect(await restorePendingOutbox(tabs.tabA, kStorage)).toEqual([]);
    await tabs.cleanup();
  });

  it('does not double-encrypt or overwrite the committed local copy', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession();
    const created = await createSession(tabs.tabA, kStorage, state);
    const draft = await makeOutgoingDraft(created);
    await commitOutgoingMessage(tabs.tabA, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: created.revision,
    });
    const copyA = await lookupLocalCopy(tabs.tabA, kStorage, IDS.chat, draft.clientMessageId);
    const copyB = await lookupLocalCopy(tabs.tabB, kStorage, IDS.chat, draft.clientMessageId);
    expect(copyA).toEqual(copyB);
    await tabs.cleanup();
  });
});

describe('two tabs, one prekey', () => {
  it('consumes an OPK exactly once across adapters', async () => {
    const tabs = await openTwoTabs();
    const pair = await generateX25519KeyPair();
    await putOneTimePrekey(tabs.tabA, {
      v: 1,
      keyId: 'opk-shared',
      publicKey: b64(pair.publicKeyBytes),
      privateKey: pair.privateKey,
      createdAt: 1_700_000_000_000,
      expiresAt: 1_700_000_000_000 + 30 * 86_400_000,
    });
    const results = await Promise.allSettled([
      consumeOneTimePrekey(tabs.tabA, 'opk-shared', 1_700_000_000_001),
      consumeOneTimePrekey(tabs.tabB, 'opk-shared', 1_700_000_000_001),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await getOneTimePrekey(tabs.tabB, 'opk-shared')).toBeNull();
    await tabs.cleanup();
  });
});

describe('two tabs, verification invariants', () => {
  it('does not lose a session when the other tab writes a different peer index', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const first = await createTestSession({ sessionId: testSessionId(1) });
    const second = await createTestSession({
      sessionId: testSessionId(2),
      peerDeviceId: IDS.peerDevice2,
    });
    await Promise.all([
      createSession(tabs.tabA, kStorage, first),
      createSession(tabs.tabB, kStorage, second),
    ]);
    expect(
      await listSessionsByPeer(tabs.tabA, kStorage, IDS.chat, IDS.recipientDevice),
    ).toHaveLength(1);
    expect(await listSessionsByPeer(tabs.tabB, kStorage, IDS.chat, IDS.peerDevice2)).toHaveLength(
      1,
    );
    await tabs.cleanup();
  });

  it('keeps persisted bytes stable for a repeated restore', async () => {
    const tabs = await openTwoTabs();
    const kStorage = await loadOrCreateKStorage(tabs.tabA, DEVICE, { userId: null });
    const state = await createTestSession();
    const created = await createSession(tabs.tabA, kStorage, state);
    const draft = await makeOutgoingDraft(created);
    await commitOutgoingMessage(tabs.tabA, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: created.revision,
    });
    const [a] = await restorePendingOutbox(tabs.tabA, kStorage);
    const [b] = await restorePendingOutbox(tabs.tabB, kStorage);
    expect(b?.envelopes).toEqual(a?.envelopes);
    expect(b?.idempotencyKey).toBe(a?.idempotencyKey);
    expect((await loadSession(tabs.tabB, kStorage, state.sessionId))?.revision).toBe(
      created.revision + 1,
    );
    await tabs.cleanup();
  });
});

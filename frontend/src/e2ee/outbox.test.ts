/**
 * Outbox / local-copy tests: the P0-4 crash/replay matrix (§3.4.6).
 *
 * A send may only touch the network after one transaction commits state +
 * exact envelopes + idempotency key + sealed local copy. These tests reconstruct
 * every crash point, prove restore is byte-identical, and prove two workers
 * cannot send the same row twice.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createMemoryE2eeStorage } from './storage/memory';
import { loadOrCreateKStorage } from './storage/kStorage';
import { loadSession, sessionStorageKey } from './session/sessionStore';
import { kdfChainKey } from './protocol/kdf';
import { createSession } from './test/sessionTestWrites';
import type { SessionState } from './session/types';
import type { OutboxEntry, StoredLocalMessageCopy, StoredOutboxEntry } from './outbox/types';
import type { OutgoingMessageDraft, PreparedOutgoingMessage } from './outbox/outboxStore';
import {
  commitIncomingMessage,
  commitOutgoingMessage,
  drainOutbox,
  localCopyStorageKey,
  lookupLocalCopy,
  listDrainCandidates,
  markOutboxAttempt,
  markOutboxFailed,
  markOutboxSent,
  markOutboxSuperseded,
  outboxBackoffMs,
  outboxRetryStatus,
  outboxStorageKey,
  putRetryState,
  listRetryStates,
  getRetryState,
  deleteRetryState,
  reconcileOutbox,
  prepareIncomingMessage,
  prepareOutgoingMessage,
  readLocalMessageCopy,
  listLocalCopyKeys,
  readOutboxEntry,
  restorePendingOutbox,
  retryOutboxEntry,
} from './outbox/outboxStore';
import { createE2eeLockManager } from './locks/locks';
import { createFakeWebLocks } from './test/fixtures';
import {
  IDS,
  b64,
  bytes,
  createInMemoryChannelBus,
  createManualScheduler,
  createTestSession,
  dumpStorage,
  dumpText,
  makeLocalCopyDraft,
  makeOutgoingDraft,
  testSessionId,
} from './test/fixtures';

const DEVICE = IDS.device;

async function setup(): Promise<{
  storage: ReturnType<typeof createMemoryE2eeStorage>;
  kStorage: Awaited<ReturnType<typeof loadOrCreateKStorage>>;
  session: SessionState;
  sessionRevision: number;
}> {
  const storage = createMemoryE2eeStorage();
  const kStorage = await loadOrCreateKStorage(storage, DEVICE, { userId: null });
  const state = await createTestSession({ chainRecv: bytes(32, 31) });
  const created = await createSession(storage, kStorage, state);
  return { storage, kStorage, session: created, sessionRevision: created.revision };
}

/** A real same-chain receive advance (`nr + steps`, KDF_CK chain). */
async function receiveAdvance(state: SessionState, steps = 1): Promise<SessionState> {
  if (state.chainRecv === null) throw new Error('test state has no receiving chain');
  let chain: Uint8Array = state.chainRecv;
  for (let step = 0; step < steps; step += 1) {
    chain = new Uint8Array((await kdfChainKey(chain)).nextChainKey);
  }
  return { ...state, nr: state.nr + steps, chainRecv: chain, lastUsedAt: state.lastUsedAt + 1 };
}

describe('atomic outgoing commit', () => {
  it('commits state + exact outbox bytes + sealed local copy in one transaction', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    const updated = await commitOutgoingMessage(storage, prepared, {
      ifRevision: session.revision,
    });
    expect(updated?.revision).toBe(session.revision + 1);

    const restored = await restorePendingOutbox(storage, kStorage);
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      clientMessageId: draft.clientMessageId,
      chatId: IDS.chat,
      sessionId: session.sessionId,
      type: 'TEXT_JSON',
      idempotencyKey: draft.idempotencyKey,
      attempts: 0,
      status: 'pending',
    });
    expect(restored[0]?.envelopes).toEqual(draft.envelopes);
    expect(restored[0]?.recipientDeviceIds).toEqual([IDS.recipientDevice]);

    const copy = await lookupLocalCopy(storage, kStorage, IDS.chat, draft.clientMessageId);
    expect(copy.available).toBe(true);
    if (copy.available) {
      expect(copy.copy.text).toBe('hello E2EE');
      expect(copy.copy.direction).toBe('outgoing');
      expect(copy.copy.status).toBe('pending');
      expect(copy.copy.ciphertexts).toEqual([draft.envelopes[0]!.ciphertext]);
    }

    const dump = dumpText(await dumpStorage(storage));
    expect(dump).not.toContain('hello E2EE');
    await storage.close();
  });

  it('writes nothing before commit (crash before commit)', async () => {
    const { storage, kStorage, session } = await setup();
    await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session));
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    expect(await storage.get('sessions', sessionStorageKey(session.sessionId))).toMatchObject({
      revision: session.revision,
    });
    const copy = await lookupLocalCopy(
      storage,
      kStorage,
      IDS.chat,
      (await makeOutgoingDraft(session)).clientMessageId,
    );
    expect(copy.available).toBe(false);
    await storage.close();
  });

  it('aborts the session write when the outbox/local-copy part conflicts', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session, {
      clientMessageId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      localMessageId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      idempotencyKey: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    });
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    await storage.put('localMessages', prepared.localCopy.key, { conflict: true });
    await expect(
      commitOutgoingMessage(storage, prepared, { ifRevision: session.revision }),
    ).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });
    const after = await loadSession(storage, kStorage, session.sessionId);
    expect(after?.revision).toBe(session.revision);
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });

  it('rejects duplicate commit of the same client message', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    const updated = (await commitOutgoingMessage(storage, prepared, {
      ifRevision: session.revision,
    })) as SessionState;

    // CR1b P1-01R: the *same* prepared record (old revision) cannot be replayed
    // under a fresh compare-and-swap token — that is a stale forged shift.
    await expect(
      commitOutgoingMessage(storage, prepared, { ifRevision: updated.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });

    // A correctly prepared record for the same client_message_id is a duplicate.
    const replay = await prepareOutgoingMessage(
      kStorage,
      await makeOutgoingDraft(updated, {
        ...draft,
        sessionState: updated,
        previousSessionState: updated,
      }),
    );
    await expect(
      commitOutgoingMessage(storage, replay, { ifRevision: updated.revision }),
    ).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });
    await storage.close();
  });

  it('validates envelopes and text before any write', async () => {
    const { storage, kStorage, session } = await setup();
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...(await makeOutgoingDraft(session)),
        envelopes: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_FORMAT' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...(await makeOutgoingDraft(session)),
        text: 'x'.repeat(8001),
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });
});

describe('send/replay lifecycle', () => {
  it('marks sent idempotently and updates the local copy', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    await commitOutgoingMessage(storage, prepared, { ifRevision: session.revision });

    const server = { serverMessageId: IDS.serverMessage, seq: 7 };
    await markOutboxSent(storage, draft.clientMessageId, server, { now: 10 });
    await markOutboxSent(storage, draft.clientMessageId, server, { now: 11 });
    await expect(
      markOutboxSent(storage, draft.clientMessageId, {
        serverMessageId: IDS.serverMessage,
        seq: 8,
      }),
    ).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });

    const entry = await readOutboxEntry(storage, kStorage, draft.clientMessageId);
    expect(entry).toMatchObject({ status: 'sent', serverMessageId: IDS.serverMessage, seq: 7 });
    const copy = await lookupLocalCopy(storage, kStorage, IDS.chat, draft.clientMessageId);
    expect(copy.available && copy.copy.status).toBe('sent');
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });

  it('keeps the same bytes during replay (never re-encrypts after a crash)', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    await commitOutgoingMessage(storage, prepared, { ifRevision: session.revision });

    const first = (await restorePendingOutbox(storage, kStorage))[0] as OutboxEntry;
    const second = (await restorePendingOutbox(storage, kStorage))[0] as OutboxEntry;
    expect(second.envelopes).toEqual(first.envelopes);
    expect(second.idempotencyKey).toBe(first.idempotencyKey);
    expect(await loadSession(storage, kStorage, session.sessionId)).toMatchObject({
      revision: session.revision + 1,
    });
    await storage.close();
  });

  it('tracks attempts, failed retry and supersede transitions', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    expect(await markOutboxAttempt(storage, draft.clientMessageId)).toBe(1);
    expect(await markOutboxAttempt(storage, draft.clientMessageId)).toBe(2);
    await markOutboxFailed(storage, draft.clientMessageId, 'NETWORK');
    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.status).toBe(
      'failed',
    );
    await retryOutboxEntry(storage, draft.clientMessageId);
    expect(await restorePendingOutbox(storage, kStorage)).toHaveLength(1);
    await markOutboxSuperseded(storage, draft.clientMessageId);
    const entry = await readOutboxEntry(storage, kStorage, draft.clientMessageId);
    expect(entry?.status).toBe('superseded');
    const copy = await lookupLocalCopy(storage, kStorage, IDS.chat, draft.clientMessageId);
    expect(copy.available && copy.copy.status).toBe('superseded');
    await storage.close();
  });

  it('supersedes the local copy after sent so reload does not duplicate R-15', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    await commitOutgoingMessage(storage, prepared, { ifRevision: session.revision });

    await markOutboxSent(storage, draft.clientMessageId, {
      serverMessageId: IDS.serverMessage,
      seq: 7,
    });
    await markOutboxSuperseded(storage, draft.clientMessageId);

    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.status).toBe('sent');
    const copy = await lookupLocalCopy(storage, kStorage, IDS.chat, draft.clientMessageId);
    expect(copy.available && copy.copy.status).toBe('superseded');
    await storage.close();
  });

  it('reports an honest "unavailable on this device" copy after cache loss', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    await storage.delete(
      'localMessages',
      localCopyStorageKey({
        chatId: IDS.chat,
        direction: 'outgoing',
        senderDeviceId: DEVICE,
        clientMessageId: draft.clientMessageId,
        localMessageId: draft.localMessageId,
      }),
    );
    const lookup = await lookupLocalCopy(storage, kStorage, IDS.chat, draft.clientMessageId);
    expect(lookup).toEqual({ available: false, clientMessageId: draft.clientMessageId });
    const entry = await readOutboxEntry(storage, kStorage, draft.clientMessageId);
    expect(entry?.clientMessageId).toBe(draft.clientMessageId);
    await storage.close();
  });

  it('detects a tampered outbox payload', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const key = outboxStorageKey(draft.clientMessageId);
    const raw = (await storage.get<Record<string, unknown>>('outbox', key)) as Record<
      string,
      unknown
    >;
    await storage.put('outbox', key, {
      ...raw,
      status: 'sent',
      seq: 1,
      serverMessageId: IDS.serverMessage,
    });
    // Payload is still the old pending ciphertext, but AAD/JSON is intact; the
    // tamper that matters is the encrypted body.
    await storage.put('outbox', key, {
      ...raw,
      payload: { v: 1, nonce: b64(bytes(12, 1)), ciphertext: b64(bytes(32, 2)) },
    });
    await expect(readOutboxEntry(storage, kStorage, draft.clientMessageId)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    await storage.close();
  });
});

describe('outbox worker', () => {
  it('sends every pending entry once and marks it sent', async () => {
    const { storage, kStorage, session } = await setup();
    const first = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, first);
    const updated = await commitOutgoingMessage(storage, prepared, {
      ifRevision: session.revision,
    });
    const second = await makeOutgoingDraft(updated as SessionState, {
      clientMessageId: 'abababab-abab-4bab-8bab-abababababab',
      localMessageId: 'acacacac-acac-4cac-8cac-acacacacacac',
      idempotencyKey: 'adadadad-adad-4dad-8dad-adadadadadad',
    });
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, second), {
      ifRevision: (updated as SessionState).revision,
    });

    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    const calls: string[] = [];
    const result = await drainOutbox(storage, kStorage, locks, async (entry) => {
      calls.push(entry.idempotencyKey);
      return { serverMessageId: IDS.serverMessage, seq: calls.length - 1 };
    });
    expect(result.sent).toEqual([first.clientMessageId, second.clientMessageId]);
    expect(calls).toHaveLength(2);
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    locks.close();
    await storage.close();
  });

  it('does not send the same row from two concurrent workers', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const sharedLocks = createFakeWebLocks();
    const first = createE2eeLockManager({ locks: sharedLocks });
    const second = createE2eeLockManager({ locks: sharedLocks });
    const calls: string[] = [];
    const send = async () => {
      calls.push('send');
      return { serverMessageId: IDS.serverMessage, seq: 1 };
    };
    const [a, b] = await Promise.all([
      drainOutbox(storage, kStorage, first, send),
      drainOutbox(storage, kStorage, second, send),
    ]);
    expect(calls).toHaveLength(1);
    expect(a.sent.length + b.sent.length).toBe(1);
    first.close();
    second.close();
    await storage.close();
  });

  it('replays with the same idempotency key after a crash-before-markSent', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const server = new Map<string, { serverMessageId: string; seq: number }>();
    const send = async (entry: OutboxEntry) => {
      const existing = server.get(entry.idempotencyKey);
      if (existing) return existing;
      const stored = { serverMessageId: IDS.serverMessage, seq: server.size };
      server.set(entry.idempotencyKey, stored);
      return stored;
    };
    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    // First "process" sends, then crashes before markOutboxSent.
    const pending = await restorePendingOutbox(storage, kStorage);
    await send(pending[0] as OutboxEntry);
    // Reload drains again: same key/bytes; the fake server dedupes.
    const result = await drainOutbox(storage, kStorage, locks, send);
    expect(result.sent).toEqual([draft.clientMessageId]);
    expect(server.size).toBe(1);
    locks.close();
    await storage.close();
  });

  it('marks an entry failed without leaking the error message', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    const result = await drainOutbox(storage, kStorage, locks, async () => {
      throw new Error('plaintext secret in error');
    });
    expect(result.failed).toEqual([{ clientMessageId: draft.clientMessageId, code: 'NETWORK' }]);
    const entry = await readOutboxEntry(storage, kStorage, draft.clientMessageId);
    expect(entry?.status).toBe('failed');
    expect(entry?.lastErrorCode).toBe('NETWORK');
    expect(dumpText(await dumpStorage(storage))).not.toContain('plaintext secret in error');
    locks.close();
    await storage.close();
  });
});

describe('incoming atomic commit', () => {
  it('consumes the OPK, persists state and the plaintext copy together', async () => {
    const { storage, kStorage, session } = await setup();
    const { putOneTimePrekey, getOneTimePrekey } = await import('./session/prekeyStore');
    const { generateX25519KeyPair } = await import('./crypto/x25519');
    const pair = await generateX25519KeyPair();
    await putOneTimePrekey(storage, {
      v: 1,
      keyId: 'opk-incoming',
      publicKey: b64(pair.publicKeyBytes),
      privateKey: pair.privateKey,
      createdAt: session.createdAt,
      expiresAt: session.createdAt + 30 * 86_400_000,
    });
    const next = await receiveAdvance(session);
    const prepared = await prepareIncomingMessage(kStorage, {
      sessionState: next,
      previousSessionState: session,
      sessionMode: { ifRevision: session.revision },
      localCopy: makeLocalCopyDraft({
        clientMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        direction: 'incoming',
        text: 'incoming text',
      }),
      oneTimePrekeyId: 'opk-incoming',
      now: session.createdAt + 1,
    });
    const updated = await commitIncomingMessage(storage, prepared);
    expect(updated?.revision).toBe(session.revision + 1);
    expect(await getOneTimePrekey(storage, 'opk-incoming')).toBeNull();
    const copy = await readLocalMessageCopy(storage, kStorage, {
      chatId: IDS.chat,
      direction: 'incoming',
      senderDeviceId: IDS.recipientDevice,
      clientMessageId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      localMessageId: prepared.localCopy.localMessageId,
    });
    expect(copy?.text).toBe('incoming text');
    expect(copy?.direction).toBe('incoming');
    await storage.close();
  });

  it('rolls back state and OPK when the incoming copy already exists', async () => {
    const { storage, kStorage, session } = await setup();
    const { putOneTimePrekey, getOneTimePrekey } = await import('./session/prekeyStore');
    const { generateX25519KeyPair } = await import('./crypto/x25519');
    const makeOpk = async (id: string) => {
      const pair = await generateX25519KeyPair();
      await putOneTimePrekey(storage, {
        v: 1,
        keyId: id,
        publicKey: b64(pair.publicKeyBytes),
        privateKey: pair.privateKey,
        createdAt: session.createdAt,
        expiresAt: session.createdAt + 30 * 86_400_000,
      });
    };
    await makeOpk('opk-1');
    await makeOpk('opk-2');
    const clientMessageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeea';
    const firstState = await receiveAdvance(session);
    const first = await prepareIncomingMessage(kStorage, {
      sessionState: firstState,
      previousSessionState: session,
      sessionMode: { ifRevision: session.revision },
      localCopy: makeLocalCopyDraft({ clientMessageId, direction: 'incoming', text: 'first' }),
      oneTimePrekeyId: 'opk-1',
      now: session.createdAt + 1,
    });
    const updated = await commitIncomingMessage(storage, first);
    const second = await prepareIncomingMessage(kStorage, {
      sessionState: await receiveAdvance(updated as SessionState),
      previousSessionState: updated as SessionState,
      sessionMode: { ifRevision: (updated as SessionState).revision },
      localCopy: makeLocalCopyDraft({ clientMessageId, direction: 'incoming', text: 'duplicate' }),
      oneTimePrekeyId: 'opk-2',
      now: session.createdAt + 1,
    });
    await expect(commitIncomingMessage(storage, second)).rejects.toMatchObject({
      code: 'DUPLICATE_OR_OLD_MESSAGE',
    });
    expect(await getOneTimePrekey(storage, 'opk-2')).not.toBeNull();
    expect(await loadSession(storage, kStorage, session.sessionId)).toMatchObject({
      nr: 1,
      revision: (updated as SessionState).revision,
    });
    await storage.close();
  });
});

describe('P1-01 sessionful commit (CR1)', () => {
  it('sessionless_commit_accepted=false: prepare rejects a missing session state', async () => {
    const { storage, kStorage, session } = await setup();
    const { sessionState: _omitted, ...sessionless } = await makeOutgoingDraft(session);
    await expect(
      prepareOutgoingMessage(kStorage, sessionless as OutgoingMessageDraft),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_MISSING' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...(await makeOutgoingDraft(session)),
        sessionState: null as unknown as SessionState,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_MISSING' });
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    expect(await listLocalCopyKeys(storage)).toEqual([]);
    await storage.close();
  });

  it('sessionless_commit_accepted=false: commit rejects a forged sessionless prepared object', async () => {
    const { storage, kStorage, session } = await setup();
    const prepared = await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session));
    const forged = { ...prepared, session: null } as unknown as PreparedOutgoingMessage;
    await expect(
      commitOutgoingMessage(storage, forged, { ifRevision: session.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_MISSING' });
    expect((await loadSession(storage, kStorage, session.sessionId))?.revision).toBe(
      session.revision,
    );
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    expect(await listLocalCopyKeys(storage)).toEqual([]);
    await storage.close();
  });

  it('rejects state wired to another session/chat before writing', async () => {
    const { storage, kStorage, session } = await setup();
    const other = await createTestSession({
      sessionId: testSessionId(9),
      chatId: '12121212-1212-4212-8212-121212121212',
      peerDeviceId: IDS.peerDevice2,
    });
    await expect(
      prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session, { sessionState: other })),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });

    const prepared = await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session));
    const forged = {
      ...prepared,
      outbox: { ...prepared.outbox, sessionId: other.sessionId },
    };
    await expect(
      commitOutgoingMessage(storage, forged, { ifRevision: session.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, session.sessionId))?.revision).toBe(
      session.revision,
    );
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });

  it('persists exactly one session revision per outbox row and replays fail closed', async () => {
    const { storage, kStorage, session } = await setup();
    const first = await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session)),
      { ifRevision: session.revision },
    );
    expect(first.revision).toBe(session.revision + 1);
    const second = await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(
        kStorage,
        await makeOutgoingDraft(first, {
          clientMessageId: 'abababab-abab-4bab-8bab-abababababab',
          localMessageId: 'acacacac-acac-4cac-8cac-acacacacacac',
          idempotencyKey: 'adadadad-adad-4dad-8dad-adadadadadad',
        }),
      ),
      { ifRevision: first.revision },
    );
    expect(second.revision).toBe(first.revision + 1);
    expect(await restorePendingOutbox(storage, kStorage)).toHaveLength(2);
    expect((await loadSession(storage, kStorage, session.sessionId))?.revision).toBe(
      second.revision,
    );

    // Replaying an already committed MK shift must not move the chain again.
    const replay = await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(second));
    await expect(
      commitOutgoingMessage(storage, replay, { ifRevision: second.revision }),
    ).rejects.toMatchObject({ code: 'OUTBOX_CONFLICT' });
    await expect(
      commitOutgoingMessage(storage, replay, { ifRevision: first.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect((await loadSession(storage, kStorage, session.sessionId))?.revision).toBe(
      second.revision,
    );
    await storage.close();
  });
});

describe('P1-02 local copy scope (CR1)', () => {
  it('incoming peer id cannot shadow or be returned as the outgoing copy', async () => {
    const { storage, kStorage, session } = await setup();
    const outgoing = await makeOutgoingDraft(session);
    const updated = await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(kStorage, outgoing),
      { ifRevision: session.revision },
    );
    const incoming = await prepareIncomingMessage(kStorage, {
      sessionState: await receiveAdvance(updated as SessionState),
      previousSessionState: updated as SessionState,
      sessionMode: { ifRevision: updated.revision },
      localCopy: makeLocalCopyDraft({
        clientMessageId: outgoing.clientMessageId,
        localMessageId: '12121212-1212-4212-8212-121212121212',
        direction: 'incoming',
        text: 'attacker text',
      }),
      now: updated.lastUsedAt + 1,
    });
    await commitIncomingMessage(storage, incoming);

    const lookup = await lookupLocalCopy(storage, kStorage, IDS.chat, outgoing.clientMessageId);
    expect(lookup.available).toBe(true);
    if (lookup.available) {
      expect(lookup.copy.direction).toBe('outgoing');
      expect(lookup.copy.text).toBe('hello E2EE');
    }
    const peerCopy = await readLocalMessageCopy(storage, kStorage, {
      chatId: IDS.chat,
      direction: 'incoming',
      senderDeviceId: IDS.recipientDevice,
      clientMessageId: outgoing.clientMessageId,
      localMessageId: incoming.localCopy.localMessageId,
    });
    expect(peerCopy?.direction).toBe('incoming');
    expect(peerCopy?.text).toBe('attacker text');
    expect(await listLocalCopyKeys(storage)).toHaveLength(2);
    await storage.close();
  });

  it('keeps the same peer-controlled id independent across chats', async () => {
    const { storage, kStorage, session } = await setup();
    const outgoing = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, outgoing), {
      ifRevision: session.revision,
    });
    const otherChat = '12121212-1212-4212-8212-121212121212';
    const other = await prepareIncomingMessage(kStorage, {
      localCopy: makeLocalCopyDraft({
        chatId: otherChat,
        clientMessageId: outgoing.clientMessageId,
        localMessageId: '13131313-1313-4313-8313-131313131313',
        direction: 'incoming',
        text: 'other chat',
      }),
    });
    await commitIncomingMessage(storage, other);
    const lookup = await lookupLocalCopy(storage, kStorage, IDS.chat, outgoing.clientMessageId);
    expect(lookup.available && lookup.copy.text).toBe('hello E2EE');
    const crossChat = await readLocalMessageCopy(storage, kStorage, {
      chatId: otherChat,
      direction: 'incoming',
      senderDeviceId: IDS.recipientDevice,
      clientMessageId: outgoing.clientMessageId,
      localMessageId: other.localCopy.localMessageId,
    });
    expect(crossChat?.chatId).toBe(otherChat);
    expect(crossChat?.text).toBe('other chat');
    await storage.close();
  });

  it('binds chat/direction/sender into the key and rejects a tampered scope', async () => {
    const { storage, kStorage } = await setup();
    const incoming = await prepareIncomingMessage(kStorage, {
      localCopy: makeLocalCopyDraft({
        clientMessageId: null,
        localMessageId: '14141414-1414-4414-8414-141414141414',
        direction: 'incoming',
        text: 'incoming null id',
      }),
    });
    await commitIncomingMessage(storage, incoming);
    expect(incoming.localCopy.key).toContain(`:incoming:${IDS.recipientDevice}:`);
    expect(incoming.localCopy.key).toContain(`:${IDS.chat}:`);
    expect(incoming.localCopy.key).toContain(':l:14141414-1414-4414-8414-141414141414');

    const stored = (await storage.get<StoredLocalMessageCopy>(
      'localMessages',
      incoming.localCopy.key,
    )) as StoredLocalMessageCopy;
    expect(stored.direction).toBe('incoming');
    await storage.put('localMessages', incoming.localCopy.key, {
      ...stored,
      direction: 'outgoing',
    });
    await expect(
      readLocalMessageCopy(storage, kStorage, {
        chatId: IDS.chat,
        direction: 'incoming',
        senderDeviceId: IDS.recipientDevice,
        clientMessageId: null,
        localMessageId: incoming.localCopy.localMessageId,
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    // A forged outgoing/local-copy direction cannot be committed as incoming.
    await expect(
      commitIncomingMessage(storage, {
        ...incoming,
        localCopy: { ...incoming.localCopy, direction: 'outgoing' },
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });

    // The outgoing namespace is untouched by an incoming-only copy.
    expect(
      (await lookupLocalCopy(storage, kStorage, IDS.chat, '15151515-1515-4515-8515-151515151515'))
        .available,
    ).toBe(false);
    await storage.close();
  });
});

describe('P1-06 outbox fence and P1-07 transplant (CR1)', () => {
  it('does not mark sent when the fallback lease expired during send', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const bus = createInMemoryChannelBus();
    const scheduler = createManualScheduler();
    const locks = createE2eeLockManager({
      locks: null,
      channelFactory: bus.factory,
      tabId: 'tab-a',
      settleMs: 1,
      leaseMs: 5000,
      scheduler,
    });
    await expect(
      drainOutbox(storage, kStorage, locks, async () => {
        // Simulate a throttled background tab: the lease expires mid-send.
        scheduler.advance(6000);
        return { serverMessageId: IDS.serverMessage, seq: 1 };
      }),
    ).rejects.toMatchObject({ code: 'LOCK_LEASE_EXPIRED' });
    const entry = await readOutboxEntry(storage, kStorage, draft.clientMessageId);
    expect(entry?.status).toBe('pending');
    expect(await restorePendingOutbox(storage, kStorage)).toHaveLength(1);
    locks.close();
    bus.closeAll();
    await storage.close();
  });

  it('rejects a K_storage ciphertext transplanted between local copy records', async () => {
    const { storage, kStorage } = await setup();
    const base = {
      chatId: IDS.chat,
      sessionId: testSessionId(1),
      direction: 'incoming' as const,
      clientMessageId: null,
      senderDeviceId: IDS.recipientDevice,
      text: 'one',
    };
    const first = await prepareIncomingMessage(kStorage, {
      localCopy: makeLocalCopyDraft({
        ...base,
        localMessageId: '16161616-1616-4616-8616-161616161616',
      }),
    });
    const second = await prepareIncomingMessage(kStorage, {
      localCopy: makeLocalCopyDraft({
        ...base,
        localMessageId: '17171717-1717-4717-8717-171717171717',
        text: 'two',
      }),
    });
    await commitIncomingMessage(storage, first);
    await commitIncomingMessage(storage, second);
    const storedFirst = (await storage.get<StoredLocalMessageCopy>(
      'localMessages',
      first.localCopy.key,
    )) as StoredLocalMessageCopy;
    const storedSecond = (await storage.get<StoredLocalMessageCopy>(
      'localMessages',
      second.localCopy.key,
    )) as StoredLocalMessageCopy;
    expect(storedFirst.content.ciphertext).not.toBe(storedSecond.content.ciphertext);
    await storage.put('localMessages', first.localCopy.key, {
      ...storedFirst,
      content: storedSecond.content,
    });
    await expect(
      readLocalMessageCopy(storage, kStorage, {
        chatId: IDS.chat,
        direction: 'incoming',
        senderDeviceId: IDS.recipientDevice,
        clientMessageId: null,
        localMessageId: first.localCopy.localMessageId,
      }),
    ).rejects.toMatchObject({ code: 'KEY_STORAGE_UNAVAILABLE' });
    await storage.close();
  });
});

describe('CR1b P1-01R/P2-02 — envelope scope and prepared-state binding', () => {
  it('stale_prepared_commit_accepted=false', async () => {
    const { storage, kStorage, session } = await setup();
    const prepared = await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session));
    await expect(
      commitOutgoingMessage(storage, prepared, { ifRevision: session.revision + 1 }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });

  it('second_unadvanced_commit_accepted=false', async () => {
    const { storage, kStorage, session } = await setup();
    const first = await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session));
    const second = await prepareOutgoingMessage(
      kStorage,
      await makeOutgoingDraft(session, {
        clientMessageId: 'abababab-abab-4bab-8bab-abababababab',
        localMessageId: 'acacacac-acac-4cac-8cac-acacacacacac',
        idempotencyKey: 'adadadad-adad-4dad-8dad-adadadadadad',
      }),
    );
    await commitOutgoingMessage(storage, first, { ifRevision: session.revision });
    // Both drafts were prepared from the same unadvanced state: the second one
    // would persist a chain step that was already consumed.
    await expect(
      commitOutgoingMessage(storage, second, { ifRevision: session.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect(await restorePendingOutbox(storage, kStorage)).toHaveLength(1);
    await storage.close();
  });

  it('rejects a forged prepared session record inside the commit', async () => {
    const { storage, kStorage, session } = await setup();
    const prepared = await prepareOutgoingMessage(kStorage, await makeOutgoingDraft(session));
    const forged = {
      ...prepared,
      session: {
        ...prepared.session,
        record: { ...prepared.session.record, revision: session.revision + 7 },
      },
    };
    await expect(
      commitOutgoingMessage(storage, forged, { ifRevision: session.revision }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });

  it('rejects mixed chat/sender, duplicate recipient/session and foreign sessions', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const envelope = draft.envelopes[0]!;
    const otherChat = '12121212-1212-4212-8212-121212121212';

    await expect(
      prepareOutgoingMessage(kStorage, {
        ...draft,
        envelopes: [{ ...envelope, chat_id: otherChat }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_FORMAT' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...draft,
        envelopes: [{ ...envelope, sender_device_id: IDS.peerDevice2 }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_FORMAT' });
    await expect(
      prepareOutgoingMessage(kStorage, { ...draft, envelopes: [envelope, envelope] }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_FORMAT' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...draft,
        envelopes: [
          envelope,
          {
            ...envelope,
            recipient_device_id: IDS.peerDevice2,
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_FORMAT' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...draft,
        envelopes: [{ ...envelope, session_id: testSessionId(9) }],
      }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...draft,
        envelopes: [{ ...envelope, header: { ...envelope.header, n: 7 } }],
      }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    await expect(
      prepareOutgoingMessage(kStorage, {
        ...draft,
        envelopes: [{ ...envelope, header: { ...envelope.header, dh: b64(bytes(32, 55)) } }],
      }),
    ).rejects.toMatchObject({ code: 'SESSION_STATE_STALE' });
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });

  it('never resurrects a superseded outbox row (CR1c)', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    const prepared = await prepareOutgoingMessage(kStorage, draft);
    await commitOutgoingMessage(storage, prepared, { ifRevision: session.revision });
    await markOutboxSuperseded(storage, draft.clientMessageId);
    await markOutboxFailed(storage, draft.clientMessageId, 'NETWORK');
    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.status).toBe(
      'superseded',
    );
    await retryOutboxEntry(storage, draft.clientMessageId);
    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.status).toBe(
      'superseded',
    );
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    await storage.close();
  });
});

/**
 * G4e #30 — durable retry/drain regression.
 *
 * The replacement row is the exact bytes of an R-15 retry; its original must
 * never be sent/re-encrypted again. These tests cover the ambiguous-POST path,
 * a lost `markOutboxSuperseded`, reload drain, backoff and deduplication.
 */
describe('G4e #30 durable retry/drain', () => {
  const FIRST = {
    clientMessageId: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
    localMessageId: 'a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2',
    idempotencyKey: 'a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3',
  } as const;
  const REPLACEMENT = {
    clientMessageId: 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1',
    localMessageId: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
    idempotencyKey: 'b3b3b3b3-b3b3-4b3b-8b3b-b3b3b3b3b3b3',
  } as const;

  async function commitReplacement(): Promise<{
    storage: ReturnType<typeof createMemoryE2eeStorage>;
    kStorage: Awaited<ReturnType<typeof loadOrCreateKStorage>>;
    session: SessionState;
    last: SessionState;
    first: OutgoingMessageDraft;
    replacement: OutgoingMessageDraft;
  }> {
    const { storage, kStorage, session } = await setup();
    const first = await makeOutgoingDraft(session, { ...FIRST, text: 'original' });
    const afterFirst = (await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(kStorage, first),
      { ifRevision: session.revision },
    )) as SessionState;
    const replacement = await makeOutgoingDraft(afterFirst, {
      ...REPLACEMENT,
      retryOfClientMessageId: first.clientMessageId,
      text: 'original',
    });
    const last = (await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(kStorage, replacement),
      { ifRevision: afterFirst.revision },
    )) as SessionState;
    return { storage, kStorage, session: afterFirst, last, first, replacement };
  }

  it('confirms a replacement by atomically superseding its original (markSuperseded failure)', async () => {
    const { storage, kStorage, first, replacement } = await commitReplacement();
    // No explicit markOutboxSuperseded: delete/IDB failure in that follow-up
    // must not leave a live original behind.
    await markOutboxSent(
      storage,
      replacement.clientMessageId,
      { serverMessageId: IDS.serverMessage, seq: 9 },
      { now: 500 },
    );

    const original = await readOutboxEntry(storage, kStorage, first.clientMessageId);
    expect(original).toMatchObject({ status: 'superseded', supersededAt: 500 });
    const originalCopy = await lookupLocalCopy(storage, kStorage, IDS.chat, first.clientMessageId);
    expect(originalCopy.available && originalCopy.copy.status).toBe('superseded');
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);

    // A failed/old client can never resurrect the replaced original.
    await retryOutboxEntry(storage, first.clientMessageId);
    expect((await readOutboxEntry(storage, kStorage, first.clientMessageId))?.status).toBe(
      'superseded',
    );
    await storage.close();
  });

  it('keeps supersede idempotent by timestamp for pending and sent originals', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    await markOutboxSuperseded(storage, draft.clientMessageId, { now: 10 });
    await markOutboxSuperseded(storage, draft.clientMessageId, { now: 20 });
    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.supersededAt).toBe(
      10,
    );

    const { storage: sentStorage, kStorage: sentK, session: sentSession } = await setup();
    const sentDraft = await makeOutgoingDraft(sentSession);
    await commitOutgoingMessage(sentStorage, await prepareOutgoingMessage(sentK, sentDraft), {
      ifRevision: sentSession.revision,
    });
    await markOutboxSent(sentStorage, sentDraft.clientMessageId, {
      serverMessageId: IDS.serverMessage,
      seq: 1,
    });
    await markOutboxSuperseded(sentStorage, sentDraft.clientMessageId, { now: 10 });
    await markOutboxSuperseded(sentStorage, sentDraft.clientMessageId, { now: 20 });
    const sent = await readOutboxEntry(sentStorage, sentK, sentDraft.clientMessageId);
    expect(sent).toMatchObject({ status: 'sent', supersededAt: 10 });
    await storage.close();
    await sentStorage.close();
  });

  it('heals a lost confirmSent → markSuperseded transition on reconcile', async () => {
    const { storage, kStorage, first, replacement } = await commitReplacement();
    const key = outboxStorageKey(first.clientMessageId);
    const pendingOriginal = (await storage.get('outbox', key)) as StoredOutboxEntry;
    await markOutboxSent(storage, replacement.clientMessageId, {
      serverMessageId: IDS.serverMessage,
      seq: 3,
    });
    // Simulate the old non-atomic order: replacement is sent, original row was
    // left untouched (its copy is still pending).
    await storage.put('outbox', key, pendingOriginal);

    const reconciled = await reconcileOutbox(storage, kStorage, { now: 1_000 });
    expect(reconciled.superseded).toContain(first.clientMessageId);
    expect(await readOutboxEntry(storage, kStorage, first.clientMessageId)).toMatchObject({
      status: 'superseded',
      supersededAt: 1_000,
    });
    // Reconcile is idempotent and never resurrects anything.
    await reconcileOutbox(storage, kStorage, { now: 2_000 });
    expect(await readOutboxEntry(storage, kStorage, first.clientMessageId)).toMatchObject({
      status: 'superseded',
      supersededAt: 1_000,
    });
    await storage.close();
  });

  it('drains a pending replacement after reload with its exact idempotency key', async () => {
    const { storage, kStorage, session, first, replacement } = await commitReplacement();
    // A fresh lock manager/storage read models a page reload: no in-memory state.
    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    const calls: Array<{ clientMessageId: string; key: string }> = [];
    const result = await drainOutbox(storage, kStorage, locks, async (entry) => {
      calls.push({ clientMessageId: entry.clientMessageId, key: entry.idempotencyKey });
      return { serverMessageId: IDS.serverMessage, seq: 11 };
    });
    expect(result.sent).toEqual([replacement.clientMessageId]);
    expect(calls).toEqual([
      { clientMessageId: replacement.clientMessageId, key: replacement.idempotencyKey },
    ]);
    expect((await readOutboxEntry(storage, kStorage, first.clientMessageId))?.status).toBe(
      'superseded',
    );
    expect(await restorePendingOutbox(storage, kStorage)).toEqual([]);
    const reconciled = await reconcileOutbox(storage, kStorage, { now: 12 });
    expect(reconciled.completedFailedSessionIds).toContain(session.sessionId);
    locks.close();
    await storage.close();
  });

  it('resolves an ambiguous POST through server lookup without a second POST', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    const server = new Map<string, { serverMessageId: string; seq: number }>();
    let posts = 0;
    const send = async (entry: OutboxEntry) => {
      posts += 1;
      // The server accepted the message, but the response never arrived.
      server.set(entry.idempotencyKey, { serverMessageId: IDS.serverMessage, seq: 4 });
      throw new Error('connection reset after upload');
    };
    const first = await drainOutbox(storage, kStorage, locks, send, { now: 1_000 });
    expect(first.sent).toEqual([]);
    expect(first.failed).toHaveLength(1);
    expect(posts).toBe(1);
    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.status).toBe(
      'failed',
    );

    // Next due pass: the server row is found by client_message_id; no duplicate.
    const second = await drainOutbox(
      storage,
      kStorage,
      locks,
      async () => {
        posts += 1;
        return { serverMessageId: IDS.serverMessage, seq: 4 };
      },
      {
        now: 1_000 + outboxBackoffMs(1),
        lookup: async (entry) => {
          const found = server.get(entry.idempotencyKey);
          return found === undefined ? null : found;
        },
      },
    );
    expect(second.sent).toEqual([draft.clientMessageId]);
    expect(posts).toBe(1);
    expect(server.size).toBe(1);
    expect((await readOutboxEntry(storage, kStorage, draft.clientMessageId))?.status).toBe('sent');
    locks.close();
    await storage.close();
  });

  it('persists exponential backoff across passes and skips a not-due row', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    let posts = 0;
    const result = await drainOutbox(
      storage,
      kStorage,
      locks,
      async () => {
        posts += 1;
        throw new Error('offline');
      },
      { now: 1_000 },
    );
    expect(result.failed).toHaveLength(1);
    expect(result.nextAttemptAt).toBe(1_000 + outboxBackoffMs(1));
    const status = await outboxRetryStatus(storage, kStorage, { now: 1_001 });
    expect(status[0]).toMatchObject({ chatId: IDS.chat, pending: 1 });

    const early = await drainOutbox(
      storage,
      kStorage,
      locks,
      async () => {
        posts += 1;
        return { serverMessageId: IDS.serverMessage, seq: 1 };
      },
      { now: 1_500 },
    );
    expect(early.sent).toEqual([]);
    expect(posts).toBe(1);

    const due = await drainOutbox(
      storage,
      kStorage,
      locks,
      async () => {
        posts += 1;
        return { serverMessageId: IDS.serverMessage, seq: 1 };
      },
      { now: 1_000 + outboxBackoffMs(1) },
    );
    expect(due.sent).toEqual([draft.clientMessageId]);
    expect(posts).toBe(2);
    locks.close();
    await storage.close();
  });

  it('does not auto-retry a permanent failure but keeps it for an explicit retry', async () => {
    const { storage, kStorage, session } = await setup();
    const draft = await makeOutgoingDraft(session);
    await commitOutgoingMessage(storage, await prepareOutgoingMessage(kStorage, draft), {
      ifRevision: session.revision,
    });
    await markOutboxAttempt(storage, draft.clientMessageId, { now: 1_000 });
    await markOutboxFailed(storage, draft.clientMessageId, 'E2EE_DISABLED', {
      now: 1_000,
      retryable: false,
    });
    expect(await listDrainCandidates(storage, kStorage, { now: 1_000_000 })).toEqual([]);
    expect((await outboxRetryStatus(storage, kStorage))[0]).toMatchObject({
      pending: 0,
      permanent: 1,
    });
    await retryOutboxEntry(storage, draft.clientMessageId);
    expect(
      (await listDrainCandidates(storage, kStorage, { now: 1_000_000 })).map(
        (entry) => entry.clientMessageId,
      ),
    ).toEqual([draft.clientMessageId]);
    await storage.close();
  });

  it('drains only the newest partial-batch replacement, never a sent one', async () => {
    const { storage, kStorage, last, replacement } = await commitReplacement();
    // First replacement is already confirmed; its original is superseded. A
    // second original + pending replacement models a partial batch.
    await markOutboxSent(storage, replacement.clientMessageId, {
      serverMessageId: IDS.serverMessage,
      seq: 1,
    });
    const secondOriginal = await makeOutgoingDraft(last, {
      clientMessageId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1',
      localMessageId: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2',
      idempotencyKey: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
      text: 'second',
    });
    const afterSecond = (await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(kStorage, secondOriginal),
      { ifRevision: last.revision },
    )) as SessionState;
    const secondReplacement = await makeOutgoingDraft(afterSecond, {
      clientMessageId: 'd1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1',
      localMessageId: 'd2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2',
      idempotencyKey: 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3',
      retryOfClientMessageId: secondOriginal.clientMessageId,
      text: 'second',
    });
    await commitOutgoingMessage(
      storage,
      await prepareOutgoingMessage(kStorage, secondReplacement),
      { ifRevision: afterSecond.revision },
    );

    const locks = createE2eeLockManager({ locks: createFakeWebLocks() });
    const calls: string[] = [];
    const result = await drainOutbox(storage, kStorage, locks, async (entry) => {
      calls.push(entry.clientMessageId);
      return { serverMessageId: IDS.serverMessage, seq: 2 };
    });
    expect(result.sent).toEqual([secondReplacement.clientMessageId]);
    expect(calls).toEqual([secondReplacement.clientMessageId]);
    expect((await readOutboxEntry(storage, kStorage, secondOriginal.clientMessageId))?.status).toBe(
      'superseded',
    );
    locks.close();
    await storage.close();
  });

  it('persists and clears the R-15 retry intent (metadata only)', async () => {
    const { storage } = await setup();
    const reset = {
      failedSessionId: testSessionId(1),
      failedChainDh: b64(bytes(32, 9)),
      failedN: 2,
      reason: 'DECRYPT_FAILED' as const,
      retryOfClientMessageId: FIRST.clientMessageId,
    };
    await putRetryState(
      storage,
      { chatId: IDS.chat, senderDeviceId: IDS.recipientDevice, reset },
      { now: 100 },
    );
    const states = await listRetryStates(storage, IDS.chat);
    expect(states).toHaveLength(1);
    expect(states[0]?.reset).toEqual(reset);
    expect(await getRetryState(storage, IDS.chat, reset.failedSessionId)).not.toBeNull();
    expect(dumpText(await dumpStorage(storage))).not.toContain('hello E2EE');
    await deleteRetryState(storage, IDS.chat, reset.failedSessionId);
    expect(await listRetryStates(storage)).toEqual([]);
    await storage.close();
  });
});

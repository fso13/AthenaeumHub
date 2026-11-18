/**
 * E7-F6 §5.7 simultaneous-initiation winner/loser state machine.
 *
 * These tests drive the real send/receive/ratchet path (no bridge/UI doubles):
 * crossed prekey initiation, deterministic winner on both sides, an in-flight
 * envelope on the losing chain, reload recovery and winner key retention.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { SUPERSEDED_DELIVERY_WINDOW_MS } from './constants';
import {
  SESSION_IDS,
  claimBundleFromWorld,
  createTestWorld,
  recipientPlan,
  reloadWorld,
  verifiedIdentityOf,
  type TestWorld,
} from './test/sessionFixtures';
import { selectSendingSession, sendE2eeMessage } from './session/send';
import { receiveE2eeMessage } from './session/receive';
import { listSessionsByPeer } from './session/sessionStore';
import { reconcileParallelSessions, recoverParallelSessions } from './session/parallel';
import { listOutboxEntries, markOutboxSent } from './outbox/outboxStore';
import { DEFAULT_NOW } from './test/sessionFixtures';
import type { SessionState } from './session/types';

const CHAT = SESSION_IDS.chat;

function contextOf(world: TestWorld) {
  return {
    storage: world.storage,
    kStorage: world.kStorage,
    identity: world.identity,
    now: world.now,
  };
}

async function sendText(
  from: TestWorld,
  to: TestWorld,
  text: string,
  options: { readonly now?: number } = {},
) {
  return sendE2eeMessage(
    { ...contextOf(from), now: options.now ?? from.now },
    {
      chatId: CHAT,
      body: { type: 'TEXT_JSON', text, replyToId: null },
      recipients: [recipientPlan(await claimBundleFromWorld(to))],
      expectedPeerDeviceIds: [to.deviceId],
      createdAt: options.now ?? from.now,
    },
  );
}

async function receiveFrom(
  to: TestWorld,
  from: TestWorld,
  envelope: Awaited<ReturnType<typeof sendText>>['envelopes'][number],
  options: { readonly now?: number } = {},
) {
  return receiveE2eeMessage(
    { ...contextOf(to), now: options.now ?? to.now },
    {
      chatId: CHAT,
      envelope,
      sender: await verifiedIdentityOf(from),
      isSelfDevice: from.userId === to.userId,
      createdAt: options.now ?? to.now,
    },
  );
}

async function pair(): Promise<{ a: TestWorld; b: TestWorld }> {
  const a = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
  const b = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
  return { a, b };
}

interface CrossedWorlds {
  readonly a: TestWorld;
  readonly b: TestWorld;
  readonly aFirst: Awaited<ReturnType<typeof sendText>>;
  readonly bFirst: Awaited<ReturnType<typeof sendText>>;
  readonly winnerId: string;
  readonly loserId: string;
  readonly confirmedWorld: TestWorld;
  readonly unconfirmedWorld: TestWorld;
}

/**
 * Crosses two first envelopes. Each side keeps its own session and accepts the
 * peer's prekey, so both end with a `{local, peer}` pair and the same winner.
 * Nothing is deleted here: deletion needs the confirmation window.
 */
async function crossFirstMessages(): Promise<CrossedWorlds> {
  const { a, b } = await pair();
  const aFirst = await sendText(a, b, 'a first');
  const bFirst = await sendText(b, a, 'b first');
  expect(aFirst.sessionId).not.toBe(bFirst.sessionId);

  const winnerId = aFirst.sessionId < bFirst.sessionId ? aFirst.sessionId : bFirst.sessionId;
  const loserId = winnerId === aFirst.sessionId ? bFirst.sessionId : aFirst.sessionId;
  const confirmedWorld = winnerId === bFirst.sessionId ? a : b;
  const unconfirmedWorld = confirmedWorld === a ? b : a;

  const atA = await receiveFrom(a, b, bFirst.envelopes[0]!);
  expect(atA.text).toBe('b first');
  const atB = await receiveFrom(b, a, aFirst.envelopes[0]!);
  expect(atB.text).toBe('a first');

  return { a, b, aFirst, bFirst, winnerId, loserId, confirmedWorld, unconfirmedWorld };
}

function sessionIds(sessions: readonly SessionState[]): string[] {
  return sessions.map((session) => session.sessionId).sort();
}

/**
 * Test helper: these tests have no server, so pending outbox rows would
 * (correctly) defer loser deletion. Mark every stored send as accepted first,
 * exactly as the real network confirmation does before reconciliation.
 */
async function confirmAllOutbox(world: TestWorld): Promise<void> {
  const entries = await listOutboxEntries(world.storage, world.kStorage, { status: 'pending' });
  let seq = 1;
  for (const entry of entries) {
    await markOutboxSent(world.storage, entry.clientMessageId, {
      serverMessageId: entry.localMessageId,
      seq: seq++,
    });
  }
}

describe('E7-F6 §5.7 simultaneous initiation', () => {
  it('both sides converge on the same deterministic winner and send on it', async () => {
    const { a, b, winnerId, loserId, confirmedWorld, unconfirmedWorld } =
      await crossFirstMessages();

    for (const world of [a, b]) {
      const sessions = await listSessionsByPeer(
        world.storage,
        world.kStorage,
        CHAT,
        a === world ? b.deviceId : a.deviceId,
      );
      expect(sessionIds(sessions)).toEqual([winnerId, loserId].sort());
      const winner = sessions.find((session) => session.sessionId === winnerId)!;
      const loser = sessions.find((session) => session.sessionId === loserId)!;
      expect(loser.supersededBy).toBe(winnerId);
      expect(loser.supersededAt).toBe(DEFAULT_NOW);
      expect(winner.supersededBy ?? null).toBeNull();
    }

    const confirmedSessions = await listSessionsByPeer(
      confirmedWorld.storage,
      confirmedWorld.kStorage,
      CHAT,
      confirmedWorld === a ? b.deviceId : a.deviceId,
    );
    expect(
      confirmedSessions.find((session) => session.sessionId === winnerId)?.winnerConfirmedAt,
    ).toBe(DEFAULT_NOW);
    const unconfirmedSessions = await listSessionsByPeer(
      unconfirmedWorld.storage,
      unconfirmedWorld.kStorage,
      CHAT,
      unconfirmedWorld === a ? b.deviceId : a.deviceId,
    );
    expect(
      unconfirmedSessions.find((session) => session.sessionId === winnerId)?.winnerConfirmedAt ??
        null,
    ).toBeNull();

    // Regardless of the last receive, the deterministic winner is the send
    // target on both sides once both sessions are known.
    const fromConfirmed = await sendText(
      confirmedWorld,
      confirmedWorld === a ? b : a,
      'winner send',
    );
    expect(fromConfirmed.sessionId).toBe(winnerId);
    const fromUnconfirmed = await sendText(
      unconfirmedWorld,
      unconfirmedWorld === a ? b : a,
      'winner send 2',
    );
    expect(fromUnconfirmed.sessionId).toBe(winnerId);
  });

  it('keeps an in-flight losing-chain envelope decryptable until the delivery window ends', async () => {
    const { a, b } = await pair();
    const aFirst = await sendText(a, b, 'a first');
    const bFirst = await sendText(b, a, 'b first');
    const winnerId = aFirst.sessionId < bFirst.sessionId ? aFirst.sessionId : bFirst.sessionId;
    const loserId = winnerId === aFirst.sessionId ? bFirst.sessionId : aFirst.sessionId;
    const loserWorld = loserId === aFirst.sessionId ? a : b;
    const loserPeer = loserWorld === a ? b : a;

    // Sent before the loser learns about the peer's session, so it is encrypted
    // on the losing chain and is still "in flight" when the winner receives.
    const inFlight = await sendText(loserWorld, loserPeer, 'in flight on loser');
    expect(inFlight.sessionId).toBe(loserId);

    await receiveFrom(a, b, bFirst.envelopes[0]!);
    await receiveFrom(b, a, aFirst.envelopes[0]!);

    // The losing session still holds its keys inside the delivery window.
    const delivered = await receiveFrom(loserPeer, loserWorld, inFlight.envelopes[0]!, {
      now: DEFAULT_NOW + 1,
    });
    expect(delivered.text).toBe('in flight on loser');
    expect(delivered.sessionId).toBe(loserId);

    const confirmed = winnerId === bFirst.sessionId ? a : b;
    const unconfirmed = confirmed === a ? b : a;
    const peerOf = (world: TestWorld) => (world.deviceId === a.deviceId ? b : a);

    await confirmAllOutbox(confirmed);
    await confirmAllOutbox(unconfirmed);

    // The confirmed side deletes the loser only after the delivery window.
    const firstReconcile = await reconcileParallelSessions(confirmed.storage, confirmed.kStorage, {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 1,
      chatId: CHAT,
      peerDeviceId: peerOf(confirmed).deviceId,
    });
    expect(firstReconcile.deleted).toContain(loserId);
    expect(
      (
        await listSessionsByPeer(
          confirmed.storage,
          confirmed.kStorage,
          CHAT,
          peerOf(confirmed).deviceId,
        )
      ).map((session) => session.sessionId),
    ).toEqual([winnerId]);

    // The other side has not confirmed the winner yet, so its copy is retained
    // until the first winner receive; that receive then unlocks the deletion.
    const next = await sendText(confirmed, unconfirmed, 'confirm winner', {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 2,
    });
    expect(next.sessionId).toBe(winnerId);
    await receiveFrom(unconfirmed, confirmed, next.envelopes[0]!, {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 3,
    });
    const secondReconcile = await reconcileParallelSessions(
      unconfirmed.storage,
      unconfirmed.kStorage,
      {
        now: DEFAULT_NOW + 2 * SUPERSEDED_DELIVERY_WINDOW_MS + 4,
        chatId: CHAT,
        peerDeviceId: peerOf(unconfirmed).deviceId,
      },
    );
    expect(secondReconcile.deleted).toContain(loserId);

    // Winner keys survive on both sides: a normal message still decrypts.
    const after = await sendText(unconfirmed, confirmed, 'after deletion', {
      now: DEFAULT_NOW + 2 * SUPERSEDED_DELIVERY_WINDOW_MS + 10,
    });
    expect(after.sessionId).toBe(winnerId);
    const received = await receiveFrom(confirmed, unconfirmed, after.envelopes[0]!, {
      now: DEFAULT_NOW + 2 * SUPERSEDED_DELIVERY_WINDOW_MS + 11,
    });
    expect(received.text).toBe('after deletion');
  });

  it('recovers the persisted winner/superseded state after a reload idempotently', async () => {
    const { a, b, winnerId, loserId, confirmedWorld, unconfirmedWorld } =
      await crossFirstMessages();
    const peerOf = (world: TestWorld) => (world.deviceId === a.deviceId ? b : a);

    // Reload one side before the window ends: metadata and keys survive.
    const reloaded = await reloadWorld(confirmedWorld);
    await confirmAllOutbox(reloaded);
    const before = await listSessionsByPeer(
      reloaded.storage,
      reloaded.kStorage,
      CHAT,
      peerOf(reloaded).deviceId,
    );
    expect(before.find((session) => session.sessionId === loserId)?.supersededBy).toBe(winnerId);

    const early = await recoverParallelSessions(reloaded.storage, reloaded.kStorage, {
      now: DEFAULT_NOW + 1,
    });
    expect(early.deleted).toHaveLength(0);

    const afterWindow = await recoverParallelSessions(reloaded.storage, reloaded.kStorage, {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 10,
    });
    expect(afterWindow.deleted).toContain(loserId);
    const after = await listSessionsByPeer(
      reloaded.storage,
      reloaded.kStorage,
      CHAT,
      peerOf(reloaded).deviceId,
    );
    expect(after.map((session) => session.sessionId)).toEqual([winnerId]);

    // Idempotent: a second run has nothing left to delete.
    const twice = await recoverParallelSessions(reloaded.storage, reloaded.kStorage, {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 20,
    });
    expect(twice.deleted).toHaveLength(0);
    expect(twice.superseded).toHaveLength(0);

    // The winner keeps keys and remains usable after the loser is gone.
    const fromReloaded = await sendText(reloaded, peerOf(reloaded), 'after reload', {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 30,
    });
    expect(fromReloaded.sessionId).toBe(winnerId);
    const received = await receiveFrom(peerOf(reloaded), reloaded, fromReloaded.envelopes[0]!, {
      now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 31,
    });
    expect(received.text).toBe('after reload');

    // The other side still has both sessions until it confirms the winner; the
    // recovery must not delete anything there prematurely.
    const otherSessions = await listSessionsByPeer(
      unconfirmedWorld.storage,
      unconfirmedWorld.kStorage,
      CHAT,
      peerOf(unconfirmedWorld).deviceId,
    );
    expect(otherSessions.map((session) => session.sessionId).sort()).toEqual(
      [winnerId, loserId].sort(),
    );
  });

  it('defers loser deletion while a pending outbox envelope still uses it', async () => {
    const { a, b, winnerId, loserId, confirmedWorld } = await crossFirstMessages();
    const peerOf = (world: TestWorld) => (world.deviceId === a.deviceId ? b : a);

    // No outbox confirmation yet: the loser still has an in-flight send.
    const deferred = await reconcileParallelSessions(
      confirmedWorld.storage,
      confirmedWorld.kStorage,
      {
        now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 1,
        chatId: CHAT,
        peerDeviceId: peerOf(confirmedWorld).deviceId,
      },
    );
    expect(deferred.deleted).not.toContain(loserId);
    expect(
      (
        await listSessionsByPeer(
          confirmedWorld.storage,
          confirmedWorld.kStorage,
          CHAT,
          peerOf(confirmedWorld).deviceId,
        )
      )
        .map((session) => session.sessionId)
        .sort(),
    ).toEqual([winnerId, loserId].sort());

    await confirmAllOutbox(confirmedWorld);
    const afterConfirm = await reconcileParallelSessions(
      confirmedWorld.storage,
      confirmedWorld.kStorage,
      {
        now: DEFAULT_NOW + SUPERSEDED_DELIVERY_WINDOW_MS + 2,
        chatId: CHAT,
        peerDeviceId: peerOf(confirmedWorld).deviceId,
      },
    );
    expect(afterConfirm.deleted).toContain(loserId);
  });

  it('selectSendingSession prefers the deterministic pair winner over last received', async () => {
    const { a, b, aFirst, bFirst, winnerId } = await crossFirstMessages();
    const sessions = await listSessionsByPeer(a.storage, a.kStorage, CHAT, b.deviceId);
    const loserId = winnerId === aFirst.sessionId ? bFirst.sessionId : aFirst.sessionId;
    const withLoserReceived = sessions.map((session) =>
      session.sessionId === loserId ? { ...session, lastReceivedAt: DEFAULT_NOW + 100 } : session,
    );
    expect(selectSendingSession(withLoserReceived)?.sessionId).toBe(winnerId);
  });
});

/**
 * §5.7 simultaneous-initiation state machine (E7-F6).
 *
 * When both devices send a first prekey envelope at the same time, each side
 * ends up with two live sessions for the same peer device:
 *
 * - the session it initiated (`initiatedBy = 'local'`), and
 * - the responder session created by the peer's first envelope
 *   (`initiatedBy = 'peer'`).
 *
 * The spec requires both to survive until the first successful receive and to
 * converge on one deterministic winner. Both devices see the same two session
 * ids, so the lexicographically smaller canonical b64u `session_id` is the
 * winner on both sides.
 *
 * Safety rules implemented here:
 *
 * 1. A loser is marked with `supersededBy`/`supersededAt` and is never selected
 *    for sending, but it keeps its keys for a delivery window.
 * 2. The winner's first successful receive persists `winnerConfirmedAt`
 *    (atomically with that receive, in `receive.ts`).
 * 3. Deletion happens only after the confirmation is durable **and** the
 *    delivery window from the later of (confirmation, supersede time) elapsed,
 *    so an envelope already encrypted on the losing chain is still decryptable.
 *    A pending outbox envelope for the loser also defers deletion.
 * 4. Recovery is idempotent: a crash after marking/confirming is reconciled on
 *    the next load/receive; a missing winner promotes the surviving session
 *    instead of silently leaving no usable chain.
 */
import { SUPERSEDED_DELIVERY_WINDOW_MS } from '../constants';
import { listOutboxEntries } from '../outbox/outboxStore';
import type { E2eeStorage } from '../storage/types';
import type { KStorage } from '../storage/kStorage';
import {
  clearSessionSuperseded,
  deleteSession,
  listSessions,
  markSessionSuperseded,
} from './sessionStore';
import type { SessionState } from './types';

export interface SimultaneousPair {
  readonly winner: SessionState;
  readonly loser: SessionState;
}

function pairOf(sessions: readonly SessionState[]): SimultaneousPair | null {
  const local = sessions.filter((session) => session.initiatedBy === 'local');
  const peer = sessions.filter((session) => session.initiatedBy === 'peer');
  // Only the exact simultaneous-handshake pair is deleted automatically. A
  // third session (e.g. created by a later reset) is left to R-15/TTL; deleting
  // it here could drop a chain that is still in use.
  if (local.length !== 1 || peer.length !== 1) return null;
  const left = local[0] as SessionState;
  const right = peer[0] as SessionState;
  return left.sessionId < right.sessionId
    ? { winner: left, loser: right }
    : { winner: right, loser: left };
}

/** Deterministic winner for the simultaneous pair, or `null` if not a pair. */
export function deterministicWinner(sessions: readonly SessionState[]): SessionState | null {
  return pairOf(sessions)?.winner ?? null;
}

/** Winner id from a live pair or from an existing `supersededBy` marker. */
export function parallelWinnerId(sessions: readonly SessionState[]): string | null {
  const pair = pairOf(sessions);
  if (pair !== null) return pair.winner.sessionId;
  const marked = sessions.find(
    (session) => session.supersededBy !== null && session.supersededBy !== undefined,
  );
  return marked?.supersededBy ?? null;
}

/**
 * Adds the persisted winner confirmation to a session state that is about to be
 * committed by a successful receive. It must only be called after the AEAD check
 * succeeded; the caller writes it atomically with the message.
 */
export function confirmWinnerOnReceive(
  peers: readonly SessionState[],
  received: SessionState,
  receivedAt: number,
): SessionState {
  const pair = pairOf(peers);
  if (pair === null || pair.winner.sessionId !== received.sessionId) return received;
  if (received.supersededBy !== null && received.supersededBy !== undefined) return received;
  if (received.winnerConfirmedAt !== null && received.winnerConfirmedAt !== undefined) {
    return received;
  }
  return { ...received, winnerConfirmedAt: receivedAt };
}

export interface ParallelReconcileResult {
  readonly superseded: readonly string[];
  readonly deleted: readonly string[];
  readonly promoted: readonly string[];
}

export interface ParallelReconcileOptions {
  readonly now: number;
  readonly chatId?: string;
  readonly peerDeviceId?: string;
  /** Sessions with an R-15 reset in progress must not be deleted. */
  readonly protectedSessionIds?: ReadonlySet<string>;
  readonly deliveryWindowMs?: number;
}

function groupKey(session: SessionState): string {
  return `${session.chatId}:${session.peerDeviceId}`;
}

/**
 * Idempotent reconciliation of every simultaneous pair (or one chat/peer when a
 * filter is supplied): mark losers, delete confirmed losers whose delivery
 * window has elapsed, and promote a survivor whose recorded winner vanished.
 */
export async function reconcileParallelSessions(
  storage: E2eeStorage,
  kStorage: KStorage,
  options: ParallelReconcileOptions,
): Promise<ParallelReconcileResult> {
  const windowMs = options.deliveryWindowMs ?? SUPERSEDED_DELIVERY_WINDOW_MS;
  const protectedIds = options.protectedSessionIds ?? new Set<string>();
  const groups = new Map<string, SessionState[]>();
  for (const session of await listSessions(storage, kStorage)) {
    if (options.chatId !== undefined && session.chatId !== options.chatId) continue;
    if (options.peerDeviceId !== undefined && session.peerDeviceId !== options.peerDeviceId)
      continue;
    const key = groupKey(session);
    const group = groups.get(key);
    if (group) group.push(session);
    else groups.set(key, [session]);
  }

  const superseded: string[] = [];
  const deleted: string[] = [];
  const promoted: string[] = [];

  for (const sessions of groups.values()) {
    const pair = pairOf(sessions);
    const markedWinner = sessions.find(
      (session) => session.supersededBy !== null && session.supersededBy !== undefined,
    )?.supersededBy;
    const winnerId = pair?.winner.sessionId ?? markedWinner ?? null;
    if (winnerId === null) continue;

    const winner = sessions.find((session) => session.sessionId === winnerId) ?? null;
    if (winner === null) {
      // The recorded winner is gone (e.g. a manual delete or TTL GC). Do not
      // strand the remaining chain: promote it and drop the stale marker.
      for (const session of sessions) {
        if (session.supersededBy === null || session.supersededBy === undefined) continue;
        if (protectedIds.has(session.sessionId)) continue;
        try {
          await clearSessionSuperseded(storage, kStorage, session.sessionId, {
            now: options.now,
          });
          promoted.push(session.sessionId);
        } catch {
          // Retried on the next reconciliation; never lose the only session.
        }
      }
      continue;
    }

    const losers =
      pair !== null
        ? [pair.loser]
        : sessions.filter((session) => session.supersededBy === winnerId);
    for (const loser of losers) {
      if (loser.sessionId === winnerId) continue;
      if (protectedIds.has(loser.sessionId)) continue;
      if (loser.supersededBy === winnerId) continue;
      try {
        await markSessionSuperseded(storage, kStorage, loser.sessionId, winnerId, {
          now: options.now,
        });
        superseded.push(loser.sessionId);
      } catch {
        // Another writer advanced the session; the next receive/load retries.
      }
    }

    // Only delete after the winner's first successful receive. A pending send
    // that still carries the losing session's envelope also defers deletion.
    const confirmedAt = winner.winnerConfirmedAt ?? null;
    if (confirmedAt === null) continue;
    let pendingBySession: Set<string> | null = null;
    for (const loser of losers) {
      if (loser.sessionId === winnerId) continue;
      if (protectedIds.has(loser.sessionId)) continue;
      // If this reconciliation is the one that just marked the loser, the
      // delivery window starts now, not at an older confirmation timestamp.
      const anchor = Math.max(confirmedAt, loser.supersededAt ?? options.now);
      if (options.now - anchor < windowMs) continue;
      if (pendingBySession === null) {
        const pending = await listOutboxEntries(storage, kStorage, { status: 'pending' });
        pendingBySession = new Set<string>();
        for (const entry of pending) {
          for (const envelope of entry.envelopes) pendingBySession.add(envelope.session_id);
        }
      }
      if (pendingBySession.has(loser.sessionId)) continue;
      try {
        await deleteSession(storage, loser.sessionId);
        deleted.push(loser.sessionId);
      } catch {
        // Idempotent: a concurrent reconciliation may already have deleted it.
      }
    }
  }

  return { superseded, deleted, promoted };
}

/** Reload/initialize entry point: reconcile every known pair. */
export function recoverParallelSessions(
  storage: E2eeStorage,
  kStorage: KStorage,
  options: Omit<ParallelReconcileOptions, 'chatId' | 'peerDeviceId'>,
): Promise<ParallelReconcileResult> {
  return reconcileParallelSessions(storage, kStorage, options);
}

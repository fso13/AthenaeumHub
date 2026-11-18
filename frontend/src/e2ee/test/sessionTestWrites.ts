/**
 * Test-only session writers (E7-F5F, CR1d P1-01R-R).
 *
 * Production writes are produced exclusively by the ratchet engine:
 * `ratchetSend`/`ratchetReceive` build the next state and
 * `commitOutgoingMessage`/`commitIncomingMessage` persist it through
 * `prepareSessionRecord` + `writeSessionRecord`. This helper keeps the old
 * `saveSession`/`createSession` convenience for fixtures only; it is not
 * exported from the production `session/sessionStore` module, so arbitrary
 * states cannot be written by application code.
 */
import type { E2eeStorage } from '../storage/types';
import type { KStorage } from '../storage/kStorage';
import type { SessionState } from '../session/types';
import {
  loadSession,
  prepareSessionRecord,
  writeSessionRecord,
  type SessionWriteMode,
} from '../session/sessionStore';

export async function saveSession(
  storage: E2eeStorage,
  kStorage: KStorage,
  state: SessionState,
  mode: SessionWriteMode,
  options: { readonly now?: number } = {},
): Promise<SessionState> {
  // E7-F5G P2-36: an update is verified against the *stored* previous state,
  // so this helper cannot be used to forge a chain rewind either.
  const previous =
    'ifRevision' in mode ? await loadSession(storage, kStorage, state.sessionId) : null;
  const prepared = await prepareSessionRecord(kStorage, state, { ...options, previous });
  const stored = await storage.transact(['sessions'], 'readwrite', async (transaction) =>
    writeSessionRecord(transaction, prepared.record, mode),
  );
  return { ...prepared.state, revision: stored.revision };
}

export async function createSession(
  storage: E2eeStorage,
  kStorage: KStorage,
  state: SessionState,
  options: { readonly now?: number } = {},
): Promise<SessionState> {
  return saveSession(storage, kStorage, { ...state, revision: 0 }, { create: true }, options);
}

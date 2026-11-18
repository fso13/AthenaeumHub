/**
 * R-15 sender-side retry window (§5.5, P1-C/L3b) — pure orchestration helpers.
 *
 * No network and no crypto here: the store re-encrypts through
 * `prepareE2eeSend` and sends each draft separately, exactly as §5.5 requires
 * (one `POST /messages` per message, its own `seq`).
 *
 * The specification anchors the window at `retry_of_client_message_id`. F4's
 * outbox stores the exact send order in `createdAt`, which is the local send
 * index used here. The secondary fallback from the spec (`header.dh`/`n`) is
 * **not implementable** with the F4 record shape (the outbox row does not
 * persist the per-envelope header); if the anchor is unknown locally the reset
 * is ignored rather than guessing a wider window (see E7-F5-REPORT Risks).
 */
import type { WireCryptoEnvelope } from '../api/deviceKeys';
import type { E2eeErrorCode } from '../errors';
import { isResetAllowed } from '../session/reset';
import type { SessionResetBody, SessionResetReason } from '../session/reset';
import { listOutboxEntries, lookupLocalCopy } from '../outbox/outboxStore';
import type { OutboxEntry } from '../outbox/types';
import type { E2eeStorage } from '../storage/types';
import type { KStorage } from '../storage/kStorage';
import type { E2eeRetryCandidate } from './types';

/** §5.5: at most this many messages per reset, in send order. */
export const MAX_RESET_BATCH = 20;

/**
 * Receiver-of-reset dedupe key (E7-F5F). v1 TEXT cannot carry
 * `retry_of_client_message_id`, so the sender's retry window must be exact; a
 * duplicate reset must never re-drive it. The key is the failed session plus
 * the failed chain (`dh`, `n`) and the anchor the peer reported:
 * `(session_id, failed_chain_dh/failed_n, retry_of_client_message_id)`.
 */
export function resetFingerprint(reset: SessionResetBody): string {
  return [
    reset.failedSessionId,
    reset.failedChainDh,
    String(reset.failedN),
    reset.retryOfClientMessageId ?? 'null',
  ].join('|');
}

/**
 * In-memory guard for a duplicated reset control message. The durable second
 * line is the deleted failed session: after the first reset the session record
 * is gone, so a replay after reload is rejected as `invalid_session`.
 */
export class ResetDeduplicator {
  private readonly processed = new Set<string>();
  private readonly maxEntries: number;

  /**
   * Bounded so a long-lived tab cannot grow the set without limit. Only the
   * receiver-of-reset duplicate guard is in-memory; the durable second line is
   * the deleted failed session.
   */
  constructor(maxEntries = 256) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  /** Returns `true` exactly once per reset fingerprint. */
  markProcessed(reset: SessionResetBody): boolean {
    const key = resetFingerprint(reset);
    if (this.processed.has(key)) return false;
    if (this.processed.size >= this.maxEntries) {
      const oldest = this.processed.values().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }
    this.processed.add(key);
    return true;
  }

  hasProcessed(reset: SessionResetBody): boolean {
    return this.processed.has(resetFingerprint(reset));
  }

  /**
   * E7-F5G R-15: a retry batch that failed must not leave the reset marked as
   * processed, otherwise the same reset would be ignored forever and the
   * failed session's messages could never be retried.
   */
  forget(reset: SessionResetBody): void {
    this.processed.delete(resetFingerprint(reset));
  }

  clear(): void {
    this.processed.clear();
  }
}

/** Codes that must trigger a receiver-side SESSION_RESET (§3.3.3, §5.5). */
const RESET_REASON_BY_CODE: Partial<Record<E2eeErrorCode, SessionResetReason>> = {
  SPK_DELETED: 'SPK_DELETED',
  UNKNOWN_SPK: 'UNKNOWN_SPK',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  NO_SESSION: 'NO_SESSION',
  KEY_HANDSHAKE_INVALID: 'KEY_HANDSHAKE_INVALID',
};

export function resetReasonForCode(code: E2eeErrorCode): SessionResetReason | null {
  return RESET_REASON_BY_CODE[code] ?? null;
}

export function isResetErrorCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(RESET_REASON_BY_CODE, code);
}

/**
 * Builds the exact reset body from the envelope the receiver failed on.
 * `retry_of_client_message_id` is the server-echoed `Message.client_message_id`
 * (plaintext metadata, not authenticated content) and is null when absent.
 */
export function buildReceiverReset(input: {
  readonly envelope: Pick<WireCryptoEnvelope, 'session_id' | 'header'>;
  readonly clientMessageId: string | null;
  readonly reason: SessionResetReason;
}): SessionResetBody {
  return {
    failedSessionId: input.envelope.session_id,
    failedChainDh: input.envelope.header.dh,
    failedN: input.envelope.header.n,
    reason: input.reason,
    retryOfClientMessageId: input.clientMessageId,
  };
}

/**
 * Receiver-side rate limit (1 / 300 s per failed session). In-memory by design:
 * it protects against a decrypt-failure loop inside one tab; a durable counter
 * would need a new sealed record type and is out of scope for F5 (documented).
 */
export class ResetRateLimiter {
  private readonly lastSentAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  allow(failedSessionId: string): boolean {
    const allowed = isResetAllowed(this.lastSentAt.get(failedSessionId) ?? null, this.now());
    if (allowed) this.lastSentAt.set(failedSessionId, this.now());
    return allowed;
  }

  clear(failedSessionId: string): void {
    this.lastSentAt.delete(failedSessionId);
  }

  /** Account switch/logout: ephemeral state must not leak into the next user. */
  clearAll(): void {
    this.lastSentAt.clear();
  }
}

export interface RetryWindowResult {
  readonly status: 'pending' | 'anchor_unknown' | 'empty';
  readonly candidates: readonly E2eeRetryCandidate[];
  readonly remaining: number;
  /**
   * E7-F5G P2-35: local copies that could not be read (corrupt/tampered) were
   * skipped instead of aborting the whole reset.
   */
  readonly skipped: number;
}

/**
 * Local send order for the failed session is the message counter `header.n` of
 * that session's envelope. `createdAt` alone is not unique (two sends can share
 * a millisecond) and a random `client_message_id` would reorder the window.
 */
function failedEnvelope(entry: OutboxEntry, failedSessionId: string): WireCryptoEnvelope | null {
  return entry.envelopes.find((candidate) => candidate.session_id === failedSessionId) ?? null;
}

/** §5.5 fallback when the server omitted `clientMessageId` (anchor is null). */
function matchesFailedChain(entry: OutboxEntry, reset: SessionResetBody): boolean {
  const envelope = failedEnvelope(entry, reset.failedSessionId);
  return (
    envelope !== null &&
    envelope.header.dh === reset.failedChainDh &&
    envelope.header.n >= reset.failedN
  );
}

function bySendOrder(): (a: OutboxEntry, b: OutboxEntry) => number {
  return (a, b) => {
    // Durable local send order; `header.n` is per-chain and resets on ratchet.
    if (a.sendOrder !== b.sendOrder) return a.sendOrder - b.sendOrder;
    return a.createdAt - b.createdAt || a.clientMessageId.localeCompare(b.clientMessageId);
  };
}

export interface RetryWindowSelection {
  readonly status: 'pending' | 'empty' | 'anchor_unknown';
  readonly selected: readonly OutboxEntry[];
  readonly remaining: number;
}

/**
 * Pure anchor/order/supersede selection shared by the storage-backed window.
 * Exported for the committed cross-chain/partial-batch regression (G4e).
 */
export function selectRetryWindowEntries(
  entries: readonly OutboxEntry[],
  reset: SessionResetBody,
  maxBatch: number = MAX_RESET_BATCH,
): RetryWindowSelection {
  const all = [...entries].sort(bySendOrder());
  const anchorId = reset.retryOfClientMessageId;
  let anchorIndex =
    anchorId === null ? -1 : all.findIndex((entry) => entry.clientMessageId === anchorId);
  if (anchorIndex < 0) {
    anchorIndex = all.findIndex((entry) => matchesFailedChain(entry, reset));
  }
  if (anchorIndex < 0) return { status: 'anchor_unknown', selected: [], remaining: 0 };
  const window = all
    .slice(anchorIndex)
    .filter(
      (entry) =>
        entry.status !== 'superseded' &&
        (entry.supersededAt === undefined || entry.supersededAt === null),
    );
  if (window.length === 0) return { status: 'empty', selected: [], remaining: 0 };
  const selected = window.slice(0, Math.max(1, maxBatch));
  return {
    status: selected.length > 0 ? 'pending' : 'empty',
    selected,
    remaining: Math.max(0, window.length - selected.length),
  };
}

/**
 * Selects the messages to re-encrypt after a reset: only messages of the
 * **failed session**, from the anchor (inclusive) onward, in send order, capped
 * at `MAX_RESET_BATCH`. Messages before the anchor were already decrypted by
 * the peer and are never retried.
 *
 * `remaining > 0` means the batch limit was hit; the caller must keep those
 * messages `retry_pending` and surface an explicit UI state (no silent drop).
 */
export async function selectRetryWindow(
  storage: E2eeStorage,
  kStorage: KStorage,
  input: {
    readonly chatId: string;
    readonly failedSessionId: string;
    readonly reset: SessionResetBody;
    readonly maxBatch?: number;
  },
): Promise<RetryWindowResult> {
  const all = (await listOutboxEntries(storage, kStorage)).filter(
    (entry) =>
      entry.chatId === input.chatId &&
      entry.envelopes.some((envelope) => envelope.session_id === input.failedSessionId) &&
      entry.type === 'TEXT_JSON',
  );
  const selection = selectRetryWindowEntries(all, input.reset, input.maxBatch);
  if (selection.status !== 'pending') {
    return { status: selection.status, candidates: [], remaining: 0, skipped: 0 };
  }
  const candidates: E2eeRetryCandidate[] = [];
  let skipped = 0;
  for (const entry of selection.selected) {
    // E7-F5G P2-35: one corrupt/tampered local copy must not abort the whole
    // reset. Isolate the failure per entry and report the skipped count.
    try {
      const copy = await lookupLocalCopy(storage, kStorage, input.chatId, entry.clientMessageId);
      if (!copy.available) {
        skipped += 1;
        continue;
      }
      if (copy.copy.contentType !== 1 || copy.copy.text === null) {
        skipped += 1;
        continue;
      }
      candidates.push({
        originalClientMessageId: entry.clientMessageId,
        originalServerMessageId: entry.serverMessageId,
        text: copy.copy.text,
        replyToId: copy.copy.replyToId,
      });
    } catch {
      skipped += 1;
    }
  }
  return {
    status: candidates.length > 0 ? 'pending' : 'empty',
    candidates,
    // Only the undecryptable tail counts as pending; skipped copies are gone
    // from this device and are surfaced separately by the local-copy UI.
    remaining: selection.remaining,
    skipped,
  };
}

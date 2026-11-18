/**
 * Local Double Ratchet session state types and retention rules (§3.4.5, §3.4.5.1).
 *
 * This module owns the *shape* of a session, not the ratchet algorithm: send /
 * receive / handshake are E7-F4. Everything secret is persisted once through
 * `K_storage`; the current `DHs` private key is persisted as a non-extractable
 * `CryptoKey` and the previous pair is dropped on every save (PCS hygiene).
 */
import {
  KEY_BYTES,
  MAX_SKIPPED_AGE_MS,
  MAX_SKIPPED_PER_CHAIN,
  MAX_SKIPPED_TOTAL,
  MAX_SKIP,
  SESSION_IDLE_TTL_MS,
  SESSION_ID_BYTES,
} from '../constants';
import { type EncryptedRecord } from '../storage/kStorage';
import { E2eeError } from '../errors';

/** Session initiator marker (§5.7). */
export type SessionInitiator = 'local' | 'peer';

export interface SkippedMessageKey {
  /** Ratchet public key (32 bytes) whose receiving chain produced this key. */
  readonly dh: Uint8Array;
  /** Message number inside that chain. */
  readonly n: number;
  readonly messageKey: Uint8Array;
  /** Milliseconds since epoch; drives `MAX_SKIPPED_AGE`. */
  readonly createdAt: number;
}

export interface SessionState {
  /** Canonical b64u of the 16-byte session id (§3.4.5). */
  readonly sessionId: string;
  /** Local device that owns this session (per `(chat, device, peer_device)`). */
  readonly deviceId: string;
  readonly chatId: string;
  readonly peerUserId: string;
  readonly peerDeviceId: string;
  readonly peerIkSig: Uint8Array;
  readonly peerIkDh: Uint8Array;
  readonly rootKey: Uint8Array;
  /** Current sending ratchet private key; non-extractable, only one is kept. */
  readonly dhPrivateKey: CryptoKey;
  readonly dhPublicKey: Uint8Array;
  readonly dhRemote: Uint8Array | null;
  readonly chainSend: Uint8Array | null;
  readonly chainRecv: Uint8Array | null;
  readonly ns: number;
  readonly nr: number;
  readonly pn: number;
  /** SPK id used by this session's prekey message (E7-F3/F4, retained for rotation). */
  readonly spkId?: string | null;
  /**
   * Who initiated the session: the local device (we sent the prekey envelope)
   * or the peer (we received one). Drives the §5.7 tie-break when two sessions
   * exist for the same peer device after simultaneous initiation.
   */
  readonly initiatedBy?: SessionInitiator | null;
  /** Last successful receive in this session; §5.7 prefers that session for sends. */
  readonly lastReceivedAt?: number | null;
  /**
   * E7-F6 §5.7: deterministic winner of a simultaneous-initiation pair.
   *
   * A session with `supersededBy !== null` lost the deterministic tie-break and
   * must never be selected for sending, but it is **not deleted immediately**:
   * its keys stay readable for `SUPERSEDED_DELIVERY_WINDOW_MS` so an envelope
   * that was already in flight on the losing chain is not lost. `supersededAt`
   * records when the decision became durable.
   */
  readonly supersededBy?: string | null;
  readonly supersededAt?: number | null;
  /**
   * E7-F6 §5.7: set on the winner by the first successful receive committed
   * after the pair was known. It is the "first receive/confirm" gate for
   * deleting the losing session and is persisted so a reload can resume the
   * deletion idempotently.
   */
  readonly winnerConfirmedAt?: number | null;
  readonly skipped: readonly SkippedMessageKey[];
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly localCopyRef: string | null;
  /** Optimistic-concurrency token; incremented by every persisted write. */
  readonly revision: number;
}

/** Serialised session record. Secret material lives only inside `secrets`. */
export interface StoredSessionRecord {
  readonly v: 1;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly chatId: string;
  readonly peerUserId: string;
  readonly peerDeviceId: string;
  readonly peerIkSig: string;
  readonly peerIkDh: string;
  readonly dhPublicKey: string;
  readonly dhRemote: string | null;
  /**
   * SHA-256 commitment to the sealed sending chain (b64u32, or null when the
   * chain is absent). It is not secret and is tamper detection only: it lets
   * the store notice a record whose plaintext metadata no longer matches the
   * sealed chain. It is **not** the P1-01R-R fix; production writes come from
   * `ratchetSend`/`ratchetReceive` via the outbox commit functions, and the
   * arbitrary `saveSession`/`createSession` writers live only in the test
   * helper (`src/e2ee/test/sessionTestWrites.ts`).
   */
  readonly chainSendCommitment: string | null;
  /**
   * SHA-256 commitment to the sealed receiving chain (E7-F5G, P2-36), used by
   * the store to bind a prepared update to the exact previous state and to
   * detect a chain that was swapped under the same revision.
   */
  readonly chainRecvCommitment: string | null;
  /**
   * Fingerprint of the exact previous state this record was derived from
   * (E7-F5G). `null` only for a create. `writeSessionRecord` recomputes it from
   * the record it read inside the transaction, so a prepared transition cannot
   * be replayed against a different/advanced state.
   */
  readonly previousStateFingerprint: string | null;
  readonly ns: number;
  readonly nr: number;
  readonly pn: number;
  readonly spkId?: string | null;
  readonly initiatedBy?: SessionInitiator | null;
  readonly lastReceivedAt?: number | null;
  /** E7-F6 §5.7 winner/superseded metadata (plaintext + sealed cross-check). */
  readonly supersededBy?: string | null;
  readonly supersededAt?: number | null;
  readonly winnerConfirmedAt?: number | null;
  /**
   * Non-extractable `CryptoKey` (structured-cloneable in IndexedDB). It cannot
   * be sealed by `K_storage` without exporting it, which §2.3 forbids.
   */
  readonly dhPrivateKey: CryptoKey;
  readonly secrets: EncryptedRecord;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly localCopyRef: string | null;
  readonly revision: number;
}

export interface StoredSessionSecrets {
  readonly v: 1;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly ns: number;
  readonly nr: number;
  readonly pn: number;
  /** Sealed copy of the plaintext `spkId`; F2's metadata cross-check rule. */
  readonly spkId?: string | null;
  readonly initiatedBy?: SessionInitiator | null;
  readonly lastReceivedAt?: number | null;
  readonly supersededBy?: string | null;
  readonly supersededAt?: number | null;
  readonly winnerConfirmedAt?: number | null;
  readonly dhPublicKey: string;
  readonly rootKey: string;
  readonly chainSend: string | null;
  readonly chainRecv: string | null;
  readonly skipped: ReadonlyArray<{
    readonly dh: string;
    readonly n: number;
    readonly messageKey: string;
    readonly createdAt: number;
  }>;
}

export const SESSION_ID_BYTES_VALUE = SESSION_ID_BYTES;
export const SESSION_KEY_BYTES = KEY_BYTES;

export interface SkippedKeyRetentionOptions {
  readonly now: number;
  readonly maxTotal?: number;
  readonly maxPerChain?: number;
  readonly maxAgeMs?: number;
}

export interface SkippedKeyRetentionResult {
  readonly kept: readonly SkippedMessageKey[];
  readonly evicted: number;
}

/**
 * `skip_message_keys` retention (§3.4.4/§3.4.5.1): drop keys older than
 * `MAX_SKIPPED_AGE`, then the oldest keys beyond the per-chain and per-session
 * limits. Eviction is counted so callers can emit the required metric later.
 */
export function pruneSkippedKeys(
  keys: readonly SkippedMessageKey[],
  options: SkippedKeyRetentionOptions,
): SkippedKeyRetentionResult {
  const maxTotal = options.maxTotal ?? MAX_SKIPPED_TOTAL;
  const maxPerChain = options.maxPerChain ?? MAX_SKIPPED_PER_CHAIN;
  const maxAgeMs = options.maxAgeMs ?? MAX_SKIPPED_AGE_MS;
  const cutoff = options.now - maxAgeMs;

  const fresh = keys.filter((key) => key.createdAt > cutoff);
  const byChain = new Map<string, SkippedMessageKey[]>();
  for (const key of fresh) {
    const label = chainLabel(key.dh);
    const chain = byChain.get(label);
    if (chain) chain.push(key);
    else byChain.set(label, [key]);
  }

  const survivors: SkippedMessageKey[] = [];
  let evicted = keys.length - fresh.length;
  for (const chain of byChain.values()) {
    const ordered = [...chain].sort((a, b) => a.createdAt - b.createdAt);
    const excess = ordered.length - maxPerChain;
    if (excess > 0) {
      evicted += excess;
      survivors.push(...ordered.slice(excess));
    } else {
      survivors.push(...ordered);
    }
  }

  survivors.sort((a, b) => a.createdAt - b.createdAt);
  const overflow = survivors.length - maxTotal;
  if (overflow > 0) {
    evicted += overflow;
    survivors.splice(0, overflow);
  }

  return { kept: survivors, evicted };
}

function chainLabel(dh: Uint8Array): string {
  let label = '';
  for (const byte of dh) label += byte.toString(16).padStart(2, '0');
  return label;
}

/** `MAX_SKIP` guard for a single chain (§3.4.4). */
export function assertSkipWindow(nr: number, until: number): void {
  if (until - nr > MAX_SKIP) {
    throw new E2eeError('SESSION_TOO_FAR_BEHIND', 'too many skipped messages');
  }
}

export function isSessionIdle(
  state: Pick<SessionState, 'lastUsedAt'>,
  now: number,
  idleTtlMs = SESSION_IDLE_TTL_MS,
): boolean {
  return now - state.lastUsedAt >= idleTtlMs;
}

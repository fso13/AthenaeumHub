/**
 * Outbox and local-copy record types (§3.4.6, §5.2).
 *
 * The outbox stores the *exact* envelope bytes plus the idempotency key before
 * the network call; a retry after a crash re-sends those bytes and never
 * re-encrypts. The local copy is the sender's only copy of a message (there is
 * no self-envelope), so it is committed in the same transaction and sealed
 * with `K_storage`.
 */
import type { WireCryptoEnvelope } from '../api/deviceKeys';
import type { EncryptedRecord } from '../storage/kStorage';

export type OutboxStatus = 'pending' | 'sent' | 'failed' | 'superseded';
export type LocalCopyDirection = 'outgoing' | 'incoming';
export type LocalCopyStatus = 'pending' | 'sent' | 'received' | 'failed' | 'superseded';
export type OutgoingMessageType = 'TEXT_JSON' | 'SESSION_RESET';

export interface OutboxPayloadV1 {
  readonly v: 1;
  readonly chatId: string;
  readonly sessionId: string;
  readonly senderDeviceId: string;
  readonly clientMessageId: string;
  readonly localMessageId: string;
  readonly type: OutgoingMessageType;
  readonly idempotencyKey: string;
  readonly envelopes: readonly WireCryptoEnvelope[];
  readonly recipientDeviceIds: readonly string[];
  readonly retryOfClientMessageId: string | null;
}

export interface StoredOutboxEntry {
  readonly v: 1;
  readonly clientMessageId: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly senderDeviceId: string;
  readonly localMessageId: string;
  readonly status: OutboxStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly serverMessageId: string | null;
  readonly seq: number | null;
  readonly warning: string | null;
  /** Durable local send order assigned at commit (not per-chain `header.n`). */
  readonly sendOrder?: number;
  /** Set when R-15 replaced this row after it was already `sent`. */
  readonly supersededAt?: number | null;
  /**
   * G4e #30: mirror of the sealed payload's `retryOfClientMessageId` so the
   * "replacement confirmed" transition can supersede the original in the same
   * IndexedDB transaction (a failing follow-up `markSuperseded` can then never
   * lose the replacement or resurrect the original).
   */
  readonly retryOfClientMessageId?: string | null;
  /** Durable retry deadline; `null` means "not scheduled" (or permanent failure). */
  readonly nextAttemptAt?: number | null;
  /** Last time a send attempt started (durable across reload). */
  readonly lastAttemptAt?: number | null;
  readonly payload: EncryptedRecord;
}

/** Decrypted outbox view used by the future send worker (E7-F5). */
export interface OutboxEntry {
  readonly clientMessageId: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly senderDeviceId: string;
  readonly status: OutboxStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly serverMessageId: string | null;
  readonly seq: number | null;
  readonly warning: string | null;
  readonly type: OutgoingMessageType;
  readonly idempotencyKey: string;
  readonly envelopes: readonly WireCryptoEnvelope[];
  readonly recipientDeviceIds: readonly string[];
  readonly retryOfClientMessageId: string | null;
  readonly localMessageId: string;
  readonly sendOrder: number;
  readonly supersededAt?: number | null;
  /** Durable retry deadline; `null` means not scheduled or a permanent failure. */
  readonly nextAttemptAt: number | null;
  readonly lastAttemptAt: number | null;
}

export interface LocalCopyPayloadV1 {
  readonly v: 1;
  readonly chatId: string;
  readonly sessionId: string;
  /** Device that authored the message: local device for outgoing, peer device for incoming. */
  readonly senderDeviceId: string;
  readonly clientMessageId: string | null;
  readonly localMessageId: string;
  readonly direction: LocalCopyDirection;
  readonly contentType: 1 | 2;
  readonly text: string | null;
  /** One ciphertext per fan-out envelope, canonical b64u. */
  readonly ciphertexts: readonly string[];
  readonly replyToId: string | null;
  readonly createdAt: number;
  readonly serverMessageId: string | null;
}

export interface StoredLocalMessageCopy {
  readonly v: 1;
  readonly key: string;
  readonly localMessageId: string;
  readonly clientMessageId: string | null;
  readonly chatId: string;
  readonly sessionId: string;
  /** Plaintext scope, cross-checked against the sealed payload on read. */
  readonly direction: LocalCopyDirection;
  readonly senderDeviceId: string;
  readonly status: LocalCopyStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly content: EncryptedRecord;
}

export interface LocalMessageCopy {
  readonly localMessageId: string;
  readonly clientMessageId: string | null;
  readonly chatId: string;
  readonly sessionId: string;
  readonly senderDeviceId: string;
  readonly status: LocalCopyStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly direction: LocalCopyDirection;
  readonly contentType: 1 | 2;
  readonly text: string | null;
  readonly ciphertexts: readonly string[];
  readonly replyToId: string | null;
  readonly serverMessageId: string | null;
}

/** "Недоступно на этом устройстве": copy is gone, but the send fact remains. */
export interface MissingLocalMessageCopy {
  readonly available: false;
  readonly clientMessageId: string;
}

export type LocalCopyLookup =
  { readonly available: true; readonly copy: LocalMessageCopy } | MissingLocalMessageCopy;

export interface OutboxSendResult {
  readonly serverMessageId: string;
  readonly seq: number;
  readonly warning?: string | null;
}

export interface OutboxDrainResult {
  readonly sent: readonly string[];
  readonly failed: ReadonlyArray<{ readonly clientMessageId: string; readonly code: string }>;
  /** Earliest durable retry deadline left after this pass, or `null`. */
  readonly nextAttemptAt: number | null;
  /** Rows that were not due yet / not auto-retryable during this pass. */
  readonly skipped: number;
}

/**
 * Atomic outbox + local-copy store (§3.4.6, P0-4).
 *
 * Write order is normative and enforced by a single IndexedDB transaction:
 * ratchet state + exact envelope bytes + idempotency key + client_message_id +
 * `K_storage`-sealed local plaintext/ciphertext commit together, and only then
 * may the caller touch the network. A crash before commit leaves nothing; after
 * commit the pending row is restored byte-for-byte and never re-encrypted.
 *
 * There is no self-envelope: the local copy is the sender's only copy. If it is
 * gone (cache cleared), `lookupLocalCopy` reports `available:false` instead of
 * inventing a message.
 */
import {
  KEY_BYTES,
  MAX_ENVELOPES_PER_MESSAGE,
  MAX_HEADER_COUNTER,
  MAX_INNER_BODY_BYTES,
  MAX_TEXT_CHARS,
} from '../constants';
import { E2eeError, isE2eeError } from '../errors';
import { isUuid, utf8, zeroBytes } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { type E2eeStorage, type E2eeTransaction } from '../storage/types';
import { type EncryptedRecord, type KStorage } from '../storage/kStorage';
import {
  type WireCryptoEnvelope,
  parseWireEnvelope,
  serializeWireEnvelope,
} from '../api/deviceKeys';
import {
  type PreparedSessionRecord,
  type SessionWriteMode,
  prepareSessionRecord,
  writeSessionRecord,
} from '../session/sessionStore';
import { consumeOneTimePrekeyInTransaction } from '../session/prekeyStore';
import type { SessionState, StoredSessionRecord } from '../session/types';
import { OUTBOX_LOCK, type E2eeLockManager } from '../locks/locks';
import type { SessionResetBody, SessionResetReason } from '../session/reset';
import type {
  LocalCopyDirection,
  LocalCopyLookup,
  LocalCopyPayloadV1,
  LocalCopyStatus,
  LocalMessageCopy,
  OutboxDrainResult,
  OutboxEntry,
  OutboxPayloadV1,
  OutboxSendResult,
  OutboxStatus,
  OutgoingMessageType,
  StoredLocalMessageCopy,
  StoredOutboxEntry,
} from './types';

const OUTBOX_PREFIX = 'outbox:';
const RETRY_PREFIX = 'retry:';
const LOCAL_COPY_PREFIX = 'local:';
const STORED_VERSION = 1;
const MIN_CIPHERTEXT_BYTES = 272;
const MAX_CIPHERTEXT_BYTES = 33040;

/**
 * G4e #30 durable retry policy. The schedule is persisted (`nextAttemptAt`), so
 * a reload/tab switch continues the same backoff instead of hammering the
 * server. No jitter: one worker per profile (single-flight) makes a herd
 * unlikely, and a deterministic schedule keeps the retry contract testable.
 */
export const OUTBOX_BACKOFF_BASE_MS = 2_000;
export const OUTBOX_BACKOFF_MAX_MS = 5 * 60_000;

/** Transport/API error codes that are worth retrying automatically. */
const RETRYABLE_OUTBOX_CODES: ReadonlySet<string> = new Set([
  'NETWORK',
  'NETWORK_ERROR',
  'TIMEOUT',
  'E2EE_UNAVAILABLE',
  'IDEMPOTENCY_IN_PROGRESS',
  'RATE_LIMITED',
  'TOO_MANY_REQUESTS',
  'SERVICE_UNAVAILABLE',
  'INTERNAL',
  'INTERNAL_ERROR',
  'HTTP_500',
  'HTTP_502',
  'HTTP_503',
  'HTTP_504',
]);

export function isRetryableOutboxCode(code: string): boolean {
  if (RETRYABLE_OUTBOX_CODES.has(code)) return true;
  return /^HTTP_5\d\d$/.test(code);
}

export function outboxBackoffMs(attempts: number): number {
  const safe = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  return Math.min(OUTBOX_BACKOFF_BASE_MS * 2 ** Math.min(safe - 1, 16), OUTBOX_BACKOFF_MAX_MS);
}

/**
 * Durable R-15 retry intent. It holds only reset metadata (session id, public
 * chain DH, counter, reason, anchor client id) — never plaintext or keys — and
 * lets a reload resume the pending retry UI/drain and clean up the failed
 * session once every replacement has been confirmed.
 */
export interface StoredRetryState {
  readonly v: 1;
  readonly chatId: string;
  readonly senderDeviceId: string;
  readonly reset: SessionResetBody;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface OutboxDraft {
  readonly chatId: string;
  readonly sessionId: string;
  readonly clientMessageId: string;
  readonly localMessageId: string;
  readonly type: OutgoingMessageType;
  readonly idempotencyKey: string;
  readonly envelopes: readonly WireCryptoEnvelope[];
  readonly retryOfClientMessageId?: string | null;
  readonly createdAt?: number;
}

export interface LocalCopyDraft {
  readonly chatId: string;
  readonly sessionId: string;
  readonly clientMessageId: string | null;
  readonly localMessageId: string;
  readonly direction: LocalCopyDirection;
  /**
   * Author of the message. Outgoing copies always use `K_storage.ownerDeviceId`
   * and ignore this field; incoming copies must name the peer's device, which is
   * never allowed to land in the outgoing namespace.
   */
  readonly senderDeviceId?: string;
  readonly contentType: 1 | 2;
  readonly text: string | null;
  readonly ciphertexts?: readonly string[];
  readonly replyToId?: string | null;
  readonly serverMessageId?: string | null;
  readonly createdAt?: number;
}

/**
 * One advanced fan-out session that must commit atomically with the outbox row
 * and the local copy (E7-F4). Multi-device sends advance one session per
 * recipient device; committing them in separate transactions would leave the
 * persisted bytes and the persisted chains out of sync after a crash.
 */
export interface AdditionalSessionWrite {
  readonly state: SessionState;
  readonly mode: SessionWriteMode;
  /** Persisted state the fan-out transition was derived from (E7-F5G). */
  readonly previousState?: SessionState | null;
}

export interface OutgoingMessageDraft extends OutboxDraft {
  /**
   * Ratchet state produced by the send step. Required for every E2EE send: a
   * commit without it would persist an outbox row while leaving the chain at
   * `CKs/Ns` already used for this `MK` (AES-GCM nonce reuse, P1-01).
   */
  readonly sessionState: SessionState;
  /**
   * Persisted state the send transition was derived from (E7-F5G P2-36).
   * Required whenever `sessionState.revision > 0`; the store verifies the
   * forward KDF step and binds it to the stored record.
   */
  readonly previousSessionState?: SessionState | null;
  /** The remaining per-device sessions of a fan-out, committed atomically. */
  readonly additionalSessionStates?: readonly AdditionalSessionWrite[];
  readonly text: string | null;
  readonly ciphertexts?: readonly string[];
  readonly replyToId?: string | null;
}

export interface PreparedAdditionalSession {
  readonly record: StoredSessionRecord;
  readonly state: SessionState;
  readonly mode: SessionWriteMode;
}

export interface PreparedOutgoingMessage {
  readonly session: PreparedSessionRecord;
  readonly additionalSessions: readonly PreparedAdditionalSession[];
  readonly outbox: StoredOutboxEntry;
  readonly localCopy: StoredLocalMessageCopy;
}

export interface IncomingMessageDraft {
  readonly sessionState?: SessionState | null;
  readonly sessionMode?: SessionWriteMode;
  /** Persisted state a receive transition was derived from (E7-F5G P2-36). */
  readonly previousSessionState?: SessionState | null;
  readonly localCopy: LocalCopyDraft;
  readonly oneTimePrekeyId?: string | null;
  readonly now?: number;
}

export interface PreparedIncomingMessage {
  readonly session: PreparedSessionRecord | null;
  readonly sessionMode: SessionWriteMode | null;
  readonly localCopy: StoredLocalMessageCopy;
  readonly oneTimePrekeyId: string | null;
  readonly now: number;
}

export function outboxStorageKey(clientMessageId: string): string {
  requireUuid(clientMessageId, 'client_message_id');
  return `${OUTBOX_PREFIX}${clientMessageId}`;
}

export interface LocalCopyKeyParts {
  readonly chatId: string;
  readonly direction: LocalCopyDirection;
  readonly senderDeviceId: string;
  readonly clientMessageId: string | null;
  readonly localMessageId: string;
}

/**
 * Local-copy namespace:
 * `local:<chat>:<direction>:<sender-device>:c:<client_message_id>`
 * or `...:l:<local_message_id>` when there is no client id.
 *
 * `chat_id`, `direction` and the sender device are mandatory scope segments, so
 * a peer-controlled `client_message_id` can never resolve to the sender's own
 * outgoing copy, nor can two chats/senders collide (CR1 P1-02). The `c:`/`l:`
 * tag keeps the two id kinds in disjoint namespaces as well.
 */
export function localCopyStorageKey(parts: LocalCopyKeyParts): string {
  requireUuid(parts.chatId, 'chat_id');
  requireUuid(parts.senderDeviceId, 'sender_device_id');
  requireUuid(parts.localMessageId, 'local_message_id');
  if (parts.direction !== 'outgoing' && parts.direction !== 'incoming') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unsupported local copy direction');
  }
  const clientMessageId = requireUuidOrNull(parts.clientMessageId, 'client_message_id');
  // The id segment is tagged by kind as well: a peer-controlled
  // `client_message_id` can never collide with a local-message-id-keyed record.
  const idSegment = clientMessageId === null ? `l:${parts.localMessageId}` : `c:${clientMessageId}`;
  return `${LOCAL_COPY_PREFIX}${parts.chatId}:${parts.direction}:${parts.senderDeviceId}:${idSegment}`;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} must be a canonical UUID`);
  }
  return value;
}

function requireUuidOrNull(value: string | null, label: string): string | null {
  return value === null ? null : requireUuid(value, label);
}

function requireSessionId(value: string): string {
  try {
    decodeBase64Url(value, 16);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'session_id must be canonical b64u16');
  }
  return value;
}

function requireTimestamp(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', `${label} is not a valid timestamp`);
  }
  return value;
}

function requireSeq(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'seq is invalid');
  }
  return value;
}

interface EnvelopeScope {
  readonly chatId: string;
  readonly senderDeviceId: string;
  /** When present, every envelope must belong to one of these sessions. */
  readonly sessionIds?: ReadonlySet<string>;
}

/**
 * CR1b P2-02: envelopes are not opaque here. Every envelope must belong to the
 * draft's chat and sender device (no smuggled cross-chat/cross-device bytes),
 * and duplicate recipient devices or session ids are rejected before commit.
 */
function normalizeEnvelopes(
  envelopes: readonly WireCryptoEnvelope[],
  scope: EnvelopeScope,
): WireCryptoEnvelope[] {
  if (!Array.isArray(envelopes) || envelopes.length === 0) {
    throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'outbox needs at least one envelope');
  }
  if (envelopes.length > MAX_ENVELOPES_PER_MESSAGE) {
    throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'too many envelopes for one message');
  }
  const recipients = new Set<string>();
  const sessions = new Set<string>();
  return envelopes.map((envelope) => {
    const normalized = serializeWireEnvelope(parseWireEnvelope(envelope));
    if (normalized.chat_id !== scope.chatId) {
      throw new E2eeError(
        'INVALID_ENVELOPE_FORMAT',
        'envelope.chat_id does not match the outbox draft',
      );
    }
    if (normalized.sender_device_id !== scope.senderDeviceId) {
      throw new E2eeError(
        'INVALID_ENVELOPE_FORMAT',
        'envelope.sender_device_id is not this device',
      );
    }
    if (scope.sessionIds && !scope.sessionIds.has(normalized.session_id)) {
      throw new E2eeError('SESSION_STATE_STALE', 'envelope session is not part of this draft');
    }
    if (recipients.has(normalized.recipient_device_id)) {
      throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'duplicate envelope recipient device');
    }
    if (sessions.has(normalized.session_id)) {
      throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'duplicate envelope session');
    }
    recipients.add(normalized.recipient_device_id);
    sessions.add(normalized.session_id);
    return normalized;
  });
}

function validateCiphertext(value: string): string {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Url(value);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy ciphertext is not canonical b64u');
  }
  if (bytes.length < MIN_CIPHERTEXT_BYTES || bytes.length > MAX_CIPHERTEXT_BYTES) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy ciphertext length is invalid');
  }
  return value;
}

function validateText(text: string | null, contentType: 1 | 2): string | null {
  if (text === null) {
    if (contentType === 1) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'text local copy cannot be empty');
    }
    return null;
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy text is invalid');
  }
  if (utf8(text).length > MAX_INNER_BODY_BYTES) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy text exceeds the body limit');
  }
  if ([...text].length > MAX_TEXT_CHARS) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy text exceeds the character limit');
  }
  return text;
}

function encryptJson(
  kStorage: KStorage,
  value: unknown,
  clientMessageId: string | null,
  sessionId: string,
  recordType: 'outbox' | 'localCopy',
): Promise<EncryptedRecord> {
  const plaintext = utf8(JSON.stringify(value));
  return kStorage
    .encrypt(plaintext, { sessionId, clientMessageId, recordType })
    .finally(() => zeroBytes(plaintext));
}

export async function prepareOutboxEntry(
  kStorage: KStorage,
  draft: OutboxDraft,
  options: { readonly additionalSessionIds?: readonly string[] } = {},
): Promise<StoredOutboxEntry> {
  requireUuid(draft.chatId, 'chat_id');
  requireSessionId(draft.sessionId);
  requireUuid(draft.clientMessageId, 'client_message_id');
  requireUuid(draft.localMessageId, 'local_message_id');
  requireUuid(draft.idempotencyKey, 'idempotency_key');
  requireUuidOrNull(draft.retryOfClientMessageId ?? null, 'retry_of_client_message_id');
  if (draft.type !== 'TEXT_JSON' && draft.type !== 'SESSION_RESET') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unsupported outgoing message type');
  }
  const allowedSessionIds = new Set<string>([
    draft.sessionId,
    ...(options.additionalSessionIds ?? []),
  ]);
  const envelopes = normalizeEnvelopes(draft.envelopes, {
    chatId: draft.chatId,
    senderDeviceId: kStorage.ownerDeviceId,
    sessionIds: allowedSessionIds,
  });
  const recipientDeviceIds = [
    ...new Set(
      envelopes.map((envelope) => requireUuid(envelope.recipient_device_id, 'recipient_device_id')),
    ),
  ];
  const createdAt = requireTimestamp(draft.createdAt ?? Date.now(), 'createdAt');

  const payload: OutboxPayloadV1 = {
    v: 1,
    chatId: draft.chatId,
    sessionId: draft.sessionId,
    senderDeviceId: kStorage.ownerDeviceId,
    clientMessageId: draft.clientMessageId,
    localMessageId: draft.localMessageId,
    type: draft.type,
    idempotencyKey: draft.idempotencyKey,
    envelopes,
    recipientDeviceIds,
    retryOfClientMessageId: draft.retryOfClientMessageId ?? null,
  };
  const encrypted = await encryptJson(
    kStorage,
    payload,
    draft.clientMessageId,
    draft.sessionId,
    'outbox',
  );
  return {
    v: 1,
    clientMessageId: draft.clientMessageId,
    chatId: draft.chatId,
    sessionId: draft.sessionId,
    senderDeviceId: kStorage.ownerDeviceId,
    localMessageId: draft.localMessageId,
    status: 'pending',
    createdAt,
    updatedAt: createdAt,
    attempts: 0,
    lastErrorCode: null,
    serverMessageId: null,
    seq: null,
    warning: null,
    retryOfClientMessageId: draft.retryOfClientMessageId ?? null,
    nextAttemptAt: null,
    lastAttemptAt: null,
    payload: encrypted,
  };
}

export async function prepareLocalCopy(
  kStorage: KStorage,
  draft: LocalCopyDraft,
): Promise<StoredLocalMessageCopy> {
  requireUuid(draft.chatId, 'chat_id');
  requireSessionId(draft.sessionId);
  requireUuid(draft.localMessageId, 'local_message_id');
  const clientMessageId = requireUuidOrNull(draft.clientMessageId, 'client_message_id');
  const replyToId = requireUuidOrNull(draft.replyToId ?? null, 'reply_to_id');
  const serverMessageId = requireUuidOrNull(draft.serverMessageId ?? null, 'server_message_id');
  const createdAt = requireTimestamp(draft.createdAt ?? Date.now(), 'createdAt');
  if (draft.direction !== 'outgoing' && draft.direction !== 'incoming') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unsupported local copy direction');
  }
  const senderDeviceId =
    draft.direction === 'outgoing'
      ? kStorage.ownerDeviceId
      : requireIncomingSenderDeviceId(draft.senderDeviceId);
  if (draft.contentType !== 1 && draft.contentType !== 2) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unsupported local copy content type');
  }
  const text = validateText(draft.text, draft.contentType);
  const ciphertexts = (draft.ciphertexts ?? []).map(validateCiphertext);
  if (ciphertexts.length === 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy needs at least one ciphertext');
  }

  const key = localCopyStorageKey({
    chatId: draft.chatId,
    direction: draft.direction,
    senderDeviceId,
    clientMessageId,
    localMessageId: draft.localMessageId,
  });
  const payload: LocalCopyPayloadV1 = {
    v: 1,
    chatId: draft.chatId,
    sessionId: draft.sessionId,
    senderDeviceId,
    clientMessageId,
    localMessageId: draft.localMessageId,
    direction: draft.direction,
    contentType: draft.contentType,
    text,
    ciphertexts,
    replyToId,
    createdAt,
    serverMessageId,
  };
  const encrypted = await encryptJson(
    kStorage,
    payload,
    clientMessageId,
    draft.sessionId,
    'localCopy',
  );
  return {
    v: 1,
    key,
    localMessageId: draft.localMessageId,
    clientMessageId,
    chatId: draft.chatId,
    sessionId: draft.sessionId,
    direction: draft.direction,
    senderDeviceId,
    status: draft.direction === 'outgoing' ? 'pending' : 'received',
    createdAt,
    updatedAt: createdAt,
    content: encrypted,
  };
}

function requireIncomingSenderDeviceId(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new E2eeError(
      'KEY_STORAGE_UNAVAILABLE',
      'incoming local copy needs the sender device id',
    );
  }
  return requireUuid(value, 'sender_device_id');
}

function assertAdditionalSessionDraft(
  state: SessionState,
  draft: OutboxDraft,
  envelopes: readonly WireCryptoEnvelope[],
  ownerDeviceId: string,
  takenSessionIds: ReadonlySet<string>,
): void {
  const sessionId = state.sessionId;
  if (takenSessionIds.has(sessionId)) {
    throw new E2eeError('SESSION_STATE_STALE', 'fan-out contains the same session twice');
  }
  if (state.chatId !== draft.chatId) {
    throw new E2eeError('SESSION_STATE_STALE', 'fan-out session belongs to another chat');
  }
  if (state.deviceId !== ownerDeviceId) {
    throw new E2eeError('SESSION_STATE_STALE', 'fan-out session belongs to another local device');
  }
  const matches = envelopes.filter((envelope) => envelope.session_id === sessionId);
  if (matches.length === 0) {
    throw new E2eeError('SESSION_STATE_STALE', 'fan-out session has no envelope in this message');
  }
  const recipientIds = new Set(matches.map((envelope) => envelope.recipient_device_id));
  if (recipientIds.size !== 1 || !recipientIds.has(state.peerDeviceId)) {
    throw new E2eeError(
      'SESSION_STATE_STALE',
      'fan-out session peer does not match its envelope recipient',
    );
  }
  assertEnvelopeChainStep(matches[0]!, state, ownerDeviceId);
}

/** CR1b P1-01R: the persisted envelope must describe the persisted chain step. */
function assertEnvelopeChainStep(
  envelope: WireCryptoEnvelope,
  state: SessionState,
  ownerDeviceId: string,
): void {
  if (envelope.session_id !== state.sessionId) {
    throw new E2eeError('SESSION_STATE_STALE', 'envelope session does not match the session state');
  }
  if (envelope.chat_id !== state.chatId) {
    throw new E2eeError('SESSION_STATE_STALE', 'envelope chat does not match the session state');
  }
  if (envelope.sender_device_id !== ownerDeviceId) {
    throw new E2eeError('SESSION_STATE_STALE', 'envelope sender is not this device');
  }
  if (envelope.recipient_device_id !== state.peerDeviceId) {
    throw new E2eeError('SESSION_STATE_STALE', 'envelope recipient is not the session peer');
  }
  if (envelope.header.dh !== encodeBase64Url(state.dhPublicKey)) {
    throw new E2eeError('SESSION_STATE_STALE', 'envelope header.dh does not match DHs');
  }
  if (envelope.header.pn !== state.pn) {
    throw new E2eeError('SESSION_STATE_STALE', 'envelope header.pn does not match the session');
  }
  // The state has already advanced for this message: header.n = ns - 1.
  if (state.ns < 1 || envelope.header.n !== state.ns - 1) {
    throw new E2eeError(
      'SESSION_STATE_STALE',
      'envelope header.n must be exactly the shifted session counter minus one',
    );
  }
}

/**
 * Encrypts everything a send needs *before* the transaction; the returned
 * object is written atomically by `commitOutgoingMessage`.
 */
export async function prepareOutgoingMessage(
  kStorage: KStorage,
  draft: OutgoingMessageDraft,
): Promise<PreparedOutgoingMessage> {
  // P1-01: a send without the shifted state is not representable. Fail before
  // any outbox/local-copy ciphertext is produced.
  const sessionState = draft.sessionState as SessionState | null | undefined;
  if (!sessionState) {
    throw new E2eeError(
      'SESSION_STATE_MISSING',
      'E2EE send requires the shifted session state (nonce reuse is not allowed)',
    );
  }
  const additionalDrafts = draft.additionalSessionStates ?? [];
  const allowedSessionIds = new Set<string>([
    draft.sessionId,
    ...additionalDrafts.map((write) => write.state.sessionId),
  ]);
  const envelopes = normalizeEnvelopes(draft.envelopes, {
    chatId: draft.chatId,
    senderDeviceId: kStorage.ownerDeviceId,
    sessionIds: allowedSessionIds,
  });
  const ciphertexts = draft.ciphertexts ?? envelopes.map((envelope) => envelope.ciphertext);
  const session = await prepareSessionRecord(kStorage, sessionState, {
    now: draft.createdAt,
    previous: sessionState.revision > 0 ? (draft.previousSessionState ?? null) : null,
  });
  if (session.record.sessionId !== draft.sessionId) {
    throw new E2eeError('SESSION_STATE_STALE', 'session state belongs to another session');
  }
  if (session.record.chatId !== draft.chatId) {
    throw new E2eeError('SESSION_STATE_STALE', 'session state belongs to another chat');
  }
  const primaryEnvelope = envelopes.filter(
    (envelope) => envelope.session_id === session.record.sessionId,
  );
  if (primaryEnvelope.length !== 1) {
    throw new E2eeError(
      'SESSION_STATE_STALE',
      'the primary session needs exactly one envelope in this message',
    );
  }
  assertEnvelopeChainStep(primaryEnvelope[0]!, session.state, kStorage.ownerDeviceId);
  const outbox = await prepareOutboxEntry(
    kStorage,
    {
      chatId: draft.chatId,
      sessionId: draft.sessionId,
      clientMessageId: draft.clientMessageId,
      localMessageId: draft.localMessageId,
      type: draft.type,
      idempotencyKey: draft.idempotencyKey,
      envelopes,
      retryOfClientMessageId: draft.retryOfClientMessageId ?? null,
      createdAt: draft.createdAt,
    },
    {
      additionalSessionIds: additionalDrafts.map((write) => write.state.sessionId),
    },
  );
  const localCopy = await prepareLocalCopy(kStorage, {
    chatId: draft.chatId,
    sessionId: draft.sessionId,
    clientMessageId: draft.clientMessageId,
    localMessageId: draft.localMessageId,
    direction: 'outgoing',
    contentType: draft.type === 'SESSION_RESET' ? 2 : 1,
    text: draft.text,
    ciphertexts,
    replyToId: draft.replyToId ?? null,
    createdAt: draft.createdAt,
  });
  const taken = new Set<string>([session.record.sessionId]);
  const additionalSessions: PreparedAdditionalSession[] = [];
  for (const write of additionalDrafts) {
    assertAdditionalSessionDraft(write.state, draft, envelopes, kStorage.ownerDeviceId, taken);
    taken.add(write.state.sessionId);
    const preparedAdditional = await prepareSessionRecord(kStorage, write.state, {
      now: draft.createdAt,
      previous: write.state.revision > 0 ? (write.previousState ?? null) : null,
    });
    additionalSessions.push({
      record: preparedAdditional.record,
      state: preparedAdditional.state,
      mode: write.mode,
    });
  }
  return { session, additionalSessions, outbox, localCopy };
}

/**
 * The only allowed send prelude: state + outbox + local copy in one
 * transaction. Nothing is sent until this promise resolves.
 *
 * P1-01: the session part is mandatory and must describe the same session,
 * chat and local message as the outbox/local-copy parts. A sessionless or
 * cross-wired commit fails closed before writing anything.
 */
export async function commitOutgoingMessage(
  storage: E2eeStorage,
  prepared: PreparedOutgoingMessage,
  mode: SessionWriteMode,
): Promise<SessionState> {
  const session = prepared.session as PreparedSessionRecord | null | undefined;
  if (!session) {
    throw new E2eeError(
      'SESSION_STATE_MISSING',
      'E2EE send commit requires the shifted session state',
    );
  }
  if (
    session.record.sessionId !== prepared.outbox.sessionId ||
    session.record.chatId !== prepared.outbox.chatId ||
    prepared.localCopy.chatId !== session.record.chatId ||
    prepared.localCopy.sessionId !== session.record.sessionId ||
    prepared.localCopy.localMessageId !== prepared.outbox.localMessageId ||
    prepared.localCopy.direction !== 'outgoing' ||
    prepared.localCopy.senderDeviceId !== session.record.deviceId
  ) {
    throw new E2eeError(
      'SESSION_STATE_STALE',
      'session state does not match the outbox/local-copy draft',
    );
  }
  const additionalSessions = prepared.additionalSessions ?? [];
  const additionalIds = new Set<string>();
  for (const extra of additionalSessions) {
    if (
      extra.record.chatId !== prepared.outbox.chatId ||
      extra.record.deviceId !== session.record.deviceId ||
      extra.record.sessionId === session.record.sessionId ||
      additionalIds.has(extra.record.sessionId)
    ) {
      throw new E2eeError(
        'SESSION_STATE_STALE',
        'additional session state does not match the outbox draft',
      );
    }
    additionalIds.add(extra.record.sessionId);
  }
  const stores = ['outbox', 'localMessages', 'sessions'] as const;
  return storage.transact(stores, 'readwrite', async (transaction) => {
    const stored = await writeSessionRecord(transaction, session.record, mode);
    const updatedSession = { ...session.state, revision: stored.revision };
    for (const extra of additionalSessions) {
      await writeSessionRecord(transaction, extra.record, extra.mode);
    }
    const outboxKey = outboxStorageKey(prepared.outbox.clientMessageId);
    const existingOutbox = await transaction.get<StoredOutboxEntry>('outbox', outboxKey);
    const existingCopy = await transaction.get<StoredLocalMessageCopy>(
      'localMessages',
      prepared.localCopy.key,
    );
    if (existingOutbox !== null || existingCopy !== null) {
      throw new E2eeError('OUTBOX_CONFLICT', 'outgoing message was already committed');
    }
    // Persist a durable local order across chains: `header.n` resets after a
    // ratchet and must never be used to order R-15 retries (G4d P1-05).
    let maxSendOrder = 0;
    for (const key of await transaction.keys('outbox')) {
      const row = await transaction.get<StoredOutboxEntry>('outbox', key);
      if (row?.sendOrder !== undefined && row.sendOrder > maxSendOrder) {
        maxSendOrder = row.sendOrder;
      }
    }
    const outbox = { ...prepared.outbox, sendOrder: maxSendOrder + 1 };
    await transaction.put('outbox', outboxKey, outbox);
    await transaction.put('localMessages', prepared.localCopy.key, prepared.localCopy);
    return updatedSession;
  });
}

/**
 * Prepares the receive side before the transaction: encrypt the plaintext copy
 * and, when there is one, the shifted session state.
 */
export async function prepareIncomingMessage(
  kStorage: KStorage,
  draft: IncomingMessageDraft,
): Promise<PreparedIncomingMessage> {
  if (draft.sessionState && !draft.sessionMode) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'incoming session needs a write mode');
  }
  if (!draft.sessionState && draft.sessionMode) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'incoming write mode needs a session state');
  }
  if (draft.localCopy.direction !== 'incoming') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'incoming commit needs an incoming local copy');
  }
  const localCopy = await prepareLocalCopy(kStorage, draft.localCopy);
  if (draft.sessionState && localCopy.senderDeviceId !== draft.sessionState.peerDeviceId) {
    throw new E2eeError('SESSION_STATE_STALE', 'local copy sender does not match the session peer');
  }
  if (
    draft.sessionState &&
    (draft.sessionState.sessionId !== localCopy.sessionId ||
      draft.sessionState.chatId !== localCopy.chatId)
  ) {
    throw new E2eeError('SESSION_STATE_STALE', 'session state does not match the incoming copy');
  }
  const session = draft.sessionState
    ? await prepareSessionRecord(kStorage, draft.sessionState, {
        now: localCopy.createdAt,
        previous: draft.sessionState.revision > 0 ? (draft.previousSessionState ?? null) : null,
      })
    : null;
  return {
    session,
    sessionMode: draft.sessionMode ?? null,
    localCopy,
    oneTimePrekeyId: draft.oneTimePrekeyId ?? null,
    now: draft.now ?? Date.now(),
  };
}

/**
 * Receive-side atomic unit (§3.4.6): shifted state + consumed OPK + plaintext
 * copy commit together. The caller decrypts first; a failed AEAD never opens
 * this transaction, so the OPK survives (§3.4.5.1).
 */
export async function commitIncomingMessage(
  storage: E2eeStorage,
  prepared: PreparedIncomingMessage,
): Promise<SessionState | null> {
  if (prepared.localCopy.direction !== 'incoming') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'incoming commit needs an incoming local copy');
  }
  const stores = [
    'localMessages',
    ...(prepared.session ? (['sessions'] as const) : []),
    ...(prepared.oneTimePrekeyId ? (['prekeys'] as const) : []),
  ] as const;
  return storage.transact(stores, 'readwrite', async (transaction) => {
    let updatedSession: SessionState | null = null;
    if (prepared.session) {
      if (!prepared.sessionMode) {
        throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'incoming session needs a write mode');
      }
      const stored = await writeSessionRecord(
        transaction,
        prepared.session.record,
        prepared.sessionMode,
      );
      updatedSession = { ...prepared.session.state, revision: stored.revision };
    }
    if (prepared.oneTimePrekeyId) {
      await consumeOneTimePrekeyInTransaction(transaction, prepared.oneTimePrekeyId, prepared.now);
    }
    const existing = await transaction.get<StoredLocalMessageCopy>(
      'localMessages',
      prepared.localCopy.key,
    );
    if (existing !== null) {
      throw new E2eeError('DUPLICATE_OR_OLD_MESSAGE', 'incoming message was already stored');
    }
    await transaction.put('localMessages', prepared.localCopy.key, prepared.localCopy);
    return updatedSession;
  });
}

export async function readOutboxEntry(
  storage: E2eeStorage,
  kStorage: KStorage,
  clientMessageId: string,
): Promise<OutboxEntry | null> {
  const stored = await storage.get<StoredOutboxEntry>('outbox', outboxStorageKey(clientMessageId));
  if (stored === null) return null;
  return decryptOutboxEntry(kStorage, stored);
}

async function decryptOutboxEntry(
  kStorage: KStorage,
  stored: StoredOutboxEntry,
): Promise<OutboxEntry> {
  if (stored.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox entry version is unsupported');
  }
  requireUuid(stored.clientMessageId, 'client_message_id');
  requireUuid(stored.chatId, 'chat_id');
  requireSessionId(stored.sessionId);
  requireUuid(stored.senderDeviceId, 'sender_device_id');
  requireUuid(stored.localMessageId, 'local_message_id');
  requireTimestamp(stored.createdAt, 'createdAt');
  requireTimestamp(stored.updatedAt, 'updatedAt');
  requireSeq(stored.seq);
  requireUuidOrNull(stored.serverMessageId, 'server_message_id');
  if (!Number.isInteger(stored.attempts) || stored.attempts < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox attempts are invalid');
  }
  // G4e #30: these transition fields participate in anchor/supersede ordering,
  // so a locally tampered row must fail closed instead of silently reordering
  // the retry window.
  if (stored.sendOrder !== undefined) {
    if (!Number.isInteger(stored.sendOrder) || stored.sendOrder < 0) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox sendOrder is invalid');
    }
  }
  if (stored.supersededAt !== undefined && stored.supersededAt !== null) {
    requireTimestamp(stored.supersededAt, 'supersededAt');
  }
  if (stored.nextAttemptAt !== undefined && stored.nextAttemptAt !== null) {
    requireTimestamp(stored.nextAttemptAt, 'nextAttemptAt');
  }
  if (stored.lastAttemptAt !== undefined && stored.lastAttemptAt !== null) {
    requireTimestamp(stored.lastAttemptAt, 'lastAttemptAt');
  }
  requireUuidOrNull(stored.retryOfClientMessageId ?? null, 'retry_of_client_message_id');
  const plaintext = await decryptRecord(kStorage, stored.payload, {
    sessionId: stored.sessionId,
    clientMessageId: stored.clientMessageId,
    recordType: 'outbox',
  });
  let payload: OutboxPayloadV1;
  try {
    payload = parseOutboxPayload(plaintext);
  } finally {
    zeroBytes(plaintext);
  }
  if (
    payload.clientMessageId !== stored.clientMessageId ||
    payload.chatId !== stored.chatId ||
    payload.sessionId !== stored.sessionId ||
    payload.senderDeviceId !== stored.senderDeviceId ||
    payload.localMessageId !== stored.localMessageId ||
    (stored.retryOfClientMessageId !== undefined &&
      payload.retryOfClientMessageId !== (stored.retryOfClientMessageId ?? null))
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox record metadata was tampered with');
  }
  return {
    clientMessageId: stored.clientMessageId,
    chatId: stored.chatId,
    sessionId: stored.sessionId,
    senderDeviceId: stored.senderDeviceId,
    status: requireOutboxStatus(stored.status),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    attempts: stored.attempts,
    lastErrorCode: stored.lastErrorCode,
    serverMessageId: stored.serverMessageId,
    seq: stored.seq,
    warning: stored.warning,
    type: payload.type,
    idempotencyKey: payload.idempotencyKey,
    envelopes: payload.envelopes,
    recipientDeviceIds: payload.recipientDeviceIds,
    retryOfClientMessageId: payload.retryOfClientMessageId,
    localMessageId: payload.localMessageId,
    sendOrder: stored.sendOrder ?? 0,
    supersededAt: stored.supersededAt ?? null,
    nextAttemptAt: stored.nextAttemptAt ?? null,
    lastAttemptAt: stored.lastAttemptAt ?? null,
  };
}

async function decryptRecord(
  kStorage: KStorage,
  record: EncryptedRecord,
  fields: { sessionId: string; clientMessageId: string | null; recordType: 'outbox' | 'localCopy' },
): Promise<Uint8Array> {
  try {
    return await kStorage.decrypt(record, fields);
  } catch (error) {
    if (isE2eeError(error) && error.code === 'DECRYPT_FAILED') {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'stored record cannot be decrypted');
    }
    throw error;
  }
}

function requireOutboxStatus(value: OutboxStatus): OutboxStatus {
  if (value !== 'pending' && value !== 'sent' && value !== 'failed' && value !== 'superseded') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown outbox status');
  }
  return value;
}

function requireLocalCopyStatus(value: LocalCopyStatus): LocalCopyStatus {
  if (
    value !== 'pending' &&
    value !== 'sent' &&
    value !== 'received' &&
    value !== 'failed' &&
    value !== 'superseded'
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown local copy status');
  }
  return value;
}

function parseOutboxPayload(bytes: Uint8Array): OutboxPayloadV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox payload is malformed');
  }
  const candidate = parsed as Partial<OutboxPayloadV1>;
  if (candidate.v !== STORED_VERSION) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox payload version is unsupported');
  }
  if (
    typeof candidate.chatId !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.senderDeviceId !== 'string' ||
    typeof candidate.clientMessageId !== 'string' ||
    typeof candidate.localMessageId !== 'string' ||
    typeof candidate.idempotencyKey !== 'string' ||
    (candidate.type !== 'TEXT_JSON' && candidate.type !== 'SESSION_RESET') ||
    !Array.isArray(candidate.envelopes) ||
    !Array.isArray(candidate.recipientDeviceIds) ||
    (candidate.retryOfClientMessageId !== null &&
      typeof candidate.retryOfClientMessageId !== 'string')
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outbox payload is malformed');
  }
  requireUuid(candidate.chatId, 'chat_id');
  requireSessionId(candidate.sessionId);
  requireUuid(candidate.senderDeviceId, 'sender_device_id');
  requireUuid(candidate.clientMessageId, 'client_message_id');
  requireUuid(candidate.localMessageId, 'local_message_id');
  requireUuid(candidate.idempotencyKey, 'idempotency_key');
  requireUuidOrNull(candidate.retryOfClientMessageId, 'retry_of_client_message_id');
  const envelopes = normalizeEnvelopes(candidate.envelopes as WireCryptoEnvelope[], {
    chatId: candidate.chatId,
    senderDeviceId: candidate.senderDeviceId,
  });
  const recipientDeviceIds = candidate.recipientDeviceIds.map((value) =>
    requireUuid(value as string, 'recipient_device_id'),
  );
  return {
    v: 1,
    chatId: candidate.chatId,
    sessionId: candidate.sessionId,
    senderDeviceId: candidate.senderDeviceId,
    clientMessageId: candidate.clientMessageId,
    localMessageId: candidate.localMessageId,
    type: candidate.type,
    idempotencyKey: candidate.idempotencyKey,
    envelopes,
    recipientDeviceIds,
    retryOfClientMessageId: candidate.retryOfClientMessageId,
  };
}

export async function listOutboxEntries(
  storage: E2eeStorage,
  kStorage: KStorage,
  filter: { readonly status?: OutboxStatus } = {},
): Promise<OutboxEntry[]> {
  const keys = await storage.keys('outbox');
  const entries: OutboxEntry[] = [];
  for (const key of keys) {
    if (!key.startsWith(OUTBOX_PREFIX)) continue;
    const stored = await storage.get<StoredOutboxEntry>('outbox', key);
    if (stored === null) continue;
    if (filter.status && stored.status !== filter.status) continue;
    entries.push(await decryptOutboxEntry(kStorage, stored));
  }
  return entries.sort(
    (a, b) => a.createdAt - b.createdAt || a.clientMessageId.localeCompare(b.clientMessageId),
  );
}

/** Idempotent restore: decrypt-only, never mutates or re-encrypts. */
export async function restorePendingOutbox(
  storage: E2eeStorage,
  kStorage: KStorage,
): Promise<OutboxEntry[]> {
  return listOutboxEntries(storage, kStorage, { status: 'pending' });
}

/**
 * Starts one durable attempt. A `failed` row may be picked up again only when
 * it is due (or when the caller forces a manual retry through
 * `retryOutboxEntry`); `sent`/`superseded` are terminal and never resurrect.
 */
export async function markOutboxAttempt(
  storage: E2eeStorage,
  clientMessageId: string,
  options: { readonly now?: number } = {},
): Promise<number> {
  const key = outboxStorageKey(clientMessageId);
  const now = options.now ?? Date.now();
  return storage.transact(['outbox', 'localMessages'], 'readwrite', async (transaction) => {
    const stored = await transaction.get<StoredOutboxEntry>('outbox', key);
    if (stored === null) throw new E2eeError('OUTBOX_CONFLICT', 'outbox entry does not exist');
    if (stored.status === 'sent' || stored.status === 'superseded') {
      throw new E2eeError('OUTBOX_CONFLICT', 'outbox entry is terminal');
    }
    const due = stored.nextAttemptAt ?? null;
    if (due !== null && due > now) {
      throw new E2eeError('OUTBOX_CONFLICT', 'outbox entry is not due yet');
    }
    const attempts = stored.attempts + 1;
    await transaction.put<StoredOutboxEntry>('outbox', key, {
      ...stored,
      status: 'pending',
      attempts,
      lastErrorCode: null,
      lastAttemptAt: now,
      nextAttemptAt: null,
      updatedAt: now,
    });
    await updateLocalCopyStatus(transaction, stored, 'pending', now);
    return attempts;
  });
}

function outgoingLocalCopyKey(outbox: StoredOutboxEntry): string {
  return localCopyStorageKey({
    chatId: outbox.chatId,
    direction: 'outgoing',
    senderDeviceId: outbox.senderDeviceId,
    clientMessageId: outbox.clientMessageId,
    localMessageId: outbox.localMessageId,
  });
}

async function updateLocalCopyStatus(
  transaction: E2eeTransaction,
  outbox: StoredOutboxEntry,
  status: LocalCopyStatus,
  now: number,
): Promise<void> {
  const key = outgoingLocalCopyKey(outbox);
  const copy = await transaction.get<StoredLocalMessageCopy>('localMessages', key);
  if (copy === null) return;
  await transaction.put<StoredLocalMessageCopy>('localMessages', key, {
    ...copy,
    status,
    updatedAt: now,
  });
}

/**
 * Confirms one row and, when it is an R-15 replacement, supersedes its original
 * **in the same IndexedDB transaction**. This is the G4e #30 fix for the
 * `confirmSent` → `markSuperseded` gap: a failure in the follow-up call can no
 * longer leave a sent replacement with a still-pending original (which the next
 * reset would re-encrypt as a duplicate).
 */
export async function markOutboxSent(
  storage: E2eeStorage,
  clientMessageId: string,
  result: OutboxSendResult,
  options: { readonly now?: number } = {},
): Promise<void> {
  requireUuid(clientMessageId, 'client_message_id');
  requireUuid(result.serverMessageId, 'server_message_id');
  if (!Number.isInteger(result.seq) || result.seq < 0) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'server seq is invalid');
  }
  const key = outboxStorageKey(clientMessageId);
  const now = options.now ?? Date.now();
  await storage.transact(['outbox', 'localMessages'], 'readwrite', async (transaction) => {
    const stored = await transaction.get<StoredOutboxEntry>('outbox', key);
    if (stored === null) throw new E2eeError('OUTBOX_CONFLICT', 'outbox entry does not exist');
    if (stored.status === 'sent') {
      if (stored.serverMessageId === result.serverMessageId && stored.seq === result.seq) {
        await supersedeOriginalInTransaction(transaction, stored, now);
        return;
      }
      throw new E2eeError('OUTBOX_CONFLICT', 'outbox entry was already sent with another id');
    }
    if (stored.status === 'superseded') {
      throw new E2eeError('OUTBOX_CONFLICT', 'superseded outbox entry cannot be sent');
    }
    await transaction.put<StoredOutboxEntry>('outbox', key, {
      ...stored,
      status: 'sent',
      serverMessageId: result.serverMessageId,
      seq: result.seq,
      warning: result.warning ?? null,
      lastErrorCode: null,
      nextAttemptAt: null,
      updatedAt: now,
    });
    await updateLocalCopyStatus(transaction, stored, 'sent', now);
    await supersedeOriginalInTransaction(transaction, stored, now);
  });
}

/**
 * Marks the original of a confirmed replacement as replaced. The outbox row of
 * an already-`sent` original stays terminal `sent` (P1-01a) but receives
 * `supersededAt`; a pending/failed original becomes `superseded`, which is the
 * durable barrier against resurrecting it later.
 */
async function supersedeOriginalInTransaction(
  transaction: E2eeTransaction,
  replacement: StoredOutboxEntry,
  now: number,
): Promise<void> {
  const originalId = replacement.retryOfClientMessageId ?? null;
  if (originalId === null || originalId === replacement.clientMessageId) return;
  const originalKey = outboxStorageKey(originalId);
  const original = await transaction.get<StoredOutboxEntry>('outbox', originalKey);
  if (original === null || original.chatId !== replacement.chatId) return;
  if (original.status === 'superseded' || (original.supersededAt ?? null) !== null) return;
  const next: StoredOutboxEntry =
    original.status === 'sent'
      ? { ...original, supersededAt: now, nextAttemptAt: null, updatedAt: now }
      : {
          ...original,
          status: 'superseded',
          supersededAt: now,
          nextAttemptAt: null,
          updatedAt: now,
        };
  await transaction.put<StoredOutboxEntry>('outbox', originalKey, next);
  await updateLocalCopyStatus(transaction, original, 'superseded', now);
}

export interface OutboxFailureOptions {
  readonly now?: number;
  /** `false` schedules nothing (permanent 4xx/validation failure). */
  readonly retryable?: boolean;
  /** Server `Retry-After` hint; falls back to the persisted exponential backoff. */
  readonly retryAfterMs?: number;
}

export async function markOutboxFailed(
  storage: E2eeStorage,
  clientMessageId: string,
  errorCode: string,
  options: OutboxFailureOptions = {},
): Promise<void> {
  const key = outboxStorageKey(clientMessageId);
  const now = options.now ?? Date.now();
  await storage.transact(['outbox', 'localMessages'], 'readwrite', async (transaction) => {
    const stored = await transaction.get<StoredOutboxEntry>('outbox', key);
    if (stored === null) throw new E2eeError('OUTBOX_CONFLICT', 'outbox entry does not exist');
    if (stored.status === 'sent') return;
    // CR1c: a superseded row belongs to a successful replacement. Downgrading
    // it to `failed` would let `retryOutboxEntry` resurrect a replaced message.
    if (stored.status === 'superseded') return;
    const retryable = options.retryable ?? isRetryableOutboxCode(errorCode);
    const delay = Math.max(
      0,
      options.retryAfterMs ?? outboxBackoffMs(Math.max(1, stored.attempts)),
    );
    await transaction.put<StoredOutboxEntry>('outbox', key, {
      ...stored,
      status: 'failed',
      lastErrorCode: errorCode,
      nextAttemptAt: retryable ? now + delay : null,
      updatedAt: now,
    });
    await updateLocalCopyStatus(transaction, stored, 'failed', now);
  });
}

export async function markOutboxSuperseded(
  storage: E2eeStorage,
  clientMessageId: string,
  options: { readonly now?: number } = {},
): Promise<void> {
  const key = outboxStorageKey(clientMessageId);
  const now = options.now ?? Date.now();
  await storage.transact(['outbox', 'localMessages'], 'readwrite', async (transaction) => {
    const stored = await transaction.get<StoredOutboxEntry>('outbox', key);
    if (stored === null) return;
    // G4e #30: supersede is idempotent by timestamp too. A repeated call (e.g.
    // a resumed retry batch) must not rewrite `supersededAt` with a newer time,
    // otherwise anchor/order diagnostics stop matching the original transition.
    if (stored.status === 'superseded' || (stored.supersededAt ?? null) !== null) return;
    // R-15 may supersede a message after `confirmSent` already moved the row to
    // `sent`. The outbox row stays terminal `sent`, but the sealed local copy
    // must become `superseded`, otherwise reload renders the original next to
    // its replacement (G4b P1-01). A pending/failed original becomes terminal
    // `superseded`, so no later `retryOutboxEntry`/drain can resurrect it.
    if (stored.status === 'sent') {
      await transaction.put<StoredOutboxEntry>('outbox', key, {
        ...stored,
        supersededAt: now,
        nextAttemptAt: null,
        updatedAt: now,
      });
    } else {
      await transaction.put<StoredOutboxEntry>('outbox', key, {
        ...stored,
        status: 'superseded',
        supersededAt: now,
        nextAttemptAt: null,
        updatedAt: now,
      });
    }
    await updateLocalCopyStatus(transaction, stored, 'superseded', now);
  });
}

export async function retryOutboxEntry(
  storage: E2eeStorage,
  clientMessageId: string,
  options: { readonly now?: number } = {},
): Promise<void> {
  const key = outboxStorageKey(clientMessageId);
  const now = options.now ?? Date.now();
  await storage.transact(['outbox', 'localMessages'], 'readwrite', async (transaction) => {
    const stored = await transaction.get<StoredOutboxEntry>('outbox', key);
    if (stored === null) return;
    // Only an explicitly failed row may be retried; `sent`/`superseded` are
    // terminal for this entry (the replacement has its own client id).
    if (stored.status !== 'failed' || (stored.supersededAt ?? null) !== null) return;
    // G4e #30: never resurrect an original that already has a replacement row.
    // Its pending/failed replacement is drained instead, so the same plaintext
    // cannot be re-encrypted (and duplicated) a second time.
    for (const otherKey of await transaction.keys('outbox')) {
      if (!otherKey.startsWith(OUTBOX_PREFIX) || otherKey === key) continue;
      const other = await transaction.get<StoredOutboxEntry>('outbox', otherKey);
      if (other?.retryOfClientMessageId === clientMessageId) return;
    }
    await transaction.put<StoredOutboxEntry>('outbox', key, {
      ...stored,
      status: 'pending',
      lastErrorCode: null,
      nextAttemptAt: null,
      updatedAt: now,
    });
    await updateLocalCopyStatus(transaction, stored, 'pending', now);
  });
}

export async function removeOutboxEntry(
  storage: E2eeStorage,
  clientMessageId: string,
): Promise<void> {
  await storage.delete('outbox', outboxStorageKey(clientMessageId));
}

/* ------------------------------------------------------------------ */
/* G4e #30: durable R-15 retry intent + reconcile/drain state machine  */
/* ------------------------------------------------------------------ */

const RESET_REASONS: ReadonlySet<string> = new Set<SessionResetReason>([
  'SPK_DELETED',
  'UNKNOWN_SPK',
  'DECRYPT_FAILED',
  'NO_SESSION',
  'KEY_HANDSHAKE_INVALID',
]);

export function retryStateStorageKey(chatId: string, failedSessionId: string): string {
  requireUuid(chatId, 'chat_id');
  requireSessionId(failedSessionId);
  return `${RETRY_PREFIX}${chatId}:${failedSessionId}`;
}

function requireResetBody(value: unknown): SessionResetBody {
  if (typeof value !== 'object' || value === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'retry reset body is malformed');
  }
  const candidate = value as Partial<SessionResetBody>;
  if (
    typeof candidate.failedSessionId !== 'string' ||
    typeof candidate.failedChainDh !== 'string' ||
    typeof candidate.failedN !== 'number' ||
    !Number.isInteger(candidate.failedN) ||
    candidate.failedN < 0 ||
    candidate.failedN > MAX_HEADER_COUNTER ||
    typeof candidate.reason !== 'string' ||
    !RESET_REASONS.has(candidate.reason) ||
    (candidate.retryOfClientMessageId !== null &&
      (typeof candidate.retryOfClientMessageId !== 'string' ||
        !isUuid(candidate.retryOfClientMessageId)))
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'retry reset body is malformed');
  }
  requireSessionId(candidate.failedSessionId);
  try {
    decodeBase64Url(candidate.failedChainDh, KEY_BYTES);
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'retry failed_chain_dh is invalid');
  }
  return {
    failedSessionId: candidate.failedSessionId,
    failedChainDh: candidate.failedChainDh,
    failedN: candidate.failedN,
    reason: candidate.reason as SessionResetReason,
    retryOfClientMessageId: candidate.retryOfClientMessageId,
  };
}

/**
 * Persists the retry intent before any replacement is sent. Only metadata is
 * stored (no plaintext/key material), and the record stays in place until every
 * replacement of that failed session is confirmed.
 */
export async function putRetryState(
  storage: E2eeStorage,
  input: {
    readonly chatId: string;
    readonly senderDeviceId: string;
    readonly reset: SessionResetBody;
  },
  options: { readonly now?: number } = {},
): Promise<StoredRetryState> {
  const now = options.now ?? Date.now();
  const reset = requireResetBody(input.reset);
  const record: StoredRetryState = {
    v: 1,
    chatId: requireUuid(input.chatId, 'chat_id'),
    senderDeviceId: requireUuid(input.senderDeviceId, 'sender_device_id'),
    reset,
    createdAt: now,
    updatedAt: now,
  };
  await storage.put('outbox', retryStateStorageKey(record.chatId, reset.failedSessionId), record);
  return record;
}

export async function getRetryState(
  storage: E2eeStorage,
  chatId: string,
  failedSessionId: string,
): Promise<StoredRetryState | null> {
  const stored = await storage.get<StoredRetryState>(
    'outbox',
    retryStateStorageKey(chatId, failedSessionId),
  );
  if (stored === null) return null;
  return validateRetryState(stored);
}

export async function listRetryStates(
  storage: E2eeStorage,
  chatId?: string,
): Promise<StoredRetryState[]> {
  const keys = await storage.keys('outbox');
  const states: StoredRetryState[] = [];
  for (const key of keys) {
    if (!key.startsWith(RETRY_PREFIX)) continue;
    const stored = await storage.get<StoredRetryState>('outbox', key);
    if (stored === null) continue;
    const validated = validateRetryState(stored);
    if (chatId !== undefined && validated.chatId !== chatId) continue;
    states.push(validated);
  }
  return states.sort((a, b) => a.createdAt - b.createdAt);
}

function validateRetryState(stored: StoredRetryState): StoredRetryState {
  if (stored.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'retry state version is unsupported');
  }
  const reset = requireResetBody(stored.reset);
  requireUuid(stored.chatId, 'chat_id');
  requireUuid(stored.senderDeviceId, 'sender_device_id');
  requireTimestamp(stored.createdAt, 'createdAt');
  requireTimestamp(stored.updatedAt, 'updatedAt');
  return { ...stored, reset };
}

export async function deleteRetryState(
  storage: E2eeStorage,
  chatId: string,
  failedSessionId: string,
): Promise<void> {
  await storage.delete('outbox', retryStateStorageKey(chatId, failedSessionId));
}

export interface OutboxRetryStatus {
  readonly chatId: string;
  /** Pending rows plus retryable failed rows that still have a schedule. */
  readonly pending: number;
  /** Failed rows that need an explicit user retry (no schedule). */
  readonly permanent: number;
  /** Earliest scheduled retry, or `null` when nothing is scheduled. */
  readonly nextAttemptAt: number | null;
}

/** Aggregate durable retry state per chat (UI `retry_pending` count). */
export async function outboxRetryStatus(
  storage: E2eeStorage,
  kStorage: KStorage,
  options: { readonly chatId?: string; readonly now?: number } = {},
): Promise<OutboxRetryStatus[]> {
  const now = options.now ?? Date.now();
  const entries = (await listOutboxEntries(storage, kStorage)).filter(
    (entry) => options.chatId === undefined || entry.chatId === options.chatId,
  );
  const replaced = new Set(
    entries
      .map((entry) => entry.retryOfClientMessageId)
      .filter((id): id is string => id !== null && id !== undefined),
  );
  const byChat = new Map<string, { pending: number; permanent: number; next: number | null }>();
  for (const entry of entries) {
    if (entry.status === 'sent' || entry.status === 'superseded') continue;
    if (entry.retryOfClientMessageId === null && replaced.has(entry.clientMessageId)) continue;
    const bucket = byChat.get(entry.chatId) ?? { pending: 0, permanent: 0, next: null };
    if (entry.status === 'pending') {
      bucket.pending += 1;
      bucket.next = now;
    } else if (entry.nextAttemptAt !== null) {
      bucket.pending += 1;
      bucket.next =
        bucket.next === null ? entry.nextAttemptAt : Math.min(bucket.next, entry.nextAttemptAt);
    } else {
      bucket.permanent += 1;
    }
    byChat.set(entry.chatId, bucket);
  }
  return [...byChat.entries()]
    .map(([chatId, bucket]) => ({
      chatId,
      pending: bucket.pending,
      permanent: bucket.permanent,
      nextAttemptAt: bucket.pending > 0 ? bucket.next : null,
    }))
    .sort((a, b) => a.chatId.localeCompare(b.chatId));
}

/** Rows the durable worker may send now (single-flight handled by the caller). */
export async function listDrainCandidates(
  storage: E2eeStorage,
  kStorage: KStorage,
  options: { readonly now?: number; readonly chatId?: string; readonly force?: boolean } = {},
): Promise<OutboxEntry[]> {
  const now = options.now ?? Date.now();
  const entries = await listOutboxEntries(storage, kStorage);
  const replaced = new Set(
    entries
      .map((entry) => entry.retryOfClientMessageId)
      .filter((id): id is string => id !== null && id !== undefined),
  );
  return entries
    .filter((entry) => {
      if (options.chatId !== undefined && entry.chatId !== options.chatId) return false;
      if (entry.status === 'sent' || entry.status === 'superseded') return false;
      // An original with a replacement must never be sent; its replacement is
      // the durable single copy of that plaintext.
      if (entry.retryOfClientMessageId === null && replaced.has(entry.clientMessageId)) {
        return false;
      }
      if (entry.status === 'failed') {
        if (entry.nextAttemptAt === null) return false;
        if (!options.force && entry.nextAttemptAt > now) return false;
      }
      if (entry.status === 'pending' && !options.force && (entry.nextAttemptAt ?? 0) > now) {
        return false;
      }
      return true;
    })
    .sort(
      (a, b) =>
        a.sendOrder - b.sendOrder ||
        a.createdAt - b.createdAt ||
        a.clientMessageId.localeCompare(b.clientMessageId),
    );
}

export interface OutboxReconcileResult {
  /** Replacement rows that were made terminal by the reconcile pass. */
  readonly superseded: readonly string[];
  /** Failed sessions whose replacement(s) are all confirmed. */
  readonly completedFailedSessionIds: readonly string[];
}

/**
 * Idempotent load/chat-switch reconcile (G4e #30):
 *
 * - a confirmed replacement always supersedes its original, even if the
 *   separate `markOutboxSuperseded` call crashed;
 * - one original never has two live replacements (the lowest `sendOrder` wins);
 * - a failed session is reported complete only when every replacement that
 *   belongs to it is `sent`/`superseded`.
 *
 * Only downgrades to `superseded` are ever applied; nothing is resurrected.
 */
export async function reconcileOutbox(
  storage: E2eeStorage,
  kStorage: KStorage,
  options: { readonly chatId?: string; readonly now?: number } = {},
): Promise<OutboxReconcileResult> {
  const now = options.now ?? Date.now();
  const entries = (await listOutboxEntries(storage, kStorage)).filter(
    (entry) => options.chatId === undefined || entry.chatId === options.chatId,
  );
  const byId = new Map(entries.map((entry) => [entry.clientMessageId, entry]));
  const replacements = new Map<string, OutboxEntry[]>();
  for (const entry of entries) {
    const originalId = entry.retryOfClientMessageId;
    if (originalId === null) continue;
    const group = replacements.get(originalId) ?? [];
    group.push(entry);
    replacements.set(originalId, group);
  }

  const plan = new Set<string>();
  for (const [originalId, group] of replacements) {
    const live = group.filter((entry) => entry.status !== 'superseded');
    const sent = live.find((entry) => entry.status === 'sent');
    const winner =
      sent ??
      [...live].sort(
        (a, b) => a.sendOrder - b.sendOrder || a.clientMessageId.localeCompare(b.clientMessageId),
      )[0];
    for (const row of live) {
      if (winner !== undefined && row.clientMessageId !== winner.clientMessageId) {
        plan.add(row.clientMessageId);
      }
    }
    const original = byId.get(originalId);
    if (original !== undefined && original.supersededAt === null) {
      plan.add(original.clientMessageId);
    }
  }

  const superseded: string[] = [];
  if (plan.size > 0) {
    await storage.transact(['outbox', 'localMessages'], 'readwrite', async (transaction) => {
      for (const clientMessageId of plan) {
        const stored = await transaction.get<StoredOutboxEntry>(
          'outbox',
          outboxStorageKey(clientMessageId),
        );
        if (stored === null) continue;
        if (stored.status === 'superseded' || (stored.supersededAt ?? null) !== null) {
          continue;
        }
        const next: StoredOutboxEntry =
          stored.status === 'sent'
            ? { ...stored, supersededAt: now, nextAttemptAt: null, updatedAt: now }
            : {
                ...stored,
                status: 'superseded',
                supersededAt: now,
                nextAttemptAt: null,
                updatedAt: now,
              };
        await transaction.put<StoredOutboxEntry>('outbox', outboxStorageKey(clientMessageId), next);
        await updateLocalCopyStatus(transaction, stored, 'superseded', now);
        superseded.push(clientMessageId);
      }
    });
  }

  const completedFailedSessionIds: string[] = [];
  for (const entry of entries) {
    if (entry.retryOfClientMessageId !== null) continue;
    const originalId = entry.clientMessageId;
    const group = replacements.get(originalId);
    if (group === undefined || group.length === 0) continue;
    const active = group.some(
      (replacement) => replacement.status === 'pending' || replacement.status === 'failed',
    );
    if (active) continue;
    // The original itself may belong to multiple sessions (fan-out); report the
    // failed session only when the caller can match it (see resolve below).
    for (const envelope of entry.envelopes) {
      if (!completedFailedSessionIds.includes(envelope.session_id)) {
        completedFailedSessionIds.push(envelope.session_id);
      }
    }
  }
  return { superseded, completedFailedSessionIds };
}

export async function readLocalMessageCopy(
  storage: E2eeStorage,
  kStorage: KStorage,
  parts: LocalCopyKeyParts,
): Promise<LocalMessageCopy | null> {
  const key = localCopyStorageKey(parts);
  const stored = await storage.get<StoredLocalMessageCopy>('localMessages', key);
  if (stored === null) return null;
  return decryptLocalCopy(kStorage, stored);
}

/**
 * Resolves the *sender's own* copy of an outgoing message. The lookup can only
 * hit the `outgoing`/local-device namespace; an incoming copy that happens to
 * carry the same peer-controlled `client_message_id` is never returned (P1-02).
 */
export async function lookupLocalCopy(
  storage: E2eeStorage,
  kStorage: KStorage,
  chatId: string,
  clientMessageId: string,
): Promise<LocalCopyLookup> {
  requireUuid(chatId, 'chat_id');
  requireUuid(clientMessageId, 'client_message_id');
  const parts: LocalCopyKeyParts = {
    chatId,
    direction: 'outgoing',
    senderDeviceId: kStorage.ownerDeviceId,
    clientMessageId,
    localMessageId: clientMessageId,
  };
  const stored = await storage.get<StoredLocalMessageCopy>(
    'localMessages',
    localCopyStorageKey(parts),
  );
  if (stored === null) return { available: false, clientMessageId };
  if (
    stored.chatId !== chatId ||
    stored.clientMessageId !== clientMessageId ||
    stored.direction !== 'outgoing' ||
    stored.senderDeviceId !== kStorage.ownerDeviceId
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'outgoing local copy scope was tampered with');
  }
  return { available: true, copy: await decryptLocalCopy(kStorage, stored) };
}

/**
 * Resolves a *received* message's sealed local copy by
 * `(chat, sender device, client_message_id)`. Incoming copies live in their own
 * `incoming`/sender namespace, so a peer-controlled id can never resolve to the
 * local sender's outgoing copy (P1-02). This is what makes already decrypted
 * messages readable after a page reload: re-running the ratchet on history
 * would only return DUPLICATE_OR_OLD_MESSAGE.
 */
export async function lookupIncomingLocalCopy(
  storage: E2eeStorage,
  kStorage: KStorage,
  chatId: string,
  senderDeviceId: string,
  clientMessageId: string,
  expectedServerMessageId: string | null = null,
): Promise<LocalCopyLookup> {
  requireUuid(chatId, 'chat_id');
  requireUuid(senderDeviceId, 'sender_device_id');
  requireUuid(clientMessageId, 'client_message_id');
  if (expectedServerMessageId !== null) {
    requireUuid(expectedServerMessageId, 'server_message_id');
  }
  const parts: LocalCopyKeyParts = {
    chatId,
    direction: 'incoming',
    senderDeviceId,
    clientMessageId,
    // The key uses the `c:` segment when a client id is present; the local id is
    // only a required validation field for this lookup, never part of the key.
    localMessageId: clientMessageId,
  };
  const stored = await storage.get<StoredLocalMessageCopy>(
    'localMessages',
    localCopyStorageKey(parts),
  );
  if (stored === null) return { available: false, clientMessageId };
  if (
    stored.chatId !== chatId ||
    stored.clientMessageId !== clientMessageId ||
    stored.direction !== 'incoming' ||
    stored.senderDeviceId !== senderDeviceId
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'incoming local copy scope was tampered with');
  }
  const copy = await decryptLocalCopy(kStorage, stored);
  // P2-04: a malicious/buggy server may replay an old `client_message_id` under
  // a new `message.id`. When both ids are known, the copy must belong to this
  // exact server row; otherwise it is not a reload of the same message.
  // Copies written before `serverMessageId` was persisted keep legacy behaviour.
  if (
    expectedServerMessageId !== null &&
    copy.serverMessageId !== null &&
    copy.serverMessageId !== expectedServerMessageId
  ) {
    return { available: false, clientMessageId };
  }
  return { available: true, copy };
}

async function decryptLocalCopy(
  kStorage: KStorage,
  stored: StoredLocalMessageCopy,
): Promise<LocalMessageCopy> {
  if (stored.v !== 1) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy version is unsupported');
  }
  requireUuid(stored.chatId, 'chat_id');
  requireSessionId(stored.sessionId);
  requireUuid(stored.localMessageId, 'local_message_id');
  requireUuid(stored.senderDeviceId, 'sender_device_id');
  requireUuidOrNull(stored.clientMessageId, 'client_message_id');
  requireTimestamp(stored.createdAt, 'createdAt');
  requireTimestamp(stored.updatedAt, 'updatedAt');
  if (stored.direction !== 'outgoing' && stored.direction !== 'incoming') {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'unknown local copy direction');
  }
  if (
    stored.key !==
    localCopyStorageKey({
      chatId: stored.chatId,
      direction: stored.direction,
      senderDeviceId: stored.senderDeviceId,
      clientMessageId: stored.clientMessageId,
      localMessageId: stored.localMessageId,
    })
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy key does not match its ids');
  }
  const plaintext = await decryptRecord(kStorage, stored.content, {
    sessionId: stored.sessionId,
    clientMessageId: stored.clientMessageId,
    recordType: 'localCopy',
  });
  let payload: LocalCopyPayloadV1;
  try {
    payload = parseLocalCopyPayload(plaintext);
  } finally {
    zeroBytes(plaintext);
  }
  if (
    payload.chatId !== stored.chatId ||
    payload.sessionId !== stored.sessionId ||
    payload.senderDeviceId !== stored.senderDeviceId ||
    payload.localMessageId !== stored.localMessageId ||
    payload.clientMessageId !== stored.clientMessageId ||
    payload.direction !== stored.direction
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy metadata was tampered with');
  }
  return {
    localMessageId: stored.localMessageId,
    clientMessageId: stored.clientMessageId,
    chatId: stored.chatId,
    sessionId: stored.sessionId,
    senderDeviceId: stored.senderDeviceId,
    status: requireLocalCopyStatus(stored.status),
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    direction: payload.direction,
    contentType: payload.contentType,
    text: payload.text,
    ciphertexts: payload.ciphertexts,
    replyToId: payload.replyToId,
    serverMessageId: payload.serverMessageId,
  };
}

function parseLocalCopyPayload(bytes: Uint8Array): LocalCopyPayloadV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy payload is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy payload is malformed');
  }
  const candidate = parsed as Partial<LocalCopyPayloadV1>;
  if (
    candidate.v !== STORED_VERSION ||
    typeof candidate.chatId !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.senderDeviceId !== 'string' ||
    typeof candidate.localMessageId !== 'string' ||
    (candidate.clientMessageId !== null && typeof candidate.clientMessageId !== 'string') ||
    (candidate.direction !== 'outgoing' && candidate.direction !== 'incoming') ||
    (candidate.contentType !== 1 && candidate.contentType !== 2) ||
    (candidate.text !== null && typeof candidate.text !== 'string') ||
    !Array.isArray(candidate.ciphertexts) ||
    (candidate.replyToId !== null && typeof candidate.replyToId !== 'string') ||
    typeof candidate.createdAt !== 'number' ||
    (candidate.serverMessageId !== null && typeof candidate.serverMessageId !== 'string')
  ) {
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'local copy payload is malformed');
  }
  requireUuid(candidate.chatId, 'chat_id');
  requireSessionId(candidate.sessionId);
  requireUuid(candidate.senderDeviceId, 'sender_device_id');
  requireUuid(candidate.localMessageId, 'local_message_id');
  requireUuidOrNull(candidate.clientMessageId, 'client_message_id');
  requireUuidOrNull(candidate.replyToId ?? null, 'reply_to_id');
  requireUuidOrNull(candidate.serverMessageId ?? null, 'server_message_id');
  return {
    v: 1,
    chatId: candidate.chatId,
    sessionId: candidate.sessionId,
    senderDeviceId: candidate.senderDeviceId,
    clientMessageId: candidate.clientMessageId,
    localMessageId: candidate.localMessageId,
    direction: candidate.direction,
    contentType: candidate.contentType,
    text: validateText(candidate.text, candidate.contentType),
    ciphertexts: candidate.ciphertexts.map(validateCiphertext),
    replyToId: candidate.replyToId,
    createdAt: requireTimestamp(candidate.createdAt, 'createdAt'),
    serverMessageId: candidate.serverMessageId,
  };
}

export interface OutboxErrorInfo {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
}

export interface OutboxDrainOptions {
  readonly now?: number;
  readonly chatId?: string;
  /** Manual "retry now": ignore the persisted backoff deadline. */
  readonly force?: boolean;
  /** Upper bound for one pass; the next scheduled pass continues. */
  readonly maxPerDrain?: number;
  readonly classifyError?: (error: unknown) => OutboxErrorInfo;
  /**
   * Ambiguous-POST resolver: called for rows that already have attempts when
   * the previous response may have been lost. Returning a result marks the row
   * sent without a second POST; `null` falls back to the idempotent replay.
   */
  readonly lookup?: (entry: OutboxEntry) => Promise<OutboxSendResult | null>;
}

export const DEFAULT_DRAIN_BATCH = 20;

function errorCodeOf(error: unknown): string {
  if (isE2eeError(error)) return error.code;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'NETWORK';
}

function classifyOutboxError(
  error: unknown,
  classify?: OutboxDrainOptions['classifyError'],
): OutboxErrorInfo {
  if (classify !== undefined) {
    try {
      return classify(error);
    } catch {
      // Fall through to the structural default.
    }
  }
  const code = errorCodeOf(error);
  return { code, retryable: isRetryableOutboxCode(code) };
}

/**
 * Outbox worker core (no network of its own): every due entry is processed
 * under `krug-outbox`, re-read inside the lock, and sent with its stored bytes.
 *
 * G4e #30 durable retry:
 * - `pending` and retryable `failed` rows are both picked up;
 * - the persisted `nextAttemptAt` implements exponential backoff across reloads;
 * - an ambiguous POST is first resolved through `lookup` (server row by
 *   `client_message_id`), then by replaying the very same `Idempotency-Key`;
 * - a confirmed replacement supersedes its original in the same transaction.
 *
 * A crash after `send` but before `markOutboxSent` leaves the row pending; the
 * next drain replays the same idempotency key, which the server deduplicates.
 */
export async function drainOutbox(
  storage: E2eeStorage,
  kStorage: KStorage,
  locks: E2eeLockManager,
  send: (entry: OutboxEntry) => Promise<OutboxSendResult>,
  options: OutboxDrainOptions = {},
): Promise<OutboxDrainResult> {
  const now = options.now ?? Date.now();
  return locks.withLock(OUTBOX_LOCK, async (fence) => {
    const sent: string[] = [];
    const failed: Array<{ clientMessageId: string; code: string }> = [];
    const candidates = await listDrainCandidates(storage, kStorage, {
      now,
      chatId: options.chatId,
      force: options.force,
    });
    const max = Math.max(1, options.maxPerDrain ?? DEFAULT_DRAIN_BATCH);
    let skipped = Math.max(0, candidates.length - max);
    for (const candidate of candidates.slice(0, max)) {
      // The fallback lease is not a security boundary: if it was lost while we
      // were waiting, do not mutate the outbox at all (P1-06).
      fence.assertValid();
      const current = await readOutboxEntry(storage, kStorage, candidate.clientMessageId);
      if (!current || current.status === 'sent' || current.status === 'superseded') continue;
      if (current.nextAttemptAt !== null && !options.force && current.nextAttemptAt > now) {
        skipped += 1;
        continue;
      }
      // Ambiguous previous POST: resolve it through the server before replaying.
      if (current.attempts > 0 && options.lookup !== undefined) {
        let existing: OutboxSendResult | null = null;
        try {
          existing = await options.lookup(current);
        } catch {
          // A failed lookup must not block the idempotent replay below.
          existing = null;
        }
        if (existing !== null) {
          fence.assertValid();
          await markOutboxSent(storage, current.clientMessageId, existing, { now });
          sent.push(current.clientMessageId);
          continue;
        }
      }
      try {
        await markOutboxAttempt(storage, current.clientMessageId, { now });
      } catch {
        // Lost a cross-tab race or became terminal: never send it now.
        continue;
      }
      let result: OutboxSendResult;
      try {
        result = await send(current);
      } catch (error) {
        fence.assertValid();
        const info = classifyOutboxError(error, options.classifyError);
        await markOutboxFailed(storage, current.clientMessageId, info.code, {
          now,
          retryable: info.retryable,
          retryAfterMs: info.retryAfterMs,
        });
        failed.push({ clientMessageId: current.clientMessageId, code: info.code });
        continue;
      }
      fence.assertValid();
      await markOutboxSent(storage, current.clientMessageId, result, { now });
      sent.push(current.clientMessageId);
    }
    const statuses = await outboxRetryStatus(storage, kStorage, {
      now,
      chatId: options.chatId,
    });
    const nextAttemptAt = statuses.reduce<number | null>((next, status) => {
      if (status.pending === 0 || status.nextAttemptAt === null) return next;
      return next === null ? status.nextAttemptAt : Math.min(next, status.nextAttemptAt);
    }, null);
    return { sent, failed, nextAttemptAt, skipped };
  });
}

/** Test/dev helper: list local copy keys without decrypting message text. */
export async function listLocalCopyKeys(storage: E2eeStorage): Promise<string[]> {
  const keys = await storage.keys('localMessages');
  return keys.filter((key) => key.startsWith(LOCAL_COPY_PREFIX)).sort();
}

/** Test/dev helper: canonical b64u of a raw ciphertext, used to build drafts. */
export function encodeCiphertext(bytes: Uint8Array): string {
  return encodeBase64Url(bytes);
}

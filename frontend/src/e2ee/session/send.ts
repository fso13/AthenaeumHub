/**
 * E2EE send orchestration (§3.3.2, §3.4.3, §3.4.6, §5.2, §5.7).
 *
 * One plaintext is encrypted once per recipient device (peer devices + the
 * sender's *other* devices; there is no self-envelope). A new session is
 * established lazily through a claimed prekey bundle; an existing session is
 * reused after its peer keys and TOFU pin are re-checked.
 *
 * Persistence order is the §3.4.6 invariant: `prepareE2eeSend` only computes
 * ciphertext and the shifted chains, `commitE2eeSend` writes **all** shifted
 * sessions + the exact envelope bytes + `Idempotency-Key` + `client_message_id`
 * + the sealed local copy in a single transaction. Nothing may be displayed or
 * sent before that commit resolves.
 */
import { MAX_ENVELOPES_PER_MESSAGE } from '../constants';
import { E2eeError, isE2eeError } from '../errors';
import { areBytesEqual, isUuid, uuidToBytes, zeros } from '../encoding/bytes';
import { decodeBase64Url } from '../encoding/base64url';
import { sha256 } from '../crypto/digest';
import { buildAd } from '../protocol/ad';
import {
  buildInnerPayload,
  CONTENT_TYPE_SESSION_RESET,
  CONTENT_TYPE_TEXT_JSON,
  serializeTextBody,
  validateText,
} from '../protocol/payload';
import { encodeEnvelope, type ParsedEnvelope, type ParsedPrekeyBlock } from '../protocol/envelope';
import type { WireCryptoEnvelope } from '../api/deviceKeys';
import { randomUuid } from '../device/identity';
import { assertDeviceNotBlocked, checkBundlePin, readPin } from '../device/pins';
import type {
  LoadedDeviceIdentity,
  VerifiedClaimedBundle,
  VerifiedDeviceIdentity,
} from '../device/types';
import type { E2eeStorage } from '../storage/types';
import type { KStorage } from '../storage/kStorage';
import {
  commitOutgoingMessage,
  prepareOutgoingMessage,
  type AdditionalSessionWrite,
  type PreparedOutgoingMessage,
} from '../outbox/outboxStore';
import { listSessionsByPeer, type SessionWriteMode } from './sessionStore';
import { createInitiatorSession, localIdentityKeys, type LocalIdentityKeys } from './handshake';
import { ratchetSend } from './ratchet';
import { deterministicWinner } from './parallel';
import { serializeSessionResetBody, type SessionResetBody } from './reset';
import { assertSessionMatchesIdentity, assertVerifiedIdentity, pinMatchesIdentity } from './trust';
import type { SessionState } from './types';
import type { LockFence } from '../locks/locks';

/** A peer/self device the caller resolved from claim / `GET /chats/{id}/keys`. */
export interface E2eeRecipientPlan {
  /** Verified identity (binding checked) used for TOFU and the envelope ids. */
  readonly identity: VerifiedDeviceIdentity;
  /** Claim bundle; required when no session exists or `freshPrekey` is set. */
  readonly bundle?: VerifiedClaimedBundle | null;
  /** Force a new prekey session (R-15 reset or explicit re-key). */
  readonly freshPrekey?: boolean;
  /**
   * Exact persisted session to use for this recipient (E7-F5G P2-30). When set,
   * selection never falls back to another live session.
   */
  readonly sessionId?: string;
  /** Own other device: no TOFU pin is required (F3 never pins self devices). */
  readonly isSelfDevice?: boolean;
}

export type E2eeSendBody =
  | { readonly type: 'TEXT_JSON'; readonly text: string; readonly replyToId?: string | null }
  | { readonly type: 'SESSION_RESET'; readonly reset: SessionResetBody };

export interface E2eeSendInput {
  readonly chatId: string;
  readonly body: E2eeSendBody;
  readonly recipients: readonly E2eeRecipientPlan[];
  /** Expected peer/self capable devices; used for honest coverage counters. */
  readonly expectedPeerDeviceIds?: readonly string[];
  readonly expectedSelfDeviceIds?: readonly string[];
  readonly clientMessageId?: string;
  readonly localMessageId?: string;
  readonly idempotencyKey?: string;
  readonly retryOfClientMessageId?: string | null;
  /** Sessions that are broken/reset and must not be selected (E7-F5G P2-30). */
  readonly excludeSessionIds?: readonly string[];
  readonly createdAt?: number;
}

export interface E2eeCoverage {
  readonly devices: number;
  readonly covered: number;
  readonly peerDevices: number;
  readonly peerCovered: number;
  readonly selfDevices: number;
  readonly selfCovered: number;
  readonly uncoveredDeviceIds: readonly string[];
}

export type E2eeCoverageWarning = 'PEER_DEVICE_UNCOVERED' | 'SELF_DEVICE_UNCOVERED' | null;

export interface E2eeSendContext {
  readonly storage: E2eeStorage;
  readonly kStorage: KStorage;
  readonly identity: LoadedDeviceIdentity;
  readonly now?: number;
}

export interface PreparedE2eeSend {
  readonly prepared: PreparedOutgoingMessage;
  readonly primaryMode: SessionWriteMode;
  readonly chatId: string;
  readonly sessionId: string;
  readonly type: 'TEXT_JSON' | 'SESSION_RESET';
  readonly text: string | null;
  readonly clientMessageId: string;
  readonly localMessageId: string;
  readonly idempotencyKey: string;
  readonly envelopes: readonly WireCryptoEnvelope[];
  readonly recipientDeviceIds: readonly string[];
  readonly coverage: E2eeCoverage;
  readonly coverageWarning: E2eeCoverageWarning;
  readonly otpExhausted: boolean;
  readonly createdAt: number;
}

export interface CommittedE2eeSend {
  readonly clientMessageId: string;
  readonly localMessageId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly session: SessionState;
  readonly envelopes: readonly WireCryptoEnvelope[];
  readonly coverage: E2eeCoverage;
  readonly coverageWarning: E2eeCoverageWarning;
  readonly otpExhausted: boolean;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('INVALID_ENVELOPE_FORMAT', `${label} must be a canonical UUID`);
  }
  return value;
}

/**
 * §5.7 session pick. A simultaneous-initiation pair has a deterministic winner
 * (the lower canonical `session_id`, identical on both devices), so sends
 * converge even before the first receive. A superseded loser is never selected.
 * Otherwise: the session from which the last message was successfully received;
 * then a locally initiated session; then the lowest id.
 */
export function selectSendingSession(sessions: readonly SessionState[]): SessionState | null {
  if (sessions.length === 0) return null;
  const live = sessions.filter(
    (session) => session.supersededBy === null || session.supersededBy === undefined,
  );
  const pool = live.length > 0 ? live : [...sessions];
  const winner = deterministicWinner(pool);
  if (winner !== null) return winner;
  const byId = [...pool].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
  const received = byId.filter(
    (session) => session.lastReceivedAt !== null && session.lastReceivedAt !== undefined,
  );
  if (received.length > 0) {
    return received.reduce((best, candidate) =>
      (candidate.lastReceivedAt as number) > (best.lastReceivedAt as number) ? candidate : best,
    );
  }
  const local = byId.filter((session) => session.initiatedBy !== 'peer');
  return local[0] ?? byId[0] ?? null;
}

interface ResolvedRecipient {
  readonly identity: VerifiedDeviceIdentity;
  readonly isSelfDevice: boolean;
  readonly session: SessionState;
  /** Persisted state before this send step (E7-F5G P2-36); null for a create. */
  readonly previousState: SessionState | null;
  readonly mode: SessionWriteMode;
  readonly prekey: ParsedPrekeyBlock | null;
  readonly preamble: Uint8Array | null;
  readonly otpExhausted: boolean;
}

interface RecipientContext {
  readonly ownIdentity: LocalIdentityKeys;
  readonly chatId: string;
  readonly now: number;
  readonly storage: E2eeStorage;
  readonly kStorage: KStorage;
  readonly excludeSessionIds: ReadonlySet<string>;
}

async function resolveRecipient(
  context: RecipientContext,
  plan: E2eeRecipientPlan,
): Promise<ResolvedRecipient> {
  const identity = plan.identity;
  const deviceId = requireUuid(identity.deviceId, 'recipient.device_id');
  const userId = requireUuid(identity.userId, 'recipient.user_id');
  if (deviceId === context.ownIdentity.deviceId) {
    throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'self-envelopes are forbidden');
  }
  const isSelfDevice = plan.isSelfDevice ?? userId === context.ownIdentity.userId;
  await assertVerifiedIdentity(identity);
  await assertDeviceNotBlocked(context.storage, userId, deviceId);

  const allSessions = await listSessionsByPeer(
    context.storage,
    context.kStorage,
    context.chatId,
    deviceId,
  );
  const excluded = context.excludeSessionIds;
  // §5.7: a superseded loser keeps its keys for in-flight receives but is never
  // a send target, and an explicit retry id for it is rejected.
  const sessions = allSessions.filter(
    (session) =>
      !excluded.has(session.sessionId) &&
      (session.supersededBy === null || session.supersededBy === undefined),
  );
  let selected: SessionState | null = null;
  if (plan.freshPrekey !== true) {
    if (plan.sessionId !== undefined) {
      selected = sessions.find((session) => session.sessionId === plan.sessionId) ?? null;
      if (selected === null) {
        throw new E2eeError('NO_SESSION', 'the requested retry session is no longer available');
      }
    } else {
      selected = selectSendingSession(sessions);
    }
  }
  let prekey: ParsedPrekeyBlock | null = null;
  let preamble: Uint8Array | null = null;
  let otpExhausted = false;

  if (selected === null) {
    const bundle = plan.bundle ?? null;
    if (bundle === null) {
      throw new E2eeError('NO_SESSION', 'no session and no claim bundle for a recipient device');
    }
    if (
      bundle.deviceId !== deviceId ||
      bundle.userId !== userId ||
      bundle.keyGeneration !== identity.keyGeneration ||
      !areBytesEqual(bundle.identity.identitySigningKey, identity.identitySigningKey) ||
      !areBytesEqual(bundle.identity.identityDhKey, identity.identityDhKey)
    ) {
      throw new E2eeError('KEY_HANDSHAKE_INVALID', 'bundle does not match the recipient identity');
    }
    const pinCheck = await checkBundlePin(context.storage, bundle, { now: context.now });
    if (pinCheck.status === 'key_change') {
      throw new E2eeError(
        'KEY_CHANGE_DETECTED',
        'recipient identity changed; confirmation is required before sending',
      );
    }
    const created = await createInitiatorSession({
      identity: context.ownIdentity,
      chatId: context.chatId,
      bundle,
      now: context.now,
    });
    selected = created.session;
    prekey = created.prekey;
    preamble = created.preamble;
    otpExhausted = created.otpExhausted;
  } else {
    assertSessionMatchesIdentity(selected, identity, context.chatId);
    const pin = await readPin(context.storage, userId, deviceId);
    if (pin === null) {
      if (!isSelfDevice) {
        throw new E2eeError(
          'KEY_HANDSHAKE_INVALID',
          'existing session has no TOFU pin; refusing to send',
        );
      }
    } else if (!pinMatchesIdentity(pin, identity)) {
      throw new E2eeError(
        'KEY_CHANGE_DETECTED',
        'recipient identity changed since the session was pinned',
      );
    }
    if (plan.bundle) {
      const pinCheck = await checkBundlePin(context.storage, plan.bundle, { now: context.now });
      if (pinCheck.status === 'key_change') {
        throw new E2eeError('KEY_CHANGE_DETECTED', 'recipient identity changed');
      }
    }
  }

  const mode: SessionWriteMode =
    selected.revision === 0 ? { create: true } : { ifRevision: selected.revision };
  return {
    identity,
    isSelfDevice,
    session: selected,
    previousState: selected.revision > 0 ? selected : null,
    mode,
    prekey,
    preamble,
    otpExhausted,
  };
}

function buildSendPayload(body: E2eeSendBody): {
  payload: Uint8Array;
  contentType: 1 | 2;
  text: string | null;
} {
  if (body.type === 'TEXT_JSON') {
    const text = validateText(body.text);
    const replyToId = body.replyToId ?? null;
    const frame = buildInnerPayload(CONTENT_TYPE_TEXT_JSON, serializeTextBody({ text, replyToId }));
    return { payload: frame, contentType: CONTENT_TYPE_TEXT_JSON, text };
  }
  const frame = buildInnerPayload(
    CONTENT_TYPE_SESSION_RESET,
    serializeSessionResetBody(body.reset),
  );
  return { payload: frame, contentType: CONTENT_TYPE_SESSION_RESET, text: null };
}

function computeCoverage(
  input: E2eeSendInput,
  ownDeviceId: string,
  planned: ReadonlyMap<string, boolean>,
  coveredIds: ReadonlySet<string>,
): E2eeCoverage {
  const plannedIds = [...planned.keys()];
  const peerDevices = input.expectedPeerDeviceIds
    ? [...new Set(input.expectedPeerDeviceIds)]
    : plannedIds.filter((deviceId) => planned.get(deviceId) !== true);
  const selfDevices = input.expectedSelfDeviceIds
    ? [...new Set(input.expectedSelfDeviceIds)].filter((deviceId) => deviceId !== ownDeviceId)
    : plannedIds.filter((deviceId) => planned.get(deviceId) === true);
  const peerCovered = peerDevices.filter((deviceId) => coveredIds.has(deviceId)).length;
  const selfCovered = selfDevices.filter((deviceId) => coveredIds.has(deviceId)).length;
  const uncovered = [
    ...peerDevices.filter((id) => !coveredIds.has(id)),
    ...selfDevices.filter((id) => !coveredIds.has(id)),
  ];
  if (peerDevices.length === 0) {
    throw new E2eeError('PEER_UNCOVERED', 'no peer device candidates for this E2EE send');
  }
  return {
    devices: peerDevices.length + selfDevices.length,
    covered: peerCovered + selfCovered,
    peerDevices: peerDevices.length,
    peerCovered,
    selfDevices: selfDevices.length,
    selfCovered,
    uncoveredDeviceIds: uncovered,
  };
}

/**
 * Encrypts one message for every planned device and prepares the atomic commit.
 * Throws before touching storage when a peer cannot be covered (client pre-check,
 * §4.2) or any recipient fails its TOFU/key checks.
 */
export async function prepareE2eeSend(
  context: E2eeSendContext,
  input: E2eeSendInput,
): Promise<PreparedE2eeSend> {
  const chatId = requireUuid(input.chatId, 'chat_id');
  const ownIdentity = localIdentityKeys(context.identity);
  const now = input.createdAt ?? context.now ?? Date.now();
  const ownDeviceId = ownIdentity.deviceId;

  const plans = new Map<string, E2eeRecipientPlan>();
  for (const plan of input.recipients) {
    const deviceId = requireUuid(plan.identity.deviceId, 'recipient.device_id');
    if (deviceId === ownDeviceId) {
      throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'self-envelopes are forbidden');
    }
    if (plans.has(deviceId)) {
      throw new E2eeError('INVALID_ENVELOPE_FORMAT', 'duplicate recipient device');
    }
    plans.set(deviceId, plan);
  }
  if (plans.size > MAX_ENVELOPES_PER_MESSAGE) {
    throw new E2eeError(
      'INVALID_ENVELOPE_FORMAT',
      `at most ${MAX_ENVELOPES_PER_MESSAGE} envelopes are allowed`,
    );
  }

  const { payload, contentType, text } = buildSendPayload(input.body);
  const recipientContext: RecipientContext = {
    ownIdentity,
    chatId,
    now,
    storage: context.storage,
    kStorage: context.kStorage,
    excludeSessionIds: new Set(input.excludeSessionIds ?? []),
  };

  const sessions: Array<{
    state: SessionState;
    mode: SessionWriteMode;
    previous: SessionState | null;
  }> = [];
  const envelopes: WireCryptoEnvelope[] = [];
  const coveredIds = new Set<string>();
  let otpExhausted = false;

  for (const [deviceId, plan] of plans) {
    const resolved = await resolveRecipient(recipientContext, plan);
    const sessionId = decodeBase64Url(resolved.session.sessionId, 16);
    const preambleHash = resolved.preamble ? await sha256(resolved.preamble) : zeros(32);
    const step = await ratchetSend(resolved.session, {
      plaintext: payload,
      now,
      buildAd: (header) =>
        buildAd({
          chatId: uuidToBytes(chatId),
          senderDeviceId: uuidToBytes(ownDeviceId),
          senderKeyGeneration: ownIdentity.keyGeneration,
          recipientDeviceId: uuidToBytes(deviceId),
          recipientKeyGeneration: resolved.identity.keyGeneration,
          sessionId,
          prekey: resolved.preamble !== null,
          preambleHash,
          header,
        }),
    });
    const envelope: ParsedEnvelope = {
      v: 1,
      scheme: 'PAIRWISE_X3DH_DR',
      chatId,
      senderDeviceId: ownDeviceId,
      senderKeyGeneration: ownIdentity.keyGeneration,
      recipientDeviceId: deviceId,
      recipientKeyGeneration: resolved.identity.keyGeneration,
      sessionId,
      header: step.header,
      ciphertext: step.ciphertext,
      prekey: resolved.prekey,
    };
    envelopes.push(encodeEnvelope(envelope));
    sessions.push({ state: step.state, mode: resolved.mode, previous: resolved.previousState });
    coveredIds.add(deviceId);
    otpExhausted = otpExhausted || resolved.otpExhausted;
  }

  const plannedSelf = new Map<string, boolean>();
  for (const [deviceId, plan] of plans) {
    plannedSelf.set(deviceId, plan.isSelfDevice ?? plan.identity.userId === ownIdentity.userId);
  }
  const coverage = computeCoverage(input, ownDeviceId, plannedSelf, coveredIds);
  if (coverage.peerCovered === 0) {
    throw new E2eeError('PEER_UNCOVERED', 'no peer device received an envelope');
  }
  const coverageWarning: E2eeCoverageWarning =
    coverage.peerCovered < coverage.peerDevices
      ? 'PEER_DEVICE_UNCOVERED'
      : coverage.selfCovered < coverage.selfDevices
        ? 'SELF_DEVICE_UNCOVERED'
        : null;

  const primary =
    sessions.find((entry) => plannedSelf.get(entry.state.peerDeviceId) === false) ?? sessions[0];
  if (!primary) {
    throw new E2eeError('PEER_UNCOVERED', 'no envelope was produced');
  }
  const additional: AdditionalSessionWrite[] = sessions
    .filter((entry) => entry.state.sessionId !== primary.state.sessionId)
    .map((entry) => ({
      state: entry.state,
      mode: entry.mode,
      previousState: entry.previous,
    }));

  const clientMessageId = requireUuid(input.clientMessageId ?? randomUuid(), 'client_message_id');
  const localMessageId = requireUuid(input.localMessageId ?? randomUuid(), 'local_message_id');
  const idempotencyKey = requireUuid(input.idempotencyKey ?? randomUuid(), 'idempotency_key');
  const type = input.body.type === 'SESSION_RESET' ? 'SESSION_RESET' : 'TEXT_JSON';

  const prepared = await prepareOutgoingMessage(context.kStorage, {
    chatId,
    sessionId: primary.state.sessionId,
    clientMessageId,
    localMessageId,
    type,
    idempotencyKey,
    envelopes,
    retryOfClientMessageId: input.retryOfClientMessageId ?? null,
    sessionState: primary.state,
    previousSessionState: primary.previous,
    additionalSessionStates: additional,
    text: contentType === CONTENT_TYPE_TEXT_JSON ? text : null,
    createdAt: now,
  });

  return {
    prepared,
    primaryMode: primary.mode,
    chatId,
    sessionId: primary.state.sessionId,
    type,
    text,
    clientMessageId,
    localMessageId,
    idempotencyKey,
    envelopes,
    recipientDeviceIds: envelopes.map((envelope) => envelope.recipient_device_id),
    coverage,
    coverageWarning,
    otpExhausted,
    createdAt: now,
  };
}

/**
 * Atomic commit of the shifted sessions + outbox row + local copy. May only be
 * followed by the network call with exactly these envelope bytes.
 */
export async function commitE2eeSend(
  storage: E2eeStorage,
  prepared: PreparedE2eeSend,
  options: { readonly fence?: LockFence } = {},
): Promise<CommittedE2eeSend> {
  options.fence?.assertValid();
  let session: SessionState;
  try {
    session = await commitOutgoingMessage(storage, prepared.prepared, prepared.primaryMode);
  } catch (error) {
    if (isE2eeError(error)) throw error;
    throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'E2EE send could not be committed');
  }
  return {
    clientMessageId: prepared.clientMessageId,
    localMessageId: prepared.localMessageId,
    idempotencyKey: prepared.idempotencyKey,
    sessionId: prepared.sessionId,
    session,
    envelopes: prepared.envelopes,
    coverage: prepared.coverage,
    coverageWarning: prepared.coverageWarning,
    otpExhausted: prepared.otpExhausted,
  };
}

/** Convenience pipeline for F5: prepare + commit (still no network here). */
export async function sendE2eeMessage(
  context: E2eeSendContext,
  input: E2eeSendInput,
  options: { readonly fence?: LockFence } = {},
): Promise<CommittedE2eeSend> {
  const prepared = await prepareE2eeSend(context, input);
  return commitE2eeSend(context.storage, prepared, options);
}

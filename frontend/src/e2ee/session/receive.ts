/**
 * E2EE receive/decrypt orchestration (§3.3.3, §3.4.4, §3.4.6, §5.5).
 *
 * A prekey envelope for an unknown session establishes the responder session
 * after the full §3.3.1 checklist; a normal envelope requires an existing
 * session. Decryption happens on a **candidate** state: a failed AEAD, replay or
 * TOFU mismatch leaves storage untouched (no session, no OPK consumption, no
 * visible message). Only a successful decrypt reaches the atomic commit.
 *
 * Nothing here logs plaintext, keys or ciphertext.
 */
import { E2eeError } from '../errors';
import { areBytesEqual, isUuid, uuidToBytes, zeros } from '../encoding/bytes';
import { encodeBase64Url } from '../encoding/base64url';
import { sha256 } from '../crypto/digest';
import { buildAd } from '../protocol/ad';
import { buildEnvelopePreamble, isPrekeyEnvelope, type ParsedEnvelope } from '../protocol/envelope';
import { parseInnerPayload, parseTextBody, type ContentType } from '../protocol/payload';
import { parseWireEnvelope, type WireCryptoEnvelope } from '../api/deviceKeys';
import { verifyPreambleSignature } from '../protocol/preamble';
import { verifyPrekeySenderIdentity } from '../device/binding';
import { assertDeviceNotBlocked, checkVerifiedIdentityPin, readPin } from '../device/pins';
import { randomUuid } from '../device/identity';
import { getOneTimePrekey, getSignedPrekey } from '../session/prekeyStore';
import type { E2eeStorage } from '../storage/types';
import type { KStorage } from '../storage/kStorage';
import type { LoadedDeviceIdentity, VerifiedDeviceIdentity } from '../device/types';
import { commitIncomingMessage, prepareIncomingMessage } from '../outbox/outboxStore';
import { listSessionsByPeer, loadSession, type SessionWriteMode } from './sessionStore';
import { confirmWinnerOnReceive, reconcileParallelSessions } from './parallel';
import {
  establishResponderSession,
  localIdentityKeys,
  responderMaterialFromRecords,
} from './handshake';
import { ratchetReceive } from './ratchet';
import { parseSessionResetBody, type SessionResetBody } from './reset';
import { assertSessionMatchesIdentity, assertVerifiedIdentity, pinMatchesIdentity } from './trust';
import type { SessionState } from './types';
import type { LockFence } from '../locks/locks';

export interface E2eeReceiveContext {
  readonly storage: E2eeStorage;
  readonly kStorage: KStorage;
  readonly identity: LoadedDeviceIdentity;
  readonly now?: number;
}

export interface E2eeIncomingEnvelopeInput {
  readonly chatId: string;
  readonly envelope: WireCryptoEnvelope | ParsedEnvelope;
  /** Sender keys verified against the claim bundle / `GET /chats/{id}/keys`. */
  readonly sender: VerifiedDeviceIdentity;
  /** True when the sender is another device of the same user (no pin required). */
  readonly isSelfDevice?: boolean;
  readonly localMessageId?: string;
  readonly serverMessageId?: string | null;
  /**
   * Server `client_message_id` of the received message. It is persisted (sealed)
   * in the incoming local copy so a reload can restore the plaintext without
   * re-running the ratchet (a re-receive would be DUPLICATE_OR_OLD_MESSAGE).
   */
  readonly clientMessageId?: string | null;
  readonly createdAt?: number;
}

export interface OpenedIncomingE2eeMessage {
  readonly session: SessionState;
  readonly sessionMode: SessionWriteMode;
  /** Persisted state the receive step was derived from (E7-F5G P2-36). */
  readonly previousSession: SessionState | null;
  readonly oneTimePrekeyId: string | null;
  readonly contentType: ContentType;
  readonly text: string | null;
  readonly replyToId: string | null;
  readonly reset: SessionResetBody | null;
  readonly prekey: boolean;
  readonly dhRatchet: boolean;
  readonly skippedStored: number;
  readonly senderDeviceId: string;
  readonly senderUserId: string;
  readonly sessionId: string;
  /** Canonical b64u of the envelope ciphertext (sealed into the local copy). */
  readonly ciphertext: string;
  readonly createdAt: number;
}

export interface ReceivedE2eeMessage extends OpenedIncomingE2eeMessage {
  readonly localMessageId: string;
  readonly storedSession: SessionState | null;
}

function requireUuid(value: string, label: string): string {
  if (!isUuid(value)) {
    throw new E2eeError('INVALID_ENVELOPE_FORMAT', `${label} must be a canonical UUID`);
  }
  return value;
}

function asParsedEnvelope(value: WireCryptoEnvelope | ParsedEnvelope): ParsedEnvelope {
  if ('chatId' in value) return value;
  return parseWireEnvelope(value);
}

/** Verifies a prekey envelope against the sender identity and own keys. */
async function assertPrekeyEnvelope(
  envelope: ParsedEnvelope,
  sender: VerifiedDeviceIdentity,
  ownIdentityDhKey: Uint8Array,
  ownIdentitySigningKey: Uint8Array,
  pin: Awaited<ReturnType<typeof readPin>>,
): Promise<Uint8Array> {
  const prekey = envelope.prekey;
  if (!prekey) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope has no prekey block');
  }
  const preamble = buildEnvelopePreamble(envelope, ownIdentitySigningKey);
  const signatureValid = await verifyPreambleSignature(
    prekey.senderIdentitySigningKey,
    preamble,
    prekey.signature,
  );
  if (!signatureValid) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'prekey preamble signature is invalid');
  }
  verifyPrekeySenderIdentity(
    envelope,
    {
      userId: sender.userId,
      deviceId: sender.deviceId,
      keyGeneration: sender.keyGeneration,
      identity: sender,
    },
    pin,
  );
  if (!areBytesEqual(prekey.recipientIdentityDhKey, ownIdentityDhKey)) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'recipient identity DH key does not match ours');
  }
  return sha256(preamble);
}

/**
 * Verifies and decrypts one envelope on a candidate state. No storage write and
 * no OPK consumption happen here; callers must commit the result atomically.
 */
export async function openIncomingE2eeMessage(
  context: E2eeReceiveContext,
  input: E2eeIncomingEnvelopeInput,
): Promise<OpenedIncomingE2eeMessage> {
  const chatId = requireUuid(input.chatId, 'chat_id');
  const envelope = asParsedEnvelope(input.envelope);
  const own = localIdentityKeys(context.identity);
  const now = input.createdAt ?? context.now ?? Date.now();
  const sender = input.sender;
  requireUuid(sender.userId, 'sender.user_id');
  requireUuid(sender.deviceId, 'sender.device_id');
  const isSelfDevice = input.isSelfDevice ?? sender.userId === own.userId;

  if (envelope.chatId !== chatId) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope chat_id does not match the chat');
  }
  if (envelope.recipientDeviceId !== own.deviceId) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope is addressed to another device');
  }
  if (envelope.recipientKeyGeneration !== own.keyGeneration) {
    throw new E2eeError('KEY_GENERATION_STALE', 'envelope recipient_key_generation is stale');
  }
  if (envelope.senderDeviceId !== sender.deviceId) {
    throw new E2eeError('KEY_HANDSHAKE_INVALID', 'envelope sender_device_id does not match');
  }
  await assertVerifiedIdentity(sender);
  await assertDeviceNotBlocked(context.storage, sender.userId, sender.deviceId);

  const pin = await readPin(context.storage, sender.userId, sender.deviceId);
  const sessionId = encodeBase64Url(envelope.sessionId);
  const existing = await loadSession(context.storage, context.kStorage, sessionId);
  const prekey = isPrekeyEnvelope(envelope);

  let session: SessionState;
  let sessionMode: SessionWriteMode;
  let previousSession: SessionState | null = null;
  let oneTimePrekeyId: string | null = null;
  let preambleHash = zeros(32);

  if (existing !== null) {
    assertSessionMatchesIdentity(existing, sender, chatId);
    if (pin !== null) {
      if (!pinMatchesIdentity(pin, sender)) {
        throw new E2eeError(
          'KEY_CHANGE_DETECTED',
          'sender identity changed since the session was pinned',
        );
      }
    } else if (!isSelfDevice) {
      throw new E2eeError(
        'KEY_HANDSHAKE_INVALID',
        'existing session has no TOFU pin for the sender',
      );
    }
    session = existing;
    previousSession = existing;
    sessionMode = { ifRevision: existing.revision };
  } else {
    if (!prekey) {
      throw new E2eeError('NO_SESSION', 'no session for this envelope and no prekey block');
    }
    const prekeyBlock = envelope.prekey!;
    const spk = await getSignedPrekey(context.storage, prekeyBlock.spkId);
    if (spk === null) {
      throw new E2eeError('SPK_DELETED', 'signed prekey used by this session was deleted');
    }
    let opk = null;
    if (prekeyBlock.opkId !== null) {
      opk = await getOneTimePrekey(context.storage, prekeyBlock.opkId);
      if (opk === null) {
        throw new E2eeError('KEY_HANDSHAKE_INVALID', 'one-time prekey is unknown or already used');
      }
      if (now > opk.expiresAt) {
        throw new E2eeError('KEY_HANDSHAKE_INVALID', 'one-time prekey has expired');
      }
    }
    const material = responderMaterialFromRecords({
      deviceId: own.deviceId,
      keyGeneration: own.keyGeneration,
      identityDhPrivateKey: context.identity.dhPrivateKey,
      identityDhPublicKey: own.identityDhKey,
      identitySigningPublicKey: own.identitySigningKey,
      spk: { keyId: spk.keyId, publicKey: spk.publicKey, privateKey: spk.privateKey },
      opk:
        opk === null
          ? null
          : { keyId: opk.keyId, publicKey: opk.publicKey, privateKey: opk.privateKey },
    });
    const established = await establishResponderSession({
      chatId,
      envelope,
      sender,
      material,
      pin,
      now,
    });
    if (pin === null) {
      // First contact: pin only after every §3.3.1 check has passed.
      const check = await checkVerifiedIdentityPin(context.storage, sender, {
        now,
        source: 'chat_keys',
      });
      if (check.status === 'key_change') {
        throw new E2eeError('KEY_CHANGE_DETECTED', 'sender identity changed during first contact');
      }
    }
    session = established.session;
    oneTimePrekeyId = established.oneTimePrekeyId;
    sessionMode = { create: true };
    preambleHash = await sha256(established.preamble);
  }

  if (prekey) {
    preambleHash = await assertPrekeyEnvelope(
      envelope,
      sender,
      own.identityDhKey,
      own.identitySigningKey,
      pin,
    );
  }

  const step = await ratchetReceive(session, {
    header: envelope.header,
    ciphertext: envelope.ciphertext,
    now,
    buildAd: (header) =>
      buildAd({
        chatId: uuidToBytes(chatId),
        senderDeviceId: uuidToBytes(sender.deviceId),
        senderKeyGeneration: sender.keyGeneration,
        recipientDeviceId: uuidToBytes(own.deviceId),
        recipientKeyGeneration: own.keyGeneration,
        sessionId: envelope.sessionId,
        prekey,
        preambleHash,
        header,
      }),
  });

  const inner = parseInnerPayload(step.plaintext);
  let text: string | null = null;
  let replyToId: string | null = null;
  let reset: SessionResetBody | null = null;
  if (inner.contentType === 1) {
    const parsed = parseTextBody(inner.body);
    text = parsed.text;
    replyToId = parsed.replyToId;
  } else {
    reset = parseSessionResetBody(inner.body);
  }

  return {
    session: step.state,
    sessionMode,
    previousSession,
    oneTimePrekeyId,
    contentType: inner.contentType,
    text,
    replyToId,
    reset,
    prekey,
    dhRatchet: step.dhRatchet,
    skippedStored: step.skippedStored,
    senderDeviceId: sender.deviceId,
    senderUserId: sender.userId,
    sessionId,
    ciphertext: encodeBase64Url(envelope.ciphertext),
    createdAt: now,
  };
}

/**
 * Atomic receive commit: shifted session + consumed OPK + sealed local copy in
 * one transaction, exactly as §3.4.6 requires. A duplicate copy aborts the
 * commit and the OPK survives.
 */
export async function commitIncomingE2eeMessage(
  context: E2eeReceiveContext,
  opened: OpenedIncomingE2eeMessage,
  options: {
    readonly localMessageId?: string;
    readonly serverMessageId?: string | null;
    readonly clientMessageId?: string | null;
  } = {},
): Promise<ReceivedE2eeMessage> {
  const localMessageId = options.localMessageId ?? randomUuid();
  const prepared = await prepareIncomingMessage(context.kStorage, {
    sessionState: opened.session,
    sessionMode: opened.sessionMode,
    previousSessionState: opened.previousSession,
    oneTimePrekeyId: opened.oneTimePrekeyId,
    now: opened.createdAt,
    localCopy: {
      chatId: opened.session.chatId,
      sessionId: opened.sessionId,
      clientMessageId: options.clientMessageId ?? null,
      localMessageId,
      direction: 'incoming',
      senderDeviceId: opened.senderDeviceId,
      contentType: opened.contentType,
      text: opened.text,
      ciphertexts: [opened.ciphertext],
      replyToId: opened.replyToId,
      serverMessageId: options.serverMessageId ?? null,
      createdAt: opened.createdAt,
    },
  });
  const storedSession = await commitIncomingMessage(context.storage, prepared);
  return { ...opened, localMessageId, storedSession };
}

/**
 * Full receive pipeline: open + pin + atomic commit. Throws before any write on
 * failure. §5.7 winner handling is an E7-F6 addition: a successful receive on
 * the deterministic winner persists the confirmation atomically with the
 * message, and the reconciliation then marks/deletes the losing simultaneous
 * session after its delivery window. The loser itself can still receive
 * in-flight envelopes until then.
 */
export async function receiveE2eeMessage(
  context: E2eeReceiveContext,
  input: E2eeIncomingEnvelopeInput,
  options: {
    readonly fence?: LockFence;
    readonly localMessageId?: string;
    readonly serverMessageId?: string | null;
  } = {},
): Promise<ReceivedE2eeMessage> {
  options.fence?.assertValid();
  const opened = await openIncomingE2eeMessage(context, input);

  // Merge the candidate state with the persisted sibling sessions so the
  // winner decision sees the pair even before the new session is committed.
  // A corrupt sibling index must not block decrypting this message; without a
  // peer list we simply skip the winner confirmation until the next receive.
  let peers: SessionState[] = [opened.session];
  try {
    const siblings = await listSessionsByPeer(
      context.storage,
      context.kStorage,
      opened.session.chatId,
      opened.session.peerDeviceId,
    );
    peers = siblings.map((session) =>
      session.sessionId === opened.session.sessionId ? opened.session : session,
    );
    if (!peers.some((session) => session.sessionId === opened.session.sessionId)) {
      peers.push(opened.session);
    }
  } catch {
    peers = [opened.session];
  }
  const confirmed = confirmWinnerOnReceive(peers, opened.session, opened.createdAt);
  const committed = confirmed === opened.session ? opened : { ...opened, session: confirmed };

  const received = await commitIncomingE2eeMessage(context, committed, {
    localMessageId: options.localMessageId,
    serverMessageId: options.serverMessageId,
    clientMessageId: input.clientMessageId ?? null,
  });
  try {
    // Metadata-only and idempotent; a failure here must not turn a committed
    // message into an error (the next load/receive retries reconciliation).
    await reconcileParallelSessions(context.storage, context.kStorage, {
      now: committed.createdAt,
      chatId: committed.session.chatId,
      peerDeviceId: committed.session.peerDeviceId,
    });
  } catch {
    // Retried by recovery on the next load/receive.
  }
  return received;
}

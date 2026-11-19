/**
 * E2EE application bridge (E7-F5).
 *
 * This is the only place that composes F3 (device identity, pins, mode) with F4
 * (sessions, outbox, local copies) and exposes a small, testable surface to
 * `chatStore`. It performs **no network I/O**: the device transport is injected
 * by the API layer, so `src/e2ee/**` keeps its "no fetch" invariant.
 *
 * Everything here is metadata or ciphertext. Plaintext is only handed back to
 * the caller for one message and is already committed to the sealed local copy
 * by F4. Nothing is logged.
 */
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { areBytesEqual, isUuid } from '../encoding/bytes';
import type {
  WireChatKeysResponse,
  WireCryptoEnvelope,
  WireDeviceRegistration,
  WireKeyClaimRequest,
  WireKeyClaimResponse,
  WirePrekeyUploadResult,
  WireSignedPrekeyUpload,
  WireVerificationRequest,
  WireVerificationResponse,
} from '../api/deviceKeys';
import { E2eeError, isE2eeError } from '../errors';
import { switchE2eeAccountIfNeeded } from '../account/switch';
import { registerDevice } from '../device/registration';
import type { DeviceRegistrationResponse } from '../device/types';
import { loadDeviceIdentity } from '../device/identity';
import { acceptObservedKeyChange, checkBundlePin, checkDeviceInfoPin } from '../device/pins';
import { confirmManagedChatMode, evaluateChatMode, readChatModePin } from '../device/modePin';
import type {
  ChatModeEvidence,
  ChatSecurityMode,
  LoadedDeviceIdentity,
  TofuPinCheck,
  VerifiedClaimedBundle,
  VerifiedDeviceKeyInfo,
} from '../device/types';
import { validateChatKeysResponse, validateClaimResponse } from '../device/binding';
import { uploadPrekeys } from '../device/prekeys';
import { loadOrCreateKStorage, type KStorage } from '../storage/kStorage';
import type { E2eeStorage } from '../storage/types';
import {
  commitE2eeSend,
  prepareE2eeSend,
  selectSendingSession,
  type E2eeSendBody,
} from '../session/send';
import { receiveE2eeMessage } from '../session/receive';
import { deleteSession, listSessionsByPeer, loadSession } from '../session/sessionStore';
import { reconcileParallelSessions, recoverParallelSessions } from '../session/parallel';
import type { SessionResetBody } from '../session/reset';
import { buildSafetyNumberQrPayload, computeSafetyNumber } from '../verification/safetyNumber';
import { computeVerificationHash } from '../verification/verificationHash';
import { requireE2eeSupport } from '../crypto/support';
import { randomUuid } from '../device/identity';
import {
  deleteRetryState,
  drainOutbox as drainStoredOutbox,
  listRetryStates,
  lookupIncomingLocalCopy,
  lookupLocalCopy,
  markOutboxAttempt,
  markOutboxFailed,
  markOutboxSent,
  markOutboxSuperseded,
  outboxRetryStatus,
  putRetryState,
  readOutboxEntry,
  reconcileOutbox,
  type OutboxDrainOptions,
  type StoredRetryState,
} from '../outbox/outboxStore';
import type { OutboxDrainResult, OutboxEntry, OutboxSendResult } from '../outbox/types';
import { createE2eeLockManager, type E2eeLockManager } from '../locks/locks';
import {
  ResetDeduplicator,
  ResetRateLimiter,
  buildReceiverReset,
  resetReasonForCode,
  selectRetryWindow,
} from './resetRetry';
import type {
  E2eeChatSnapshot,
  E2eeDeviceView,
  E2eeKeyChangeView,
  E2eeLocalCopyView,
  E2eePreparedSend,
  E2eeReceiveOutcome,
  E2eeResetOutcome,
  E2eeSafetyNumberView,
  E2eeSendResetInput,
  E2eeSendTextInput,
  E2eeVerificationResult,
} from './types';

/** Structural subset of `E2eeDeviceApi`; keeps the crypto layer network-free. */
export interface E2eeDeviceTransport {
  registerDevice(
    body: WireDeviceRegistration,
    idempotencyKey: string,
  ): Promise<DeviceRegistrationResponse>;
  uploadPrekeys(
    deviceId: string,
    body: WireSignedPrekeyUpload,
    idempotencyKey: string,
  ): Promise<WirePrekeyUploadResult>;
  claimPrekeys(body: WireKeyClaimRequest): Promise<WireKeyClaimResponse>;
  getChatKeys(chatId: string): Promise<WireChatKeysResponse>;
  /** `PUT /chats/{chatId}/keys/verification` (verifier device = X-Device-Id). */
  verifyDevice(
    chatId: string,
    body: WireVerificationRequest,
    idempotencyKey: string,
  ): Promise<WireVerificationResponse>;
}

export interface E2eeChatInput {
  readonly chatId: string;
  readonly serverMode: ChatSecurityMode;
  readonly peerHasE2eeCapableDevices?: boolean;
  readonly workspaceMode?: ChatSecurityMode | null;
  readonly e2eeHistoryMarker?: boolean;
}

export interface E2eeIncomingMessage {
  readonly id: string;
  readonly chatId: string;
  readonly senderId: string | null;
  readonly senderDeviceId: string;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
  readonly crypto: WireCryptoEnvelope;
}

export interface E2eeBridge {
  readonly enabled: true;
  readonly resetRateLimiter: ResetRateLimiter;
  initialize(input: {
    readonly userId: string;
    readonly name: string;
    readonly appVersion: string;
  }): Promise<{
    userId: string;
    deviceId: string;
    keyGeneration: number;
    fingerprint: string;
  }>;
  loadChat(input: E2eeChatInput): Promise<E2eeChatSnapshot>;
  sendText(input: E2eeSendTextInput): Promise<E2eePreparedSend>;
  sendReset(input: E2eeSendResetInput): Promise<E2eePreparedSend>;
  receive(chatId: string, message: E2eeIncomingMessage): Promise<E2eeReceiveOutcome>;
  lookupLocalCopy(chatId: string, clientMessageId: string): Promise<E2eeLocalCopyView | null>;
  /**
   * Reload path for an already received message: the ratchet rejects a second
   * receive as a duplicate, so the sealed incoming copy is the only source of
   * plaintext. Scoped by the sender device so a peer-controlled client id can
   * never resolve to the local sender's own copy.
   */
  lookupIncomingLocalCopy(
    chatId: string,
    senderDeviceId: string,
    clientMessageId: string,
    serverMessageId?: string | null,
  ): Promise<E2eeLocalCopyView | null>;
  /**
   * Safety-number verification ceremony (§7.4): computes VH v2 for this
   * verifier device and attests it via `PUT /chats/{id}/keys/verification`.
   * `409 KEY_CHANGED` means the target key generation moved: the caller must
   * reload keys and re-verify; `verified` is never set locally.
   */
  verifyDevice(
    chatId: string,
    targetDeviceId: string,
    method?: 'QR' | 'MANUAL',
  ): Promise<E2eeVerificationResult>;
  handleReset(input: {
    readonly chatId: string;
    readonly senderDeviceId: string;
    readonly reset: SessionResetBody;
  }): Promise<E2eeResetOutcome>;
  /**
   * E7-F5G R-15: resolves a pending reset after the caller's retry batch.
   * Success deletes the failed session; failure unmarks the reset so a repeat
   * reset can re-drive the window (the reset is never lost).
   */
  finishReset(input: {
    readonly chatId: string;
    readonly reset: SessionResetBody;
    readonly failedSessionId: string;
    readonly status: 'completed' | 'failed';
  }): Promise<void>;
  acceptKeyChange(userId: string, deviceId: string): Promise<void>;
  confirmManagedMode(chatId: string, evidence: readonly ChatModeEvidence[]): Promise<void>;
  loadOutgoing(clientMessageId: string): Promise<OutboxEntry | null>;
  confirmSent(
    clientMessageId: string,
    result: { serverMessageId: string; seq: number; warning?: string | null },
  ): Promise<void>;
  markAttempt(clientMessageId: string): Promise<number>;
  markFailed(
    clientMessageId: string,
    code: string,
    options?: { readonly retryable?: boolean },
  ): Promise<void>;
  markSuperseded(clientMessageId: string): Promise<void>;
  /** G4e #30: persists the R-15 retry intent before any replacement is sent. */
  saveRetryState(input: {
    readonly chatId: string;
    readonly senderDeviceId: string;
    readonly reset: SessionResetBody;
  }): Promise<void>;
  clearRetryState(chatId: string, failedSessionId: string): Promise<void>;
  /**
   * Idempotent load/chat-switch reconcile: heals a `confirmSent` →
   * `markSuperseded` gap, deduplicates replacement rows and removes a failed
   * session once all of its replacements are confirmed.
   */
  reconcileRetryState(chatId?: string): Promise<E2eeRetryReconcileResult>;
  /** Durable outbox wake-up. Single-flight/backoff live in the outbox store. */
  drainOutbox(
    send: (entry: OutboxEntry) => Promise<OutboxSendResult>,
    options?: OutboxDrainOptions,
  ): Promise<OutboxDrainResult>;
  invalidateChat(chatId?: string): void;
}

export interface E2eeDurableReset {
  readonly chatId: string;
  readonly senderDeviceId: string;
  readonly reset: SessionResetBody;
}

export interface E2eeRetryStatus {
  readonly chatId: string;
  /** Pending/retryable rows that the durable worker will send. */
  readonly pending: number;
  /** Failed rows without a schedule; they need an explicit user retry. */
  readonly permanent: number;
  readonly nextAttemptAt: number | null;
  readonly retries: readonly E2eeDurableReset[];
}

export interface E2eeRetryReconcileResult {
  readonly statuses: readonly E2eeRetryStatus[];
  readonly completedFailedSessionIds: readonly string[];
  readonly superseded: readonly string[];
}

export interface E2eeBridgeOptions {
  readonly storage: E2eeStorage;
  readonly transport: E2eeDeviceTransport;
  readonly now?: () => number;
}

const CHAT_KEYS_TTL_MS = 60_000;
const KEY_BYTES = 32;

function toDurableReset(state: StoredRetryState): E2eeDurableReset {
  return {
    chatId: state.chatId,
    senderDeviceId: state.senderDeviceId,
    reset: state.reset,
  };
}

interface CachedKeys {
  readonly infos: readonly VerifiedDeviceKeyInfo[];
  readonly checks: readonly TofuPinCheck[];
  readonly blocked: boolean;
  readonly at: number;
}

export function createE2eeBridge(options: E2eeBridgeOptions): E2eeBridge {
  const storage = options.storage;
  const transport = options.transport;
  const now = options.now ?? (() => Date.now());
  const cache = new Map<string, CachedKeys>();
  const resetRateLimiter = new ResetRateLimiter(now);
  const resetDeduplicator = new ResetDeduplicator();
  /**
   * Sessions that are broken (reset in progress or failed retry batch). They
   * must never be selected for a new send until the reset completes.
   */
  const resettingSessions = new Set<string>();

  let identity: LoadedDeviceIdentity | null = null;
  let kStorage: KStorage | null = null;
  let userId: string | null = null;
  /**
   * One durable-drain lock per bridge. It serialises tabs (Web Locks) and makes
   * the retry worker single-flight even when a load and a chat switch race.
   */
  let outboxLocks: E2eeLockManager | null = null;
  function getOutboxLocks(): E2eeLockManager {
    outboxLocks ??= createE2eeLockManager();
    return outboxLocks;
  }

  function ownIdentity(): LoadedDeviceIdentity {
    if (identity === null || identity.record.deviceId === null) {
      throw new E2eeError('DEVICE_NOT_REGISTERED', 'E2EE device identity is not registered');
    }
    if (identity.record.state !== 'registered') {
      throw new E2eeError('DEVICE_NOT_REGISTERED', 'E2EE device identity is not usable');
    }
    return identity;
  }

  function ownDeviceId(): string {
    return ownIdentity().record.deviceId as string;
  }

  function ownContext(): {
    storage: E2eeStorage;
    kStorage: KStorage;
    identity: LoadedDeviceIdentity;
  } {
    if (kStorage === null) {
      throw new E2eeError('KEY_STORAGE_UNAVAILABLE', 'E2EE storage is not initialized');
    }
    return { storage, kStorage, identity: ownIdentity() };
  }

  async function fetchChatInfos(
    chatId: string,
    options: { readonly fresh?: boolean } = {},
  ): Promise<CachedKeys> {
    const hit = cache.get(chatId);
    if (!options.fresh && hit !== undefined && now() - hit.at < CHAT_KEYS_TTL_MS) return hit;

    const response = await transport.getChatKeys(chatId);
    const infos = await validateChatKeysResponse(response, {
      chatId,
      myDeviceId: ownDeviceId(),
      localIdentity: ownIdentity(),
    });
    const checks: TofuPinCheck[] = [];
    for (const info of infos) {
      if (info.isSelf) continue;
      checks.push(await checkDeviceInfoPin(storage, info, { now: now(), source: 'chat_keys' }));
    }
    // A key change is remembered in storage by F3; this flag only blocks the
    // current operation. `loadChat` still renders the persisted warning.
    const blocked = checks.some((check) => check.status === 'key_change');
    const entry: CachedKeys = { infos, checks, blocked, at: now() };
    cache.set(chatId, entry);
    return entry;
  }

  function assertNotBlocked(keys: CachedKeys): void {
    if (keys.blocked) {
      throw new E2eeError(
        'KEY_CHANGE_DETECTED',
        'a chat device identity changed; explicit confirmation is required',
      );
    }
  }

  function keyChangeViews(checks: readonly TofuPinCheck[]): E2eeKeyChangeView[] {
    const result: E2eeKeyChangeView[] = [];
    for (const check of checks) {
      if (check.status !== 'key_change' || check.keyChange === null) continue;
      const record = check.keyChange;
      result.push({
        userId: record.userId,
        deviceId: record.deviceId,
        pinnedFingerprint: record.pinned.fingerprint,
        observedFingerprint: record.observed.fingerprint,
        detectedAt: record.detectedAt,
      });
    }
    return result;
  }

  /**
   * Per-device safety number + QR + VH v2 for this verifier device (§7.2-§7.4).
   * The hash is computed locally from the same 60 digits the dialog shows; the
   * server never receives digits, only the attestation hash.
   */
  async function safetyNumberFor(
    chatId: string,
    info: VerifiedDeviceKeyInfo,
  ): Promise<E2eeSafetyNumberView> {
    const myDeviceId = ownDeviceId();
    const record = ownIdentity().record;
    if (userId === null) throw new E2eeError('DEVICE_NOT_REGISTERED', 'E2EE user is unknown');
    const myFingerprint = decodeBase64Url(record.fingerprint, KEY_BYTES);
    const safety = await computeSafetyNumber(
      { userId, deviceId: myDeviceId, fingerprint: myFingerprint },
      {
        userId: info.userId,
        deviceId: info.deviceId,
        fingerprint: info.fingerprint,
      },
    );
    const verificationHash = await computeVerificationHash({
      chatId,
      verifierUserId: userId,
      verifierDeviceId: myDeviceId,
      targetDeviceId: info.deviceId,
      targetKeyGeneration: info.keyGeneration,
      safetyNumberDigits: safety.digits,
    });
    return {
      userId: info.userId,
      deviceId: info.deviceId,
      display: safety.display,
      qrPayload: buildSafetyNumberQrPayload(
        { deviceId: myDeviceId, fingerprint: myFingerprint },
        { deviceId: info.deviceId, fingerprint: info.fingerprint },
      ),
      verificationHash: encodeBase64Url(verificationHash),
    };
  }

  async function computeSafetyNumbers(
    chatId: string,
    infos: readonly VerifiedDeviceKeyInfo[],
  ): Promise<E2eeSafetyNumberView[]> {
    const myDeviceId = ownDeviceId();
    const result: E2eeSafetyNumberView[] = [];
    for (const info of infos) {
      if (info.deviceId === myDeviceId) continue;
      result.push(await safetyNumberFor(chatId, info));
    }
    return result;
  }

  async function claimBundles(
    chatId: string,
    deviceIds: readonly string[],
    infos: readonly VerifiedDeviceKeyInfo[],
  ): Promise<Map<string, VerifiedClaimedBundle>> {
    const byId = new Map<string, VerifiedClaimedBundle>();
    if (deviceIds.length === 0) return byId;
    if (deviceIds.length > 10) {
      throw new E2eeError('INVALID_RESPONSE', 'too many devices to cover in one claim');
    }
    const infoById = new Map(infos.map((info) => [info.deviceId, info]));
    const request: WireKeyClaimRequest = {
      chat_id: chatId,
      devices: deviceIds.map((deviceId) => {
        const info = infoById.get(deviceId);
        if (!info) throw new E2eeError('INVALID_RESPONSE', 'claim device is not in chat keys');
        return { device_id: deviceId, user_id: info.userId };
      }),
    };
    const response = await transport.claimPrekeys(request);
    const decoded = await validateClaimResponse(response, request, { now: now() });
    for (const bundle of decoded.bundles) {
      // F4 re-verifies the bundle inside prepareE2eeSend; this call persists the
      // TOFU decision before any session may be created.
      await checkBundlePin(storage, bundle, { now: now(), source: 'claim' });
      byId.set(bundle.deviceId, bundle);
    }
    // Bundles the server could not provide are omitted; coverage counts them via
    // `expectedPeerDeviceIds` and surfaces PEER_DEVICE_UNCOVERED.
    return byId;
  }

  async function prepareSend(
    input: E2eeSendTextInput | E2eeSendResetInput,
    kind: 'text' | 'reset',
  ): Promise<E2eePreparedSend> {
    const context = ownContext();
    const chatId = input.chatId;
    const keys = await fetchChatInfos(chatId);
    assertNotBlocked(keys);
    const myDeviceId = ownDeviceId();
    const candidates = keys.infos.filter((info) => info.deviceId !== myDeviceId);
    const peerIds = candidates.filter((info) => !info.isSelf).map((info) => info.deviceId);
    const selfIds = candidates.filter((info) => info.isSelf).map((info) => info.deviceId);

    const freshPrekey = kind === 'reset' ? true : (input as E2eeSendTextInput).freshPrekey === true;
    const needBundle: string[] = [];
    const plans: Array<{
      identity: VerifiedDeviceKeyInfo;
      bundle: VerifiedClaimedBundle | null;
      isSelfDevice: boolean;
      sessionId?: string;
    }> = [];
    const reuseSessionIds =
      kind === 'text' ? ((input as E2eeSendTextInput).reuseSessionIds ?? []) : [];

    for (const info of candidates) {
      if (freshPrekey) {
        needBundle.push(info.deviceId);
        continue;
      }
      const sessions = (
        await listSessionsByPeer(context.storage, context.kStorage, chatId, info.deviceId)
      ).filter(
        (session) =>
          !resettingSessions.has(session.sessionId) &&
          // After an explicit key-change acceptance the old session is still on
          // disk (history is not deleted), but it was bound to the previous
          // identity keys and can never carry traffic for the accepted ones
          // (`assertSessionMatchesIdentity`). Exclude it here so the send
          // establishes a fresh prekey session instead of failing forever.
          areBytesEqual(session.peerIkSig, info.identitySigningKey) &&
          areBytesEqual(session.peerIkDh, info.identityDhKey),
      );
      if (reuseSessionIds.length > 0) {
        // E7-F5G P2-30: reuse the exact fresh session from the first retry; if
        // it is gone, create a fresh prekey session instead of an old one.
        const reused = sessions.find((session) => reuseSessionIds.includes(session.sessionId));
        if (reused === undefined) needBundle.push(info.deviceId);
        else {
          plans.push({
            identity: info,
            bundle: null,
            isSelfDevice: info.isSelf,
            sessionId: reused.sessionId,
          });
        }
        continue;
      }
      if (selectSendingSession(sessions) === null) {
        needBundle.push(info.deviceId);
      } else {
        plans.push({ identity: info, bundle: null, isSelfDevice: info.isSelf });
      }
    }

    const bundles = await claimBundles(chatId, needBundle, keys.infos);
    for (const info of candidates) {
      if (!needBundle.includes(info.deviceId)) continue;
      const bundle = bundles.get(info.deviceId) ?? null;
      if (bundle !== null) plans.push({ identity: info, bundle, isSelfDevice: info.isSelf });
    }
    if (!plans.some((plan) => !plan.isSelfDevice)) {
      throw new E2eeError('PEER_UNCOVERED', 'no peer device could be covered for this send');
    }

    const body: E2eeSendBody =
      kind === 'text'
        ? {
            type: 'TEXT_JSON',
            text: (input as E2eeSendTextInput).text,
            replyToId: (input as E2eeSendTextInput).replyToId ?? null,
            retryOfClientMessageId: (input as E2eeSendTextInput).retryOfClientMessageId ?? null,
          }
        : { type: 'SESSION_RESET', reset: (input as E2eeSendResetInput).reset };

    const textInput = input as E2eeSendTextInput;
    const resetInput = input as E2eeSendResetInput;
    const prepared = await prepareE2eeSend(
      {
        storage: context.storage,
        kStorage: context.kStorage,
        identity: context.identity,
        now: now(),
      },
      {
        chatId,
        body,
        recipients: plans.map((plan) => ({
          identity: plan.identity,
          bundle: plan.bundle,
          isSelfDevice: plan.isSelfDevice,
          sessionId: plan.sessionId,
          freshPrekey: freshPrekey || plan.bundle !== null,
        })),
        expectedPeerDeviceIds: peerIds,
        expectedSelfDeviceIds: selfIds,
        clientMessageId: kind === 'text' ? textInput.clientMessageId : resetInput.clientMessageId,
        idempotencyKey: kind === 'text' ? textInput.idempotencyKey : resetInput.idempotencyKey,
        retryOfClientMessageId: kind === 'text' ? (textInput.retryOfClientMessageId ?? null) : null,
        excludeSessionIds: [...resettingSessions],
        createdAt: input.createdAt ?? now(),
      },
    );
    const committed = await commitE2eeSend(context.storage, prepared);
    return {
      kind,
      chatId,
      clientMessageId: committed.clientMessageId,
      localMessageId: committed.localMessageId,
      idempotencyKey: committed.idempotencyKey,
      sessionId: committed.sessionId,
      sessionIds: [...new Set(committed.envelopes.map((envelope) => envelope.session_id))],
      text: prepared.text,
      replyToId: kind === 'text' ? (textInput.replyToId ?? null) : null,
      retryOfClientMessageId: kind === 'text' ? (textInput.retryOfClientMessageId ?? null) : null,
      envelopes: committed.envelopes,
      coverage: committed.coverage,
      coverageWarning: committed.coverageWarning,
      otpExhausted: committed.otpExhausted,
      createdAt: prepared.createdAt,
    };
  }

  return {
    enabled: true,
    resetRateLimiter,

    async initialize(input) {
      // E7-F8 P1-04 / ADR-26: WebKit passes primitive detection but fails the
      // RFC 8032 Ed25519 known-answer probe, so E2EE must fail closed here
      // instead of silently registering a keyed device.
      await requireE2eeSupport();
      // E7-F5G P1-04: an account switch without logout wipes the previous
      // owner's single-slot E2EE state before the new account registers.
      const switched = await switchE2eeAccountIfNeeded(storage, { userId: input.userId });
      if (switched === 'switched') {
        identity = null;
        kStorage = null;
        cache.clear();
      }
      // In-memory reset state belongs to the previous page/account.
      resetDeduplicator.clear();
      resetRateLimiter.clearAll();
      resettingSessions.clear();
      userId = input.userId;
      const result = await registerDevice(storage, transport, {
        userId: input.userId,
        name: input.name,
        appVersion: input.appVersion,
        now: now(),
      });
      identity = await loadDeviceIdentity(storage, { userId: input.userId });
      if (identity === null || identity.record.deviceId === null) {
        throw new E2eeError('DEVICE_NOT_REGISTERED', 'registered identity is missing locally');
      }
      kStorage = await loadOrCreateKStorage(storage, identity.record.deviceId, {
        userId: input.userId,
      });
      try {
        // E7-F6 §5.7: finish any winner/loser transition that a crash or page
        // reload interrupted. Idempotent; no session is deleted before its
        // confirmation window and no reset-in-progress session is touched.
        await recoverParallelSessions(storage, kStorage, {
          now: now(),
          protectedSessionIds: resettingSessions,
        });
      } catch {
        // Recovery is retried on the next load/receive; registration continues.
      }
      try {
        await uploadPrekeys(storage, identity, transport, { now: now() });
      } catch {
        // Best effort: registration already uploaded the initial batch. A later
        // bootstrap retries the exact pending batch; sending keeps working.
      }
      return {
        userId: input.userId,
        deviceId: result.deviceId,
        keyGeneration: result.keyGeneration,
        fingerprint: identity.record.fingerprint,
      };
    },

    async loadChat(input) {
      const evaluation = await evaluateChatMode(
        storage,
        {
          chatId: input.chatId,
          serverMode: input.serverMode,
          peerHasE2eeCapableDevices: input.peerHasE2eeCapableDevices,
          workspaceMode: input.workspaceMode ?? null,
          e2eeHistoryMarker: input.e2eeHistoryMarker,
        },
        { now: now() },
      );
      const selfDeviceId = identity?.record.deviceId ?? '';
      if (evaluation.action !== 'allow_e2ee') {
        return {
          chatId: input.chatId,
          securityMode: input.serverMode,
          modeAction: evaluation.action,
          evidence: evaluation.evidence,
          selfDeviceId,
          selfFingerprint: identity?.record.fingerprint ?? '',
          devices: [],
          peerDeviceIds: [],
          selfDeviceIds: [],
          unavailableDeviceIds: [],
          keyChanges: [],
          safetyNumbers: [],
          loadedAt: now(),
        };
      }
      const keys = await fetchChatInfos(input.chatId, { fresh: true });
      if (kStorage !== null) {
        try {
          // E7-F6 §5.7: a reload/idle tab resumes a pending winner deletion.
          await reconcileParallelSessions(storage, kStorage, {
            now: now(),
            chatId: input.chatId,
            protectedSessionIds: resettingSessions,
          });
        } catch {
          // Retried on the next load/receive.
        }
      }
      const myDeviceId = ownDeviceId();
      const peerInfos = keys.infos.filter((info) => info.deviceId !== myDeviceId);
      // A TOFU key change invalidates any previous attestation, even if the
      // server still returns an old `verified=true` row (P1-02 reset).
      const keyChanged = new Set(
        keys.checks
          .filter((check) => check.status === 'key_change')
          .map((check) => check.pin.deviceId),
      );
      const devices: E2eeDeviceView[] = peerInfos.map((info) => ({
        userId: info.userId,
        deviceId: info.deviceId,
        fingerprint: info.fingerprintBase64Url,
        isSelf: info.isSelf,
        verified: info.verified && !keyChanged.has(info.deviceId),
        verifiedAt: info.verifiedAt,
        verificationMethod: info.verificationMethod,
        status: info.status,
      }));
      return {
        chatId: input.chatId,
        securityMode: 'E2EE',
        modeAction: evaluation.action,
        evidence: evaluation.evidence,
        selfDeviceId: myDeviceId,
        selfFingerprint: ownIdentity().record.fingerprint,
        devices,
        peerDeviceIds: peerInfos.filter((info) => !info.isSelf).map((info) => info.deviceId),
        selfDeviceIds: peerInfos.filter((info) => info.isSelf).map((info) => info.deviceId),
        unavailableDeviceIds: [],
        keyChanges: keyChangeViews(keys.checks),
        safetyNumbers: await computeSafetyNumbers(input.chatId, keys.infos),
        loadedAt: now(),
      };
    },

    sendText(input) {
      return prepareSend(input, 'text');
    },

    sendReset(input) {
      return prepareSend(input, 'reset');
    },

    async receive(chatId, message) {
      const keys = await fetchChatInfos(chatId);
      if (keys.blocked) {
        return { kind: 'error', code: 'KEY_CHANGE_DETECTED', reset: null, reason: null };
      }
      const sender = keys.infos.find((info) => info.deviceId === message.senderDeviceId);
      if (!sender) {
        return { kind: 'error', code: 'KEY_HANDSHAKE_INVALID', reset: null, reason: null };
      }
      const context = ownContext();
      const createdAt = Date.parse(message.createdAt);
      try {
        const received = await receiveE2eeMessage(
          {
            storage: context.storage,
            kStorage: context.kStorage,
            identity: context.identity,
            now: Number.isFinite(createdAt) ? createdAt : now(),
          },
          {
            chatId,
            envelope: message.crypto,
            sender,
            isSelfDevice: sender.isSelf,
            serverMessageId: message.id,
            clientMessageId: message.clientMessageId,
            createdAt: Number.isFinite(createdAt) ? createdAt : now(),
          },
        );
        if (received.contentType === 2 && received.reset !== null) {
          return {
            kind: 'control',
            sessionId: received.sessionId,
            reset: received.reset,
            senderDeviceId: received.senderDeviceId,
          };
        }
        return {
          kind: 'message',
          localMessageId: received.localMessageId,
          sessionId: received.sessionId,
          text: received.text ?? '',
          replyToId: received.replyToId,
          retryOfClientMessageId: received.retryOfClientMessageId,
        };
      } catch (error) {
        if (!isE2eeError(error)) throw error;
        if (error.code === 'DUPLICATE_OR_OLD_MESSAGE') return { kind: 'none' };
        const reason = resetReasonForCode(error.code);
        // E7-F5F: do not drop the reset just because the server omitted the
        // plaintext `clientMessageId`; the receiver falls back to
        // `(failed_chain_dh, failed_n)` from the failed envelope.
        const reset =
          reason !== null && !sender.isSelf
            ? buildReceiverReset({
                envelope: message.crypto,
                clientMessageId: message.clientMessageId,
                reason,
              })
            : null;
        return { kind: 'error', code: error.code, reset, reason };
      }
    },

    async lookupLocalCopy(chatId, clientMessageId) {
      const context = ownContext();
      const found = await lookupLocalCopy(
        context.storage,
        context.kStorage,
        chatId,
        clientMessageId,
      );
      if (!found.available) return null;
      return {
        text: found.copy.text,
        replyToId: found.copy.replyToId,
        contentType: found.copy.contentType,
        status: found.copy.status,
        serverMessageId: found.copy.serverMessageId,
        retryOfClientMessageId: found.copy.retryOfClientMessageId,
      };
    },

    async lookupIncomingLocalCopy(chatId, senderDeviceId, clientMessageId, serverMessageId) {
      const context = ownContext();
      const found = await lookupIncomingLocalCopy(
        context.storage,
        context.kStorage,
        chatId,
        senderDeviceId,
        clientMessageId,
        serverMessageId ?? null,
      );
      if (!found.available) return null;
      return {
        text: found.copy.text,
        replyToId: found.copy.replyToId,
        contentType: found.copy.contentType,
        status: found.copy.status,
        serverMessageId: found.copy.serverMessageId,
        retryOfClientMessageId: found.copy.retryOfClientMessageId,
      };
    },

    async verifyDevice(chatId, targetDeviceId, method = 'MANUAL') {
      ownContext();
      if (!isUuid(chatId)) {
        throw new E2eeError('INVALID_PAYLOAD', 'verification chat id must be a canonical UUID');
      }
      if (!isUuid(targetDeviceId)) {
        throw new E2eeError('INVALID_PAYLOAD', 'verification target device id is invalid');
      }
      // Never attest a stale key: use freshly fetched chat keys and refuse while
      // a TOFU key change is still unaccepted.
      const keys = await fetchChatInfos(chatId, { fresh: true });
      assertNotBlocked(keys);
      const target = keys.infos.find((info) => info.deviceId === targetDeviceId);
      if (
        target === undefined ||
        target.isSelf ||
        target.deviceId === ownDeviceId() ||
        target.status !== 'ACTIVE'
      ) {
        throw new E2eeError('INVALID_RESPONSE', 'verification target is not an active peer device');
      }
      const safety = await safetyNumberFor(chatId, target);
      if (safety.verificationHash === undefined) {
        throw new E2eeError('INVALID_RESPONSE', 'verification hash could not be computed');
      }
      const body: WireVerificationRequest = {
        device_id: target.deviceId,
        method,
        vh_version: 2,
        safety_number_hash: safety.verificationHash,
        expected_key_generation: target.keyGeneration,
      };
      let response: WireVerificationResponse;
      try {
        response = await transport.verifyDevice(chatId, body, randomUuid());
      } catch (error) {
        const details = error as { kind?: unknown; code?: unknown; status?: unknown };
        if (
          details.kind === 'key_changed' ||
          details.code === 'KEY_CHANGED' ||
          details.status === 409
        ) {
          // §6.2.7/§7.5: generation moved between keys fetch and attestation.
          // The caller reloads keys and the user re-verifies; nothing is faked.
          throw new E2eeError(
            'KEY_CHANGE_DETECTED',
            'target key generation changed during verification',
          );
        }
        if (isE2eeError(error)) throw error;
        throw new E2eeError('VERIFICATION_FAILED', 'verification request failed');
      }
      const verifiedAt = Date.parse(response.verified_at);
      if (
        response.chat_id !== chatId ||
        response.device_id !== target.deviceId ||
        response.verifier_device_id !== ownDeviceId() ||
        response.key_generation !== target.keyGeneration ||
        response.method !== method ||
        response.verified !== true ||
        !Number.isFinite(verifiedAt)
      ) {
        throw new E2eeError('INVALID_RESPONSE', 'verification response does not match the request');
      }
      // The next loadChat must read the server attestation, not a cached row.
      cache.delete(chatId);
      return {
        deviceId: target.deviceId,
        verified: true,
        verifiedAt,
        method,
        keyGeneration: response.key_generation,
      };
    },

    async handleReset(input) {
      const context = ownContext();
      const failedSessionId = input.reset.failedSessionId;
      // A replay after the first reset deleted the failed session must still be
      // reported as a duplicate, not as an unknown session.
      if (resetDeduplicator.hasProcessed(input.reset)) {
        return { status: 'ignored', reason: 'duplicate' };
      }
      const session = await loadSession(context.storage, context.kStorage, failedSessionId);
      if (
        session === null ||
        session.chatId !== input.chatId ||
        session.peerDeviceId !== input.senderDeviceId
      ) {
        return { status: 'ignored', reason: 'invalid_session' };
      }
      // E7-F5F: a duplicate reset for the same failed chain/anchor must not
      // re-drive the retry window (v1 has no retry marker in the re-encrypted
      // TEXT, so this guard is the receiver-side L3b protection).
      if (!resetDeduplicator.markProcessed(input.reset)) {
        return { status: 'ignored', reason: 'duplicate' };
      }
      let window: Awaited<ReturnType<typeof selectRetryWindow>>;
      try {
        window = await selectRetryWindow(context.storage, context.kStorage, {
          chatId: input.chatId,
          failedSessionId,
          reset: input.reset,
        });
      } catch (error) {
        // Selecting the window failed before any retry was attempted: do not
        // leave the reset swallowed by the in-memory dedupe.
        resetDeduplicator.forget(input.reset);
        throw error;
      }
      if (window.status === 'anchor_unknown') {
        resetDeduplicator.forget(input.reset);
        await deleteSession(context.storage, failedSessionId);
        return { status: 'ignored', reason: 'anchor_unknown' };
      }
      if (window.status === 'empty') {
        resetDeduplicator.forget(input.reset);
        await deleteSession(context.storage, failedSessionId);
        return { status: 'ignored', reason: 'empty' };
      }
      if (window.candidates.length === 0) {
        const pendingReplacements = window.pendingReplacements ?? 0;
        if (pendingReplacements > 0) {
          // G4e #30: the exact replacement bytes are already durable. Never
          // encrypt a second copy; the worker replays them by idempotency key.
          resettingSessions.add(failedSessionId);
          return {
            status: 'pending',
            failedSessionId,
            candidates: [],
            remaining: 0,
            skipped: window.skipped,
            pendingReplacements,
          };
        }
        resetDeduplicator.forget(input.reset);
        await deleteSession(context.storage, failedSessionId);
        return { status: 'ignored', reason: 'empty' };
      }
      // E7-F5G R-15: the failed session is retained until the retry batch
      // actually succeeds (`finishReset` deletes it). A failed batch unmarks
      // the reset so it can be re-driven instead of being lost. While pending,
      // the broken session is excluded from normal send selection.
      resettingSessions.add(failedSessionId);
      return {
        status: 'pending',
        failedSessionId,
        candidates: window.candidates,
        remaining: window.remaining,
        skipped: window.skipped,
      };
    },

    async finishReset(input) {
      const context = ownContext();
      if (input.status === 'completed') {
        try {
          // The failed session must never be used again; new messages arrive
          // in a fresh prekey session.
          await deleteSession(context.storage, input.failedSessionId);
          await deleteRetryState(context.storage, input.chatId, input.failedSessionId);
        } catch (error) {
          // Do not leave the reset marked as processed if the broken session
          // could not be removed: the next reset must still be able to retry.
          resetDeduplicator.forget(input.reset);
          throw error;
        }
        resettingSessions.delete(input.failedSessionId);
        return;
      }
      // Failed/partial batch: keep the (broken) session so a repeated reset can
      // re-drive the remaining window, but never swallow that reset.
      resetDeduplicator.forget(input.reset);
    },

    async acceptKeyChange(pinUserId, deviceId) {
      await acceptObservedKeyChange(storage, pinUserId, deviceId, { now: now() });
      cache.clear();
    },

    async confirmManagedMode(chatId, evidence) {
      const pin = await readChatModePin(storage, chatId);
      if (pin?.mode === 'E2EE') {
        throw new E2eeError('SECURITY_MODE_MISMATCH', 'E2EE chat cannot be downgraded');
      }
      await confirmManagedChatMode(storage, {
        chatId,
        serverMode: 'MANAGED',
        evidence,
        now: now(),
      });
      cache.delete(chatId);
    },

    loadOutgoing(clientMessageId) {
      const context = ownContext();
      return readOutboxEntry(context.storage, context.kStorage, clientMessageId);
    },

    async confirmSent(clientMessageId, result) {
      const context = ownContext();
      await markOutboxSent(context.storage, clientMessageId, result, { now: now() });
    },

    async markAttempt(clientMessageId) {
      const context = ownContext();
      return markOutboxAttempt(context.storage, clientMessageId, { now: now() });
    },

    async markFailed(clientMessageId, code, options = {}) {
      const context = ownContext();
      await markOutboxFailed(context.storage, clientMessageId, code, {
        now: now(),
        ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
      });
    },

    async markSuperseded(clientMessageId) {
      const context = ownContext();
      await markOutboxSuperseded(context.storage, clientMessageId, { now: now() });
    },

    async saveRetryState(input) {
      const context = ownContext();
      await putRetryState(
        context.storage,
        { chatId: input.chatId, senderDeviceId: input.senderDeviceId, reset: input.reset },
        { now: now() },
      );
    },

    async clearRetryState(chatId, failedSessionId) {
      const context = ownContext();
      await deleteRetryState(context.storage, chatId, failedSessionId);
    },

    async reconcileRetryState(chatId) {
      const context = ownContext();
      const states = await listRetryStates(context.storage, chatId);
      const reconciled = await reconcileOutbox(context.storage, context.kStorage, {
        chatId,
        now: now(),
      });
      const completed: string[] = [];
      for (const state of states) {
        if (!reconciled.completedFailedSessionIds.includes(state.reset.failedSessionId)) {
          continue;
        }
        try {
          // The replacement bytes are confirmed; the broken session must never
          // be selected again. A failure here keeps the retry state so the next
          // reconcile retries the exact same cleanup.
          await deleteSession(context.storage, state.reset.failedSessionId);
          await deleteRetryState(context.storage, state.chatId, state.reset.failedSessionId);
          resettingSessions.delete(state.reset.failedSessionId);
          completed.push(state.reset.failedSessionId);
        } catch {
          // Retried on the next load/chat switch.
        }
      }
      const liveStates = states.filter((state) => !completed.includes(state.reset.failedSessionId));
      const statuses = await outboxRetryStatus(context.storage, context.kStorage, {
        chatId,
        now: now(),
      });
      const byChat = new Map<string, { pending: number; permanent: number; next: number | null }>(
        statuses.map((status) => [
          status.chatId,
          {
            pending: status.pending,
            permanent: status.permanent,
            next: status.nextAttemptAt,
          },
        ]),
      );
      for (const state of liveStates) {
        if (!byChat.has(state.chatId)) {
          byChat.set(state.chatId, { pending: 0, permanent: 0, next: null });
        }
      }
      return {
        statuses: [...byChat.entries()]
          .map(([statusChatId, bucket]) => ({
            chatId: statusChatId,
            pending: bucket.pending,
            permanent: bucket.permanent,
            nextAttemptAt: bucket.next,
            retries: liveStates
              .filter((state) => state.chatId === statusChatId)
              .map((state) => toDurableReset(state)),
          }))
          .sort((a, b) => a.chatId.localeCompare(b.chatId)),
        completedFailedSessionIds: completed,
        superseded: reconciled.superseded,
      };
    },

    async drainOutbox(send, options = {}) {
      const context = ownContext();
      return drainStoredOutbox(context.storage, context.kStorage, getOutboxLocks(), send, {
        ...options,
        now: options.now ?? now(),
      });
    },

    invalidateChat(chatId) {
      if (chatId === undefined) {
        cache.clear();
        resetDeduplicator.clear();
        resetRateLimiter.clearAll();
        resettingSessions.clear();
      } else {
        cache.delete(chatId);
      }
    },
  };
}

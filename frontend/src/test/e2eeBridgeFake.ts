/**
 * Test-only E2EE bridge double for store/UI suites (E7-F5).
 *
 * It mimics the observable contract of `E2eeBridge` without crypto or storage;
 * the real crypto path is covered by `src/e2ee/app/chatBridge.test.ts`.
 */
import { encodeBase64Url } from '../e2ee/encoding/base64url';
import { newUuid } from '../lib/ids';
import { ResetDeduplicator, ResetRateLimiter } from '../e2ee/app/resetRetry';
import type {
  E2eeBridge,
  E2eeChatInput,
  E2eeDurableReset,
  E2eeIncomingMessage,
  E2eeRetryReconcileResult,
  E2eeRetryStatus,
} from '../e2ee/app/chatBridge';
import type { SessionResetBody } from '../e2ee/session/reset';
import type { WireCryptoEnvelope } from '../e2ee/api/deviceKeys';
import type { OutboxEntry } from '../e2ee/outbox/types';
import type {
  E2eeChatSnapshot,
  E2eeLocalCopyView,
  E2eePreparedSend,
  E2eeReceiveOutcome,
  E2eeResetOutcome,
} from '../e2ee/app/types';

export interface FakeBridgeOptions {
  readonly deviceId: () => string;
  readonly snapshot: Partial<E2eeChatSnapshot>;
}

export interface FakeBridge extends E2eeBridge {
  readonly sends: Array<{ kind: 'text' | 'reset'; chatId: string; text: string | null }>;
  readonly resets: SessionResetBody[];
  readonly sentConfirmations: string[];
  readonly accepted: Array<{ userId: string; deviceId: string }>;
  readonly verifications: Array<{
    chatId: string;
    deviceId: string;
    method: 'QR' | 'MANUAL';
  }>;
  readonly finishedResets: Array<{
    failedSessionId: string;
    status: 'completed' | 'failed';
  }>;
  readonly reuseRequests: Array<readonly string[] | undefined>;
  readonly confirmedManaged: string[];
  /** Queue consumed by `receive`; defaults to a decrypted message. */
  receiveQueue: E2eeReceiveOutcome[];
  setSnapshot(patch: Partial<E2eeChatSnapshot>): void;
  setIncomingText(text: string): void;
  readonly outgoing: Map<string, OutboxEntry>;
  /** G4e #30: durable R-15 intents saved by the store, keyed by chat/session. */
  readonly savedRetries: Map<string, E2eeDurableReset>;
  readonly localCopies: Map<string, E2eeLocalCopyView>;
  readonly incomingLocalCopies: Map<string, E2eeLocalCopyView>;
  resetOutcome: E2eeResetOutcome | null;
}

const b64 = (bytes: number, fill: number) => encodeBase64Url(new Uint8Array(bytes).fill(fill));

export function makeEnvelope(
  chatId: string,
  senderDeviceId: string,
  recipientDeviceId: string,
  n = 0,
): WireCryptoEnvelope {
  return {
    v: 1,
    scheme: 'PAIRWISE_X3DH_DR',
    chat_id: chatId,
    session_id: b64(16, 1),
    sender_device_id: senderDeviceId,
    sender_key_generation: 1,
    recipient_device_id: recipientDeviceId,
    recipient_key_generation: 1,
    header: { v: 1, dh: b64(32, 2), pn: 0, n },
    ciphertext: b64(300, 3),
    prekey: null,
  };
}

export function createFakeE2eeBridge(options: FakeBridgeOptions): FakeBridge {
  let snapshot: E2eeChatSnapshot = {
    chatId: '77777777-7777-4777-8777-777777777777',
    securityMode: 'E2EE',
    modeAction: 'allow_e2ee',
    evidence: [],
    selfDeviceId: options.deviceId(),
    selfFingerprint: b64(32, 4),
    devices: [],
    peerDeviceIds: [],
    selfDeviceIds: [],
    unavailableDeviceIds: [],
    keyChanges: [],
    safetyNumbers: [],
    loadedAt: 1,
    ...options.snapshot,
  };

  const sends: FakeBridge['sends'] = [];
  const resets: SessionResetBody[] = [];
  const sentConfirmations: string[] = [];
  const accepted: Array<{ userId: string; deviceId: string }> = [];
  const verifications: Array<{ chatId: string; deviceId: string; method: 'QR' | 'MANUAL' }> = [];
  const finishedResets: FakeBridge['finishedResets'] = [];
  const reuseRequests: FakeBridge['reuseRequests'] = [];
  const confirmedManaged: string[] = [];
  const outgoing = new Map<string, OutboxEntry>();
  const savedRetries = new Map<string, E2eeDurableReset>();
  const localCopies = new Map<string, E2eeLocalCopyView>();
  const incomingLocalCopies = new Map<string, E2eeLocalCopyView>();
  let sendOrder = 0;

  const retryKey = (chatId: string, failedSessionId: string) => `${chatId}:${failedSessionId}`;

  function replacementEntries(): OutboxEntry[] {
    return [...outgoing.values()].sort((a, b) => a.sendOrder - b.sendOrder);
  }

  function statusesFor(chatId?: string): E2eeRetryStatus[] {
    const entries = replacementEntries().filter(
      (entry) => chatId === undefined || entry.chatId === chatId,
    );
    const chats = new Set<string>([
      ...entries.map((entry) => entry.chatId),
      ...[...savedRetries.values()]
        .filter((state) => chatId === undefined || state.chatId === chatId)
        .map((state) => state.chatId),
    ]);
    const result: E2eeRetryStatus[] = [];
    for (const id of chats) {
      const own = entries.filter((entry) => entry.chatId === id);
      const pending = own.filter((entry) => entry.status === 'pending').length;
      const scheduled = own.filter((entry) => entry.status === 'failed');
      const nextAttemptAt = own.reduce<number | null>((next, entry) => {
        if (entry.status !== 'failed' || entry.nextAttemptAt === null) return next;
        return next === null ? entry.nextAttemptAt : Math.min(next, entry.nextAttemptAt);
      }, null);
      result.push({
        chatId: id,
        pending: pending + scheduled.filter((entry) => entry.nextAttemptAt !== null).length,
        permanent: scheduled.filter((entry) => entry.nextAttemptAt === null).length,
        nextAttemptAt,
        retries: [...savedRetries.values()].filter((state) => state.chatId === id),
      });
    }
    return result.sort((a, b) => a.chatId.localeCompare(b.chatId));
  }
  const resetRateLimiter = new ResetRateLimiter(() => Date.now());
  const resetDeduplicator = new ResetDeduplicator();
  let counter = 0;
  let incomingText: string | null = null;
  const receiveQueue: E2eeReceiveOutcome[] = [];

  function prepared(kind: 'text' | 'reset', chatId: string, text: string | null): E2eePreparedSend {
    const clientMessageId = newUuid();
    const envelope = makeEnvelope(
      chatId,
      options.deviceId(),
      snapshot.peerDeviceIds[0] ?? b64(16, 9),
      counter++,
    );
    return {
      kind,
      chatId,
      clientMessageId,
      localMessageId: newUuid(),
      idempotencyKey: newUuid(),
      sessionId: b64(16, 1),
      sessionIds: [b64(16, 1)],
      text,
      replyToId: null,
      retryOfClientMessageId: null,
      envelopes: [envelope],
      coverage: {
        devices: 1,
        covered: 1,
        peerDevices: 1,
        peerCovered: 1,
        selfDevices: 0,
        selfCovered: 0,
        uncoveredDeviceIds: [],
      },
      coverageWarning: null,
      otpExhausted: false,
      createdAt: Date.now(),
    };
  }

  const bridge: FakeBridge = {
    enabled: true,
    resetRateLimiter,
    sends,
    resets,
    sentConfirmations,
    accepted,
    verifications,
    finishedResets,
    reuseRequests,
    confirmedManaged,
    outgoing,
    savedRetries,
    localCopies,
    incomingLocalCopies,
    receiveQueue,
    resetOutcome: null,

    async initialize(input) {
      return {
        userId: input.userId,
        deviceId: options.deviceId(),
        keyGeneration: 1,
        fingerprint: b64(32, 4),
      };
    },

    async loadChat(_input: E2eeChatInput) {
      return snapshot;
    },

    async sendText(input) {
      reuseRequests.push(input.reuseSessionIds);
      const result = prepared('text', input.chatId, input.text);
      sends.push({ kind: 'text', chatId: input.chatId, text: input.text });
      const retryOf = input.retryOfClientMessageId ?? null;
      if (retryOf !== null) {
        // Durable R-15 replacement survives a store "reload" because the same
        // fake bridge instance is reused by the second store in the test.
        outgoing.set(result.clientMessageId, {
          clientMessageId: result.clientMessageId,
          chatId: result.chatId,
          sessionId: result.sessionId,
          senderDeviceId: options.deviceId(),
          status: 'pending',
          createdAt: result.createdAt,
          updatedAt: result.createdAt,
          attempts: 0,
          lastErrorCode: null,
          serverMessageId: null,
          seq: null,
          warning: null,
          type: 'TEXT_JSON',
          idempotencyKey: result.idempotencyKey,
          envelopes: result.envelopes,
          recipientDeviceIds: [snapshot.peerDeviceIds[0] ?? b64(16, 9)],
          retryOfClientMessageId: retryOf,
          localMessageId: result.localMessageId,
          sendOrder: ++sendOrder,
          supersededAt: null,
          nextAttemptAt: null,
          lastAttemptAt: null,
        });
      }
      return { ...result, retryOfClientMessageId: retryOf };
    },

    async sendReset(input) {
      const result = prepared('reset', input.chatId, null);
      sends.push({ kind: 'reset', chatId: input.chatId, text: null });
      resets.push(input.reset);
      return result;
    },

    async receive(_chatId: string, message: E2eeIncomingMessage): Promise<E2eeReceiveOutcome> {
      const queued = receiveQueue.shift();
      if (queued) return queued;
      return {
        kind: 'message',
        localMessageId: newUuid(),
        sessionId: message.crypto.session_id,
        text: incomingText ?? 'расшифровано',
        replyToId: null,
      };
    },

    async lookupLocalCopy(chatId, clientMessageId) {
      return localCopies.get(`${chatId}:${clientMessageId}`) ?? null;
    },

    async lookupIncomingLocalCopy(chatId, senderDeviceId, clientMessageId, serverMessageId) {
      const copy =
        incomingLocalCopies.get(`${chatId}:${senderDeviceId}:${clientMessageId}`) ?? null;
      if (copy === null) return null;
      // P2-04: an old copy must not resolve a replayed client id under a new
      // server row when both ids are known.
      if (serverMessageId && copy.serverMessageId && copy.serverMessageId !== serverMessageId) {
        return null;
      }
      return copy;
    },

    async verifyDevice(chatId, targetDeviceId, method = 'MANUAL') {
      verifications.push({ chatId, deviceId: targetDeviceId, method });
      snapshot = {
        ...snapshot,
        devices: snapshot.devices.map((device) =>
          device.deviceId === targetDeviceId
            ? { ...device, verified: true, verificationMethod: method, verifiedAt: Date.now() }
            : device,
        ),
        loadedAt: Date.now(),
      };
      return {
        deviceId: targetDeviceId,
        verified: true,
        verifiedAt: Date.now(),
        method,
        keyGeneration: 1,
      };
    },

    async handleReset(input: {
      readonly chatId: string;
      readonly senderDeviceId: string;
      readonly reset: SessionResetBody;
    }) {
      if (!resetDeduplicator.markProcessed(input.reset)) {
        return { status: 'ignored', reason: 'duplicate' };
      }
      return bridge.resetOutcome ?? { status: 'ignored', reason: 'empty' };
    },

    async finishReset(input) {
      finishedResets.push({
        failedSessionId: input.failedSessionId,
        status: input.status,
      });
      // Mirrors the real bridge: a failed/partial batch unmarks the reset so
      // the explicit retry (or a duplicate control) can re-drive the window.
      if (input.status === 'failed') resetDeduplicator.forget(input.reset);
    },

    async acceptKeyChange(pinUserId, deviceId) {
      accepted.push({ userId: pinUserId, deviceId });
      snapshot = { ...snapshot, keyChanges: [] };
    },

    async confirmManagedMode(chatId) {
      confirmedManaged.push(chatId);
      snapshot = { ...snapshot, modeAction: 'allow_plaintext', securityMode: 'MANAGED' };
    },

    async loadOutgoing(clientMessageId) {
      return outgoing.get(clientMessageId) ?? null;
    },

    async confirmSent(clientMessageId, result) {
      sentConfirmations.push(clientMessageId);
      const entry = outgoing.get(clientMessageId);
      if (entry === undefined) return;
      outgoing.set(clientMessageId, {
        ...entry,
        status: 'sent',
        serverMessageId: result.serverMessageId,
        seq: result.seq,
        nextAttemptAt: null,
      });
      if (entry.retryOfClientMessageId !== null) {
        const original = outgoing.get(entry.retryOfClientMessageId);
        if (original !== undefined && original.supersededAt === null) {
          outgoing.set(original.clientMessageId, {
            ...original,
            status: original.status === 'sent' ? 'sent' : 'superseded',
            supersededAt: Date.now(),
            nextAttemptAt: null,
          });
        }
      }
    },

    async markAttempt(clientMessageId) {
      const entry = outgoing.get(clientMessageId);
      if (entry === undefined) return 0;
      const attempts = entry.attempts + 1;
      outgoing.set(clientMessageId, {
        ...entry,
        status: 'pending',
        attempts,
        lastAttemptAt: Date.now(),
        nextAttemptAt: null,
      });
      return attempts;
    },

    async markFailed(clientMessageId, code) {
      const entry = outgoing.get(clientMessageId);
      if (entry === undefined) return;
      outgoing.set(clientMessageId, {
        ...entry,
        status: 'failed',
        lastErrorCode: code,
        nextAttemptAt: Date.now() + 2_000,
      });
    },

    async markSuperseded(clientMessageId) {
      const entry = outgoing.get(clientMessageId);
      if (entry === undefined) return;
      outgoing.set(clientMessageId, {
        ...entry,
        status: entry.status === 'sent' ? 'sent' : 'superseded',
        supersededAt: entry.supersededAt ?? Date.now(),
        nextAttemptAt: null,
      });
    },

    async saveRetryState(input) {
      savedRetries.set(retryKey(input.chatId, input.reset.failedSessionId), {
        chatId: input.chatId,
        senderDeviceId: input.senderDeviceId,
        reset: input.reset,
      });
    },

    async clearRetryState(chatId, failedSessionId) {
      savedRetries.delete(retryKey(chatId, failedSessionId));
    },

    async reconcileRetryState(chatId): Promise<E2eeRetryReconcileResult> {
      for (const state of [...savedRetries.values()]) {
        if (chatId !== undefined && state.chatId !== chatId) continue;
        const rows = replacementEntries().filter(
          (entry) =>
            entry.chatId === state.chatId &&
            entry.retryOfClientMessageId === state.reset.retryOfClientMessageId,
        );
        if (rows.length === 0) continue;
        if (rows.every((entry) => entry.status === 'sent' || entry.status === 'superseded')) {
          savedRetries.delete(retryKey(state.chatId, state.reset.failedSessionId));
        }
      }
      return {
        statuses: statusesFor(chatId),
        completedFailedSessionIds: [],
        superseded: [],
      };
    },

    async drainOutbox(send, options = {}) {
      const sent: string[] = [];
      const failed: Array<{ clientMessageId: string; code: string }> = [];
      const now = options.now ?? Date.now();
      const candidates = replacementEntries().filter((entry) => {
        if (options.chatId !== undefined && entry.chatId !== options.chatId) return false;
        if (entry.status === 'sent' || entry.status === 'superseded') return false;
        if (entry.nextAttemptAt !== null && entry.nextAttemptAt > now && options.force !== true) {
          return false;
        }
        return true;
      });
      for (const entry of candidates) {
        try {
          const result = await send(entry);
          await bridge.confirmSent(entry.clientMessageId, result);
          sent.push(entry.clientMessageId);
        } catch (error) {
          const code =
            typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : 'NETWORK_ERROR';
          await bridge.markFailed(entry.clientMessageId, code);
          failed.push({ clientMessageId: entry.clientMessageId, code });
        }
      }
      const statuses = statusesFor(options.chatId);
      const nextAttemptAt = statuses.reduce<number | null>((next, status) => {
        if (status.nextAttemptAt === null) return next;
        return next === null ? status.nextAttemptAt : Math.min(next, status.nextAttemptAt);
      }, null);
      return { sent, failed, nextAttemptAt, skipped: 0 };
    },

    invalidateChat() {},

    setSnapshot(patch) {
      snapshot = { ...snapshot, ...patch, loadedAt: Date.now() };
    },

    setIncomingText(text) {
      incomingText = text;
    },
  };

  return bridge;
}

/**
 * Test-only E2EE bridge double for store/UI suites (E7-F5).
 *
 * It mimics the observable contract of `E2eeBridge` without crypto or storage;
 * the real crypto path is covered by `src/e2ee/app/chatBridge.test.ts`.
 */
import { encodeBase64Url } from '../e2ee/encoding/base64url';
import { newUuid } from '../lib/ids';
import { ResetDeduplicator, ResetRateLimiter } from '../e2ee/app/resetRetry';
import type { E2eeBridge, E2eeChatInput, E2eeIncomingMessage } from '../e2ee/app/chatBridge';
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
  const localCopies = new Map<string, E2eeLocalCopyView>();
  const incomingLocalCopies = new Map<string, E2eeLocalCopyView>();
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
      return { ...result, retryOfClientMessageId: input.retryOfClientMessageId ?? null };
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

    async confirmSent(clientMessageId) {
      sentConfirmations.push(clientMessageId);
    },

    async markFailed() {},

    async markSuperseded() {},

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

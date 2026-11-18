/**
 * Test-only fixtures for E7-F2 storage/session/outbox/lock tests.
 *
 * No production code imports this module. It builds structurally valid wire
 * envelopes and ratchet states so the stores can be exercised without the
 * E7-F4 send/receive implementation.
 */
import { encodeBase64Url } from '../encoding/base64url';
import { randomBytes } from '../crypto/random';
import { generateX25519KeyPair } from '../crypto/x25519';
import { kdfChainKey } from '../protocol/kdf';
import { E2EE_STORE_NAMES, type E2eeStorage } from '../storage/types';
import type { WireCryptoEnvelope } from '../api/deviceKeys';
import type { SessionState, SkippedMessageKey } from '../session/types';
import type { LocalCopyDraft, OutgoingMessageDraft } from '../outbox/outboxStore';
import type { BroadcastChannelLike, LockManagerLike, LockScheduler } from '../locks/locks';

export const IDS = {
  chat: '11111111-1111-4111-8111-111111111111',
  senderDevice: '22222222-2222-4222-8222-222222222222',
  recipientDevice: '33333333-3333-4333-8333-333333333333',
  peerUser: '44444444-4444-4444-8444-444444444444',
  localMessage: '55555555-5555-4555-8555-555555555555',
  clientMessage: '66666666-6666-4666-8666-666666666666',
  idempotency: '77777777-7777-4777-8777-777777777777',
  serverMessage: '88888888-8888-4888-8888-888888888888',
  device: '99999999-9999-4999-8999-999999999999',
  peerDevice2: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionB: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

export function bytes(length = 32, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

export function uniqueBytes(length = 32): Uint8Array {
  return randomBytes(length);
}

export function b64(bytesValue: Uint8Array): string {
  return encodeBase64Url(bytesValue);
}

export function testSessionId(fill = 1): string {
  return b64(new Uint8Array(16).fill(fill));
}

export function buildWireEnvelope(overrides: Partial<WireCryptoEnvelope> = {}): WireCryptoEnvelope {
  return {
    v: 1,
    scheme: 'PAIRWISE_X3DH_DR',
    chat_id: IDS.chat,
    sender_device_id: IDS.senderDevice,
    sender_key_generation: 1,
    recipient_device_id: IDS.recipientDevice,
    recipient_key_generation: 1,
    session_id: testSessionId(9),
    header: { v: 1, dh: b64(bytes(32, 3)), pn: 0, n: 0 },
    ciphertext: b64(new Uint8Array(272).fill(5)),
    ...overrides,
  };
}

export interface TestSessionOverrides {
  readonly sessionId?: string;
  readonly deviceId?: string;
  readonly chatId?: string;
  readonly peerUserId?: string;
  readonly peerDeviceId?: string;
  readonly ns?: number;
  readonly nr?: number;
  readonly pn?: number;
  readonly spkId?: string | null;
  readonly revision?: number;
  readonly createdAt?: number;
  readonly lastUsedAt?: number;
  readonly skipped?: readonly SkippedMessageKey[];
  readonly chainSend?: Uint8Array | null;
  readonly chainRecv?: Uint8Array | null;
  readonly dhRemote?: Uint8Array | null;
  readonly localCopyRef?: string | null;
}

export async function createTestSession(
  overrides: TestSessionOverrides = {},
): Promise<SessionState> {
  const dh = await generateX25519KeyPair();
  return {
    sessionId: overrides.sessionId ?? testSessionId(1),
    deviceId: overrides.deviceId ?? IDS.device,
    chatId: overrides.chatId ?? IDS.chat,
    peerUserId: overrides.peerUserId ?? IDS.peerUser,
    peerDeviceId: overrides.peerDeviceId ?? IDS.recipientDevice,
    peerIkSig: bytes(32, 11),
    peerIkDh: bytes(32, 12),
    rootKey: bytes(32, 13),
    dhPrivateKey: dh.privateKey,
    dhPublicKey: dh.publicKeyBytes,
    dhRemote: overrides.dhRemote ?? null,
    chainSend: overrides.chainSend === undefined ? bytes(32, 14) : overrides.chainSend,
    chainRecv: overrides.chainRecv ?? null,
    ns: overrides.ns ?? 0,
    nr: overrides.nr ?? 0,
    pn: overrides.pn ?? 0,
    spkId: overrides.spkId ?? null,
    skipped: overrides.skipped ?? [],
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    lastUsedAt: overrides.lastUsedAt ?? 1_700_000_000_000,
    localCopyRef: overrides.localCopyRef ?? null,
    revision: overrides.revision ?? 0,
  };
}

export function skippedKey(n: number, createdAt: number, fill = n + 1): SkippedMessageKey {
  return { dh: bytes(32, 21), n, messageKey: bytes(32, fill), createdAt };
}

export interface StorageDump {
  readonly [store: string]: Record<string, unknown>;
}

/** Flattens every record (used for "no old DHs / no plaintext" scans). */
export async function dumpStorage(storage: E2eeStorage): Promise<StorageDump> {
  const dump: Record<string, Record<string, unknown>> = {};
  for (const store of E2EE_STORE_NAMES) {
    const records: Record<string, unknown> = {};
    for (const key of await storage.keys(store)) {
      records[key] = await storage.get(store, key);
    }
    dump[store] = records;
  }
  return dump;
}

export function collectCryptoKeys(value: unknown, output: CryptoKey[] = []): CryptoKey[] {
  if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
    output.push(value);
    return output;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return output;
  if (Array.isArray(value)) {
    for (const entry of value) collectCryptoKeys(entry, output);
    return output;
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) collectCryptoKeys(entry, output);
  }
  return output;
}

export function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return output;
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, output);
    return output;
  }
  if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) collectStrings(entry, output);
  }
  return output;
}

/** Serialises a dump without touching CryptoKey internals. */
export function dumpText(dump: StorageDump): string {
  return collectStrings(dump).join('|');
}

/**
 * Cross-tab Web Locks stand-in: requests with the same name are queued; a
 * queued request aborts through the standard `AbortSignal` contract.
 */
export function createFakeWebLocks(): LockManagerLike & { readonly names: string[] } {
  const tails = new Map<string, Promise<unknown>>();
  const names: string[] = [];
  return {
    names,
    request<T>(
      name: string,
      options: { mode?: 'exclusive' | 'shared'; signal?: AbortSignal },
      callback: () => Promise<T>,
    ): Promise<T> {
      names.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      let cancelled = false;
      const run = previous.then(async () => {
        if (cancelled || options.signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }
        return callback();
      });
      tails.set(
        name,
        run.then(
          () => undefined,
          () => undefined,
        ),
      );
      if (!options.signal) return run;
      const aborted = new Promise<never>((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
      run.catch(() => undefined);
      return Promise.race([run, aborted]);
    },
  };
}

/**
 * In-memory BroadcastChannel bus. Messages are delivered asynchronously and
 * never echoed to the sender, matching the browser contract.
 */
export function createInMemoryChannelBus(): {
  factory: () => BroadcastChannelLike;
  broadcast: (message: unknown) => void;
  closeAll: () => void;
} {
  const listenersById = new Map<number, Set<(event: { data: unknown }) => void>>();
  let nextId = 1;
  let closed = false;

  const factory = (): BroadcastChannelLike => {
    const id = nextId;
    nextId += 1;
    const listeners = new Set<(event: { data: unknown }) => void>();
    listenersById.set(id, listeners);
    return {
      postMessage(message: unknown) {
        if (closed) return;
        const payload = typeof structuredClone === 'function' ? structuredClone(message) : message;
        setTimeout(() => {
          if (closed) return;
          for (const [otherId, otherListeners] of listenersById) {
            if (otherId === id) continue;
            for (const listener of otherListeners) listener({ data: payload });
          }
        }, 0);
      },
      addEventListener(_type, listener) {
        listeners.add(listener);
      },
      removeEventListener(_type, listener) {
        listeners.delete(listener);
      },
      close() {
        listenersById.delete(id);
      },
    };
  };

  return {
    factory,
    broadcast(message: unknown) {
      const payload = structuredClone(message);
      setTimeout(() => {
        if (closed) return;
        for (const listeners of listenersById.values()) {
          for (const listener of listeners) listener({ data: payload });
        }
      }, 0);
    },
    closeAll() {
      closed = true;
      listenersById.clear();
    },
  };
}

export function scopedEnvelope(session: SessionState): WireCryptoEnvelope {
  return buildWireEnvelope({
    chat_id: session.chatId,
    sender_device_id: session.deviceId,
    recipient_device_id: session.peerDeviceId,
    session_id: session.sessionId,
    header: {
      v: 1,
      dh: b64(session.dhPublicKey),
      pn: session.pn,
      n: session.ns > 0 ? session.ns - 1 : 0,
    },
  });
}

/**
 * Post-send draft for the store tests. E7-F5G requires the shift to be the real
 * `KDF_CK` step and carries the exact previous state so `prepareSessionRecord`
 * can prove the transition.
 */
export async function makeOutgoingDraft(
  session: SessionState,
  overrides: Partial<OutgoingMessageDraft> = {},
): Promise<OutgoingMessageDraft> {
  const step = session.chainSend === null ? null : await kdfChainKey(session.chainSend);
  const state = overrides.sessionState ?? {
    ...session,
    ns: session.ns + 1,
    chainSend: step === null ? null : new Uint8Array(step.nextChainKey),
  };
  return {
    chatId: state.chatId,
    sessionId: state.sessionId,
    clientMessageId: IDS.clientMessage,
    localMessageId: IDS.localMessage,
    type: 'TEXT_JSON',
    idempotencyKey: IDS.idempotency,
    envelopes: [scopedEnvelope(state)],
    retryOfClientMessageId: null,
    sessionState: state,
    previousSessionState: overrides.previousSessionState ?? session,
    text: 'hello E2EE',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function makeLocalCopyDraft(overrides: Partial<LocalCopyDraft> = {}): LocalCopyDraft {
  return {
    chatId: IDS.chat,
    sessionId: testSessionId(1),
    clientMessageId: IDS.clientMessage,
    localMessageId: IDS.localMessage,
    direction: 'outgoing',
    senderDeviceId: IDS.recipientDevice,
    contentType: 1,
    text: 'hello E2EE',
    ciphertexts: [buildWireEnvelope().ciphertext],
    replyToId: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

/**
 * Scheduler with a controllable clock and real timers. `advance()` moves
 * `now()` without running timers, which models a throttled background tab
 * whose renewal never fired (P1-06 lease expiry).
 */
export function createManualScheduler(): LockScheduler & {
  advance(ms: number): void;
} {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    advance(ms: number) {
      offset += ms;
    },
  };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

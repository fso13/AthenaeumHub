/**
 * E7-F5 store wire-up: flag off legacy, E2EE send/receive, mode/key-change
 * gating and R-15 orchestration through a bridge double + MSW managed API.
 *
 * The real crypto path is covered separately in `src/e2ee/app/chatBridge.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { getDeviceId } from '../auth/session';
import { insertMockMessage } from '../mocks/db';
import { IDS } from '../mocks/fixtures';
import { newUuid } from '../lib/ids';
import { mockDb } from '../test/server';
import { createTestConfig, createTestStore } from '../test/renderApp';
import { createFakeE2eeBridge, makeEnvelope, type FakeBridge } from '../test/e2eeBridgeFake';
import type { E2eeChatSnapshot } from '../e2ee/app/types';
import { E2eeError } from '../e2ee/errors';
import type { SessionResetBody } from '../e2ee/session/reset';
import type { ChatStore } from './chatStore';

const CHAT = IDS.groupChat;
const PEER_DEVICE = '55555555-5555-4555-8555-555555555555';
const PEER_USER = '22222222-2222-4222-8222-222222222222';

const BASE_SNAPSHOT: Partial<E2eeChatSnapshot> = {
  chatId: CHAT,
  securityMode: 'E2EE',
  modeAction: 'allow_e2ee',
  selfDeviceId: '33333333-3333-4333-8333-333333333333',
  peerDeviceIds: [PEER_DEVICE],
  devices: [
    {
      userId: PEER_USER,
      deviceId: PEER_DEVICE,
      fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      isSelf: false,
      verified: false,
      status: 'ACTIVE',
    },
  ],
  safetyNumbers: [
    {
      userId: PEER_USER,
      deviceId: PEER_DEVICE,
      display: '00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000 00000',
      qrPayload: 'krug://verify/v1?dev1=a&fp1=b&dev2=c&fp2=d',
    },
  ],
};

async function waitFor(check: () => boolean, timeout = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function setup(
  snapshot: Partial<E2eeChatSnapshot> = {},
  options: { readonly serverMode?: 'E2EE' | 'MANAGED' } = {},
): { store: ChatStore; bridge: ReturnType<typeof createFakeE2eeBridge> } {
  mockDb.chats[CHAT]!.summary.security_mode = options.serverMode ?? 'E2EE';
  const bridge = createFakeE2eeBridge({
    deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
    snapshot: { ...BASE_SNAPSHOT, ...snapshot },
  });
  const store = createTestStore(createTestConfig(), { enabled: true, bridge });
  return { store, bridge };
}

async function bootstrapped(
  snapshot: Partial<E2eeChatSnapshot> = {},
  options: { readonly serverMode?: 'E2EE' | 'MANAGED' } = {},
  beforeBootstrap?: (bridge: ReturnType<typeof createFakeE2eeBridge>) => void,
): Promise<{ store: ChatStore; bridge: ReturnType<typeof createFakeE2eeBridge> }> {
  const created = setup(snapshot, options);
  beforeBootstrap?.(created.bridge);
  await created.store.bootstrap();
  await waitFor(() => created.store.getSnapshot().slices[CHAT]?.status === 'ready');
  await waitFor(() => created.store.getSnapshot().e2ee.chats[CHAT]?.status === 'ready');
  return created;
}

describe('flagged-off legacy behaviour', () => {
  it('keeps sending managed plaintext and never touches the E2EE bridge', async () => {
    const store = createTestStore(createTestConfig());
    await store.bootstrap();
    await waitFor(() => store.getSnapshot().slices[CHAT]?.status === 'ready');

    const text = 'обычный текст';
    await store.send(CHAT, text);
    await waitFor(() => mockDb.sendAttempts.length === 1);

    expect(mockDb.sendBodies[0]?.text).toBe(text);
    expect(mockDb.sendBodies[0]?.envelopes).toBeUndefined();
    expect(store.getSnapshot().e2ee.enabled).toBe(false);
  });

  it('blocks a server-declared E2EE chat when the flag is off (no plaintext fallback)', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const store = createTestStore(createTestConfig());
    await store.bootstrap();
    await waitFor(() => store.getSnapshot().slices[CHAT]?.status === 'ready');

    await store.send(CHAT, 'не должно уйти');
    expect(store.e2eeBlockReason(CHAT)).toBe('flag_disabled');
    expect(mockDb.sendAttempts).toHaveLength(0);
  });
});

describe('E2EE send and receive', () => {
  it('sends only envelopes (no plaintext) and keeps a decrypted local view', async () => {
    const { store, bridge } = await bootstrapped();

    await store.send(CHAT, 'секрет');
    await waitFor(() => mockDb.sendAttempts.length === 1);
    await waitFor(() => bridge.sentConfirmations.length === 1);

    const body = mockDb.sendBodies[0]!;
    expect(body.text).toBeUndefined();
    expect(body.envelopes).toHaveLength(1);
    expect(body.client_message_id).toBe(bridge.sentConfirmations[0]);

    const slice = store.getSnapshot().slices[CHAT]!;
    const sent = slice.messages.find(
      (message) => message.client_message_id === body.client_message_id,
    );
    expect(sent).toBeDefined();
    expect(slice.e2ee[sent!.id]?.text).toBe('секрет');
    expect(slice.outbox).toHaveLength(0);
  });

  it('decrypts an incoming envelope and never renders server plaintext', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'подмена сервера');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store } = await bootstrapped({}, {}, (fake) => fake.setIncomingText('настоящий текст'));

    await waitFor(() => {
      const view = store.getSnapshot().slices[CHAT]?.e2ee[incoming.id];
      return view?.status === 'decrypted';
    });
    const view = store.getSnapshot().slices[CHAT]!.e2ee[incoming.id]!;
    expect(view.text).toBe('настоящий текст');
  });

  it('restores an already received message from its sealed incoming copy after reload', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'x');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store } = await bootstrapped({}, {}, (fake) => {
      // A reload re-runs receive() on history, which the ratchet rejects as a
      // duplicate; the store must fall back to the incoming local copy.
      fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${incoming.client_message_id}`, {
        text: 'текст из копии',
        replyToId: null,
      });
      fake.receiveQueue.push({ kind: 'none' });
    });

    await waitFor(() => {
      const view = store.getSnapshot().slices[CHAT]?.e2ee[incoming.id];
      return view?.status === 'decrypted';
    });
    expect(store.getSnapshot().slices[CHAT]!.e2ee[incoming.id]!.text).toBe('текст из копии');
  });

  it('never renders a restored SESSION_RESET control copy as a message', async () => {
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store } = await bootstrapped({}, {}, (fake) => {
      fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${control.client_message_id}`, {
        text: null,
        replyToId: null,
        contentType: 2,
      });
      fake.receiveQueue.push({ kind: 'none' });
    });

    await waitFor(() => {
      const view = store.getSnapshot().slices[CHAT]?.e2ee[control.id];
      return view?.status === 'control';
    });
    expect(store.getSnapshot().slices[CHAT]!.e2ee[control.id]!.text).toBeNull();
  });

  it('restores history from the incoming copy after the session was deleted (NO_SESSION, no reset)', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'x');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${incoming.client_message_id}`, {
        text: 'история из копии',
        replyToId: null,
        serverMessageId: incoming.id,
      });
      // The session that decrypted this row is gone (R-15 finish/loser delete).
      fake.receiveQueue.push({
        kind: 'error',
        code: 'NO_SESSION',
        reset: {
          failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
          failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
          failedN: 0,
          reason: 'NO_SESSION',
          retryOfClientMessageId: incoming.client_message_id ?? null,
        },
        reason: 'NO_SESSION',
      });
    });

    await waitFor(() => {
      const view = store.getSnapshot().slices[CHAT]?.e2ee[incoming.id];
      return view?.status === 'decrypted';
    });
    expect(store.getSnapshot().slices[CHAT]!.e2ee[incoming.id]!.text).toBe('история из копии');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.resets).toHaveLength(0);
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('restores a prekey history row on KEY_HANDSHAKE_INVALID without a spurious reset', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'x');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${incoming.client_message_id}`, {
        text: 'prekey история',
        replyToId: null,
      });
      fake.receiveQueue.push({
        kind: 'error',
        code: 'KEY_HANDSHAKE_INVALID',
        reset: {
          failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
          failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
          failedN: 0,
          reason: 'KEY_HANDSHAKE_INVALID',
          retryOfClientMessageId: null,
        },
        reason: 'KEY_HANDSHAKE_INVALID',
      });
    });

    await waitFor(
      () => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'decrypted',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.resets).toHaveLength(0);
  });

  it('shows a restored control copy as control on the error path (never a bubble)', async () => {
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${control.client_message_id}`, {
        text: null,
        replyToId: null,
        contentType: 2,
      });
      fake.receiveQueue.push({
        kind: 'error',
        code: 'NO_SESSION',
        reset: {
          failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
          failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
          failedN: 0,
          reason: 'NO_SESSION',
          retryOfClientMessageId: null,
        },
        reason: 'NO_SESSION',
      });
    });

    await waitFor(() => store.getSnapshot().slices[CHAT]?.e2ee[control.id]?.status === 'control');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.resets).toHaveLength(0);
  });

  it('does not resolve a copy under a different server message id (P2-04 replay)', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'x');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store } = await bootstrapped({}, {}, (fake) => {
      fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${incoming.client_message_id}`, {
        text: 'старый текст',
        replyToId: null,
        // The server replayed an old client id under a new row.
        serverMessageId: '99999999-9999-4999-8999-999999999999',
      });
      fake.receiveQueue.push({ kind: 'none' });
    });

    await waitFor(
      () => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'unavailable',
    );
  });

  it('restores a superseded outgoing copy as superseded after reload', async () => {
    const own = insertMockMessage(mockDb, CHAT, 'x');
    own.text = null;
    own.client_message_id = newUuid();
    own.sender_id = mockDb.me?.user.id ?? own.sender_id;

    const { store } = await bootstrapped({}, {}, (fake) => {
      fake.localCopies.set(`${CHAT}:${own.client_message_id}`, {
        text: 'переотправлено',
        replyToId: null,
        status: 'superseded',
      });
    });

    await waitFor(() => store.getSnapshot().slices[CHAT]?.e2ee[own.id]?.status === 'superseded');
  });

  it('marks an E2EE message without a local copy as unavailable', async () => {
    const own = insertMockMessage(mockDb, CHAT, 'x');
    own.text = null;
    own.client_message_id = newUuid();
    own.sender_id = mockDb.me?.user.id ?? own.sender_id;

    const { store } = await bootstrapped();
    await waitFor(() => store.getSnapshot().slices[CHAT]?.e2ee[own.id] !== undefined);
    expect(store.getSnapshot().slices[CHAT]!.e2ee[own.id]!.status).toBe('unavailable');
  });
});

describe('P1-02 verification', () => {
  it('attests through the bridge and shows the server-scoped verified state', async () => {
    const { store, bridge } = await bootstrapped();
    const chat = () => store.getSnapshot().e2ee.chats[CHAT]!;
    expect(chat().devices[0]!.verified).toBe(false);

    const ok = await store.verifyE2eeDevice(CHAT, PEER_DEVICE, 'MANUAL');
    expect(ok).toBe(true);
    expect(bridge.verifications).toEqual([
      { chatId: CHAT, deviceId: PEER_DEVICE, method: 'MANUAL' },
    ]);
    await waitFor(() => chat().devices[0]!.verified === true);
    expect(chat().devices[0]!.verificationMethod).toBe('MANUAL');
    expect(chat().verificationError).toBeNull();
  });

  it('never fakes verified when the attestation fails', async () => {
    const { store, bridge } = await bootstrapped();
    bridge.verifyDevice = async () => {
      throw new E2eeError('VERIFICATION_FAILED', 'server rejected the attestation');
    };
    const ok = await store.verifyE2eeDevice(CHAT, PEER_DEVICE);
    expect(ok).toBe(false);
    const chat = store.getSnapshot().e2ee.chats[CHAT]!;
    expect(chat.devices[0]!.verified).toBe(false);
    expect(chat.verificationError).toBe('VERIFICATION_FAILED');
  });

  it('refuses to verify while a key change is unaccepted', async () => {
    const { store, bridge } = await bootstrapped({
      keyChanges: [
        {
          userId: PEER_USER,
          deviceId: PEER_DEVICE,
          pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          detectedAt: 1,
        },
      ],
    });
    const ok = await store.verifyE2eeDevice(CHAT, PEER_DEVICE);
    expect(ok).toBe(false);
    expect(bridge.verifications).toHaveLength(0);
    expect(store.getSnapshot().e2ee.chats[CHAT]!.verificationError).toBe('KEY_CHANGE_DETECTED');
  });
});

describe('E2EE mode and key-change gating', () => {
  it('blocks send on a key change until the user accepts the observed key', async () => {
    const { store, bridge } = await bootstrapped({
      keyChanges: [
        {
          userId: PEER_USER,
          deviceId: PEER_DEVICE,
          pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
          detectedAt: 1,
        },
      ],
    });

    expect(store.e2eeBlockReason(CHAT)).toBe('key_change');
    await store.send(CHAT, 'blocked');
    expect(mockDb.sendAttempts).toHaveLength(0);

    await store.acceptKeyChange(CHAT, PEER_USER, PEER_DEVICE);
    expect(bridge.accepted).toEqual([{ userId: PEER_USER, deviceId: PEER_DEVICE }]);
    await waitFor(() => store.e2eeBlockReason(CHAT) === null);

    await store.send(CHAT, 'после принятия');
    await waitFor(() => mockDb.sendAttempts.length === 1);
  });

  it('keeps already decrypted history visible while a key change blocks new rows', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'старое');
    incoming.text = null;
    const clientMessageId = newUuid();
    incoming.client_message_id = clientMessageId;
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store } = await bootstrapped(
      {
        keyChanges: [
          {
            userId: PEER_USER,
            deviceId: PEER_DEVICE,
            pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            detectedAt: 1,
          },
        ],
      },
      {},
      (fake) => {
        // The row was decrypted before the key change; its sealed incoming copy
        // is authoritative local history (§7.5 "старые сообщения остаются").
        fake.incomingLocalCopies.set(`${CHAT}:${PEER_DEVICE}:${clientMessageId}`, {
          text: 'старое сообщение',
          replyToId: null,
          status: 'received',
        });
        // A new row under the changed key cannot be decrypted until accept.
        fake.receiveQueue.push({
          kind: 'error',
          code: 'KEY_CHANGE_DETECTED',
          reset: null,
          reason: null,
        });
      },
    );

    await waitFor(
      () => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'decrypted',
    );
    expect(store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.text).toBe('старое сообщение');
    expect(store.e2eeBlockReason(CHAT)).toBe('key_change');
  });

  it('re-decrypts messages that failed while the key-change warning was active', async () => {
    const incoming = insertMockMessage(mockDb, CHAT, 'подмена');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped(
      {
        keyChanges: [
          {
            userId: PEER_USER,
            deviceId: PEER_DEVICE,
            pinnedFingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            observedFingerprint: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            detectedAt: 1,
          },
        ],
      },
      {},
      (fake) => {
        fake.receiveQueue.push({
          kind: 'error',
          code: 'KEY_CHANGE_DETECTED',
          reset: null,
          reason: null,
        });
      },
    );

    await waitFor(() => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'error');
    expect(store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.code).toBe('KEY_CHANGE_DETECTED');

    await store.acceptKeyChange(CHAT, PEER_USER, PEER_DEVICE);
    await waitFor(
      () => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'decrypted',
    );
    expect(store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.text).toBe('расшифровано');
    expect(bridge.accepted).toEqual([{ userId: PEER_USER, deviceId: PEER_DEVICE }]);
  });

  it('blocks a MANAGED downgrade with E2EE evidence and never confirms it', async () => {
    const { store, bridge } = await bootstrapped(
      {
        securityMode: 'MANAGED',
        modeAction: 'block_security_alert',
        evidence: ['peer_has_e2ee_capable_devices'],
        peerDeviceIds: [PEER_DEVICE],
      },
      { serverMode: 'MANAGED' },
    );

    expect(store.e2eeBlockReason(CHAT)).toBe('mode_alert');
    await store.send(CHAT, 'plaintext?');
    await store.confirmManagedMode(CHAT);
    expect(bridge.confirmedManaged).toHaveLength(0);
    expect(mockDb.sendAttempts).toHaveLength(0);
  });

  it('requires explicit confirmation for a fresh-device managed chat', async () => {
    const { store, bridge } = await bootstrapped(
      { securityMode: 'MANAGED', modeAction: 'confirm_mode_required', evidence: [] },
      { serverMode: 'MANAGED' },
    );

    expect(store.e2eeBlockReason(CHAT)).toBe('mode_confirm_required');
    await store.send(CHAT, 'до подтверждения');
    expect(mockDb.sendAttempts).toHaveLength(0);

    await store.confirmManagedMode(CHAT);
    expect(bridge.confirmedManaged).toEqual([CHAT]);
    await waitFor(() => store.e2eeBlockReason(CHAT) === null);
    await store.send(CHAT, 'после подтверждения');
    await waitFor(() => mockDb.sendAttempts.length === 1);
    expect(mockDb.sendBodies[0]?.text).toBe('после подтверждения');
  });
});

describe('P1-03 sync/resume catch-up', () => {
  const missedReset: SessionResetBody = {
    failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
    failedN: 0,
    reason: 'NO_SESSION',
    retryOfClientMessageId: '88888888-8888-4888-8888-888888888888',
  };

  it('decrypts E2EE messages and processes a SESSION_RESET merged by /sync', async () => {
    const { store, bridge } = await bootstrapped();
    const incoming = insertMockMessage(mockDb, CHAT, 'x');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    bridge.receiveQueue.push(
      {
        kind: 'message',
        localMessageId: newUuid(),
        sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        text: 'пришло через sync',
        replyToId: null,
      },
      {
        kind: 'control',
        sessionId: missedReset.failedSessionId,
        reset: missedReset,
        senderDeviceId: PEER_DEVICE,
      },
    );
    bridge.resetOutcome = {
      status: 'pending',
      failedSessionId: missedReset.failedSessionId,
      candidates: [
        {
          originalClientMessageId: missedReset.retryOfClientMessageId as string,
          originalServerMessageId: null,
          text: 'переотправлено после sync',
          replyToId: null,
        },
      ],
      remaining: 0,
      skipped: 0,
    };

    await store.sync();

    await waitFor(
      () => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'decrypted',
    );
    expect(store.getSnapshot().slices[CHAT]!.e2ee[incoming.id]!.text).toBe('пришло через sync');
    await waitFor(() => mockDb.sendAttempts.length === 1);
    expect(store.getSnapshot().slices[CHAT]!.e2ee[control.id]?.status).toBe('control');
    expect(bridge.sends[0]?.text).toBe('переотправлено после sync');
  });

  it('does not re-decrypt or duplicate a message that was already merged', async () => {
    const { store, bridge } = await bootstrapped();
    const incoming = insertMockMessage(mockDb, CHAT, 'x');
    incoming.text = null;
    incoming.client_message_id = newUuid();
    incoming.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);
    bridge.receiveQueue.push({
      kind: 'message',
      localMessageId: newUuid(),
      sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      text: 'один раз',
      replyToId: null,
    });

    await store.sync();
    await waitFor(
      () => store.getSnapshot().slices[CHAT]?.e2ee[incoming.id]?.status === 'decrypted',
    );
    await store.sync();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      store.getSnapshot().slices[CHAT]!.messages.filter((item) => item.id === incoming.id),
    ).toHaveLength(1);
    // The view is keyed by message id, so a second pass never re-renders it.
    expect(store.getSnapshot().slices[CHAT]!.e2ee[incoming.id]!.text).toBe('один раз');
  });
});

describe('R-15 orchestration', () => {
  const resetBody: SessionResetBody = {
    failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
    failedN: 0,
    reason: 'DECRYPT_FAILED',
    retryOfClientMessageId: '88888888-8888-4888-8888-888888888888',
  };

  it('auto-sends one invisible SESSION_RESET for a failed envelope', async () => {
    const failed = insertMockMessage(mockDb, CHAT, 'x');
    failed.text = null;
    failed.client_message_id = newUuid();
    failed.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.receiveQueue.push({
        kind: 'error',
        code: 'DECRYPT_FAILED',
        reset: resetBody,
        reason: 'DECRYPT_FAILED',
      });
    });

    await waitFor(() => bridge.resets.length === 1);
    await waitFor(() => mockDb.sendAttempts.length === 1);
    expect(bridge.resets[0]?.failedSessionId).toBe(resetBody.failedSessionId);
    expect(mockDb.sendBodies[0]?.text).toBeUndefined();
    expect(mockDb.sendBodies[0]?.envelopes).toHaveLength(1);
    expect(store.getSnapshot().slices[CHAT]!.e2ee[failed.id]?.status).toBe('error');

    // A duplicate failure in the same failed session is suppressed by the
    // in-memory limiter; the limiter itself is unit-tested in resetRetry.test.
    expect(bridge.resets).toHaveLength(1);
  });

  it('re-encrypts the retry window after an incoming reset and hides the control row', async () => {
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.receiveQueue.push({
        kind: 'control',
        sessionId: resetBody.failedSessionId,
        reset: resetBody,
        senderDeviceId: PEER_DEVICE,
      });
      fake.resetOutcome = {
        status: 'pending',
        failedSessionId: resetBody.failedSessionId,
        candidates: [
          {
            originalClientMessageId: resetBody.retryOfClientMessageId as string,
            originalServerMessageId: null,
            text: 'переотправлено',
            replyToId: null,
          },
        ],
        remaining: 0,
        skipped: 0,
      };
    });

    await waitFor(() => mockDb.sendAttempts.length === 1);
    expect(bridge.sends[0]?.text).toBe('переотправлено');
    expect(mockDb.sendBodies[0]?.text).toBeUndefined();
    expect(store.getSnapshot().slices[CHAT]!.e2ee[control.id]?.status).toBe('control');
    expect(bridge.sentConfirmations).toHaveLength(1);
  });

  it('does not duplicate the retry when the same reset arrives twice', async () => {
    const first = insertMockMessage(mockDb, CHAT, 'x');
    first.text = null;
    first.client_message_id = newUuid();
    first.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);
    const second = insertMockMessage(mockDb, CHAT, 'x');
    second.text = null;
    second.client_message_id = newUuid();
    second.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.receiveQueue.push({
        kind: 'control',
        sessionId: resetBody.failedSessionId,
        reset: resetBody,
        senderDeviceId: PEER_DEVICE,
      });
      fake.receiveQueue.push({
        kind: 'control',
        sessionId: resetBody.failedSessionId,
        reset: resetBody,
        senderDeviceId: PEER_DEVICE,
      });
      fake.resetOutcome = {
        status: 'pending',
        failedSessionId: resetBody.failedSessionId,
        candidates: [
          {
            originalClientMessageId: resetBody.retryOfClientMessageId as string,
            originalServerMessageId: null,
            text: 'ровно один повтор',
            replyToId: null,
          },
        ],
        remaining: 0,
        skipped: 0,
      };
    });

    await waitFor(
      () =>
        store.getSnapshot().slices[CHAT]!.e2ee[first.id]?.status === 'control' &&
        store.getSnapshot().slices[CHAT]!.e2ee[second.id]?.status === 'control',
    );
    await waitFor(() => mockDb.sendAttempts.length === 1);
    // Give the second control a turn before asserting that nothing else fired.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockDb.sendAttempts).toHaveLength(1);
    expect(bridge.sends).toHaveLength(1);
    expect(store.getSnapshot().e2ee.chats[CHAT]?.retryPendingCount).toBe(0);
  });

  it('reuses the fresh retry session and completes the reset after the batch', async () => {
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.receiveQueue.push({
        kind: 'control',
        sessionId: resetBody.failedSessionId,
        reset: resetBody,
        senderDeviceId: PEER_DEVICE,
      });
      fake.resetOutcome = {
        status: 'pending',
        failedSessionId: resetBody.failedSessionId,
        candidates: [
          {
            originalClientMessageId: resetBody.retryOfClientMessageId as string,
            originalServerMessageId: null,
            text: 'первое',
            replyToId: null,
          },
          {
            originalClientMessageId: newUuid(),
            originalServerMessageId: null,
            text: 'второе',
            replyToId: null,
          },
        ],
        remaining: 0,
        skipped: 0,
      };
    });

    await waitFor(() => mockDb.sendAttempts.length === 2);
    await waitFor(() => bridge.finishedResets.length === 1);
    expect(bridge.reuseRequests[0]).toBeUndefined();
    expect(bridge.reuseRequests[1]).toBeDefined();
    expect(bridge.reuseRequests[1]?.length).toBe(1);
    expect(bridge.finishedResets[0]).toEqual({
      failedSessionId: resetBody.failedSessionId,
      status: 'completed',
    });
    expect(store.getSnapshot().e2ee.chats[CHAT]?.retryPendingCount).toBe(0);
  });

  it('does not swallow a reset when the retry batch fails, and the explicit retry completes it', async () => {
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    let normalSend: FakeBridge['sendText'] | null = null;
    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.receiveQueue.push({
        kind: 'control',
        sessionId: resetBody.failedSessionId,
        reset: resetBody,
        senderDeviceId: PEER_DEVICE,
      });
      fake.resetOutcome = {
        status: 'pending',
        failedSessionId: resetBody.failedSessionId,
        candidates: [
          {
            originalClientMessageId: resetBody.retryOfClientMessageId as string,
            originalServerMessageId: null,
            text: 'не отправится',
            replyToId: null,
          },
        ],
        remaining: 0,
        skipped: 0,
      };
      normalSend = fake.sendText.bind(fake);
      fake.sendText = async () => {
        throw new Error('retry batch failed');
      };
    });

    await waitFor(() => bridge.finishedResets.length === 1);
    expect(bridge.finishedResets[0]).toEqual({
      failedSessionId: resetBody.failedSessionId,
      status: 'failed',
    });
    await waitFor(() => store.getSnapshot().e2ee.chats[CHAT]?.retryPendingCount === 1);
    expect(store.getSnapshot().e2ee.chats[CHAT]?.resetProgress).toMatchObject({
      status: 'failed',
      failed: 1,
      remaining: 0,
    });

    bridge.sendText = normalSend!;
    await store.retryPendingReset(CHAT);
    await waitFor(() => bridge.finishedResets.length === 2);
    expect(bridge.finishedResets[1]).toEqual({
      failedSessionId: resetBody.failedSessionId,
      status: 'completed',
    });
    expect(store.getSnapshot().e2ee.chats[CHAT]?.retryPendingCount).toBe(0);
    expect(store.getSnapshot().e2ee.chats[CHAT]?.resetProgress).toMatchObject({
      status: 'completed',
      done: 1,
      failed: 0,
      remaining: 0,
    });
  });

  it('does not re-encrypt when the reset anchor is unknown (no wide retry)', async () => {
    const control = insertMockMessage(mockDb, CHAT, 'x');
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);

    const { store, bridge } = await bootstrapped({}, {}, (fake) => {
      fake.receiveQueue.push({
        kind: 'control',
        sessionId: resetBody.failedSessionId,
        reset: resetBody,
        senderDeviceId: PEER_DEVICE,
      });
      fake.resetOutcome = { status: 'ignored', reason: 'anchor_unknown' };
    });

    await waitFor(() => store.getSnapshot().slices[CHAT]!.e2ee[control.id]?.status === 'control');
    expect(bridge.sends).toHaveLength(0);
    expect(mockDb.sendAttempts).toHaveLength(0);
  });
});

describe('G4e #30 durable retry after reload', () => {
  const resetBody: SessionResetBody = {
    failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
    failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
    failedN: 0,
    reason: 'DECRYPT_FAILED',
    retryOfClientMessageId: '88888888-8888-4888-8888-888888888888',
  };

  it('restores retry_pending and the pending replacement after a page reload', async () => {
    mockDb.chats[CHAT]!.summary.security_mode = 'E2EE';
    const bridge = createFakeE2eeBridge({
      deviceId: () => getDeviceId() ?? '33333333-3333-4333-8333-333333333333',
      snapshot: BASE_SNAPSHOT,
    });
    const controlId = insertMockMessage(mockDb, CHAT, 'x').id;
    const control = mockDb.chats[CHAT]!.messages.find((message) => message.id === controlId)!;
    control.text = null;
    control.client_message_id = newUuid();
    control.crypto = makeEnvelope(CHAT, PEER_DEVICE, BASE_SNAPSHOT.selfDeviceId as string);
    bridge.receiveQueue.push({
      kind: 'control',
      sessionId: resetBody.failedSessionId,
      reset: resetBody,
      senderDeviceId: PEER_DEVICE,
    });
    bridge.resetOutcome = {
      status: 'pending',
      failedSessionId: resetBody.failedSessionId,
      candidates: [
        {
          originalClientMessageId: resetBody.retryOfClientMessageId as string,
          originalServerMessageId: null,
          text: 'первое',
          replyToId: null,
        },
      ],
      remaining: 0,
      skipped: 0,
    };

    // The replacement is committed durably, but the POST fails (ambiguous
    // server/network outcome). No in-memory retry may be needed after reload.
    mockDb.failNextSend = 1;
    const first = createTestStore(createTestConfig(), { enabled: true, bridge });
    await first.bootstrap();
    await waitFor(() => first.getSnapshot().slices[CHAT]?.status === 'ready');
    await waitFor(() => first.getSnapshot().e2ee.chats[CHAT]?.status === 'ready');
    await waitFor(() => bridge.finishedResets.length === 1);
    await waitFor(() => first.getSnapshot().e2ee.chats[CHAT]?.retryPendingCount === 1);
    expect(bridge.finishedResets[0]).toEqual({
      failedSessionId: resetBody.failedSessionId,
      status: 'failed',
    });
    const pending = [...bridge.outgoing.values()].filter(
      (entry) => entry.status === 'pending' || entry.status === 'failed',
    );
    expect(pending).toHaveLength(1);
    const replacementId = pending[0]!.clientMessageId;
    first.reset();

    // Reload: a brand-new store with the same durable bridge/outbox state.
    const second = createTestStore(createTestConfig(), { enabled: true, bridge });
    await second.bootstrap();
    await waitFor(() => second.getSnapshot().slices[CHAT]?.status === 'ready');
    await waitFor(() => second.getSnapshot().e2ee.chats[CHAT]?.status === 'ready');
    await waitFor(() => second.getSnapshot().e2ee.chats[CHAT]?.retryPendingCount === 1);
    expect(second.getSnapshot().e2ee.chats[CHAT]?.resetProgress).toMatchObject({
      status: 'failed',
    });
    // Exactly the same durable replacement survived; it was not re-encrypted.
    expect([...bridge.outgoing.keys()].filter((id) => id === replacementId)).toHaveLength(1);
    expect(bridge.sends.filter((send) => send.text === 'первое')).toHaveLength(1);
  });
});

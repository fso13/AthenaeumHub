import { describe, expect, it } from 'vitest';
import { encodeBase64Url } from '../encoding/base64url';
import { sendE2eeMessage } from '../session/send';
import {
  SESSION_IDS,
  claimBundleFromWorld,
  createTestWorld,
  recipientPlan,
} from '../test/sessionFixtures';
import {
  MAX_RESET_BATCH,
  ResetDeduplicator,
  ResetRateLimiter,
  buildReceiverReset,
  isResetErrorCode,
  resetFingerprint,
  resetReasonForCode,
  selectRetryWindow,
  selectRetryWindowEntries,
} from './resetRetry';
import type { SessionResetBody } from '../session/reset';
import { localCopyStorageKey, markOutboxSent, markOutboxSuperseded } from '../outbox/outboxStore';
import type { OutboxEntry, StoredLocalMessageCopy } from '../outbox/types';

describe('R-15 receiver helpers', () => {
  it('maps only the documented failure codes to reset reasons', () => {
    expect(resetReasonForCode('SPK_DELETED')).toBe('SPK_DELETED');
    expect(resetReasonForCode('DECRYPT_FAILED')).toBe('DECRYPT_FAILED');
    expect(resetReasonForCode('KEY_HANDSHAKE_INVALID')).toBe('KEY_HANDSHAKE_INVALID');
    expect(resetReasonForCode('NO_SESSION')).toBe('NO_SESSION');
    expect(resetReasonForCode('UNKNOWN_SPK')).toBe('UNKNOWN_SPK');
    expect(resetReasonForCode('KEY_CHANGE_DETECTED')).toBeNull();
    expect(resetReasonForCode('DUPLICATE_OR_OLD_MESSAGE')).toBeNull();
    expect(isResetErrorCode('DUPLICATE_OR_OLD_MESSAGE')).toBe(false);
  });

  it('builds the body from the failed envelope and the echoed client id', () => {
    const body = buildReceiverReset({
      envelope: {
        session_id: encodeBase64Url(new Uint8Array(16).fill(1)),
        header: { v: 1, dh: encodeBase64Url(new Uint8Array(32).fill(2)), pn: 0, n: 7 },
      },
      clientMessageId: '88888888-8888-4888-8888-888888888888',
      reason: 'DECRYPT_FAILED',
    });
    expect(body.failedN).toBe(7);
    expect(body.failedSessionId).toBe(encodeBase64Url(new Uint8Array(16).fill(1)));
    expect(body.retryOfClientMessageId).toBe('88888888-8888-4888-8888-888888888888');
    expect(body.reason).toBe('DECRYPT_FAILED');
  });

  it('allows at most one reset per failed session per 300 s', () => {
    let clock = 1_000;
    const limiter = new ResetRateLimiter(() => clock);
    expect(limiter.allow('s1')).toBe(true);
    expect(limiter.allow('s1')).toBe(false);
    expect(limiter.allow('s2')).toBe(true);
    clock += 299_999;
    expect(limiter.allow('s1')).toBe(false);
    clock += 1;
    expect(limiter.allow('s1')).toBe(true);
    limiter.clear('s1');
    expect(limiter.allow('s1')).toBe(true);
  });

  it('uses the normative batch limit of 20', () => {
    expect(MAX_RESET_BATCH).toBe(20);
  });

  it('selects the retry window for an additional (secondary) session by envelope', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const b2 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b2 });
    const sent = await sendE2eeMessage(
      { storage: a1.storage, kStorage: a1.kStorage, identity: a1.identity, now: a1.now },
      {
        chatId: SESSION_IDS.chat,
        body: { type: 'TEXT_JSON', text: 'to both devices' },
        recipients: [
          recipientPlan(await claimBundleFromWorld(b1)),
          recipientPlan(await claimBundleFromWorld(b2)),
        ],
        expectedPeerDeviceIds: [b1.deviceId, b2.deviceId],
        expectedSelfDeviceIds: [],
      },
    );
    const secondary = sent.envelopes.find(
      (envelope) => envelope.recipient_device_id === b2.deviceId,
    );
    expect(secondary).toBeDefined();
    const reset: SessionResetBody = {
      failedSessionId: secondary!.session_id,
      failedChainDh: secondary!.header.dh,
      failedN: secondary!.header.n,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: sent.clientMessageId,
    };

    // The outbox row's primary session is B1; the filter must find B2's
    // envelope (additionalSessionState), not compare only entry.sessionId.
    const byAnchor = await selectRetryWindow(a1.storage, a1.kStorage, {
      chatId: SESSION_IDS.chat,
      failedSessionId: reset.failedSessionId,
      reset,
    });
    expect(byAnchor.status).toBe('pending');
    expect(byAnchor.candidates.map((candidate) => candidate.text)).toEqual(['to both devices']);

    // The server may omit clientMessageId: the (failed_chain_dh, failed_n)
    // fallback must still select the message.
    const byChain = await selectRetryWindow(a1.storage, a1.kStorage, {
      chatId: SESSION_IDS.chat,
      failedSessionId: reset.failedSessionId,
      reset: { ...reset, retryOfClientMessageId: null },
    });
    expect(byChain.status).toBe('pending');
    expect(byChain.candidates.map((candidate) => candidate.text)).toEqual(['to both devices']);
  });

  it('deduplicates a reset by failed session, failed chain and anchor', () => {
    const reset: SessionResetBody = {
      failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      failedN: 3,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: '88888888-8888-4888-8888-888888888888',
    };
    const dedupe = new ResetDeduplicator();
    expect(dedupe.hasProcessed(reset)).toBe(false);
    expect(dedupe.markProcessed(reset)).toBe(true);
    expect(dedupe.markProcessed(reset)).toBe(false);
    expect(dedupe.hasProcessed(reset)).toBe(true);

    // A different anchor/chain is a different failure and must not be dropped.
    const otherAnchor = { ...reset, retryOfClientMessageId: null };
    expect(dedupe.markProcessed(otherAnchor)).toBe(true);
    const otherChain = { ...reset, failedChainDh: 'AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM' };
    expect(resetFingerprint(otherChain)).not.toBe(resetFingerprint(reset));
    expect(dedupe.markProcessed(otherChain)).toBe(true);

    dedupe.clear();
    expect(dedupe.markProcessed(reset)).toBe(true);
  });

  it('forgets a reset after a failed retry batch and stays bounded', () => {
    const reset: SessionResetBody = {
      failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      failedN: 3,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: '88888888-8888-4888-8888-888888888888',
    };
    const dedupe = new ResetDeduplicator(2);
    expect(dedupe.markProcessed(reset)).toBe(true);
    dedupe.forget(reset);
    expect(dedupe.hasProcessed(reset)).toBe(false);
    // The same reset can be processed again after the failure.
    expect(dedupe.markProcessed(reset)).toBe(true);
    expect(
      dedupe.markProcessed({
        ...reset,
        retryOfClientMessageId: '99999999-9999-4999-8999-999999999999',
      }),
    ).toBe(true);
    // Oldest entry is evicted instead of growing without bound.
    expect(
      dedupe.markProcessed({
        ...reset,
        retryOfClientMessageId: '77777777-7777-4777-8777-777777777777',
      }),
    ).toBe(true);
    expect(dedupe.hasProcessed(reset)).toBe(false);
  });

  it('orders cross-chain retries by durable sendOrder and keeps a superseded anchor', () => {
    const reset: SessionResetBody = {
      failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      failedN: 0,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: '22222222-2222-4222-8222-222222222222',
    };
    const entry = (
      sendOrder: number,
      clientMessageId: string,
      n: number,
      supersededAt: number | null = null,
    ) =>
      ({
        clientMessageId,
        chatId: SESSION_IDS.chat,
        sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        senderDeviceId: SESSION_IDS.a1,
        status: supersededAt === null ? 'sent' : 'superseded',
        createdAt: 1_000 - sendOrder, // createdAt is not the order
        updatedAt: 1_000,
        attempts: 1,
        lastErrorCode: null,
        serverMessageId: null,
        seq: null,
        warning: null,
        type: 'TEXT_JSON',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        envelopes: [
          {
            session_id: 'AQEBAQEBAQEBAQEBAQEBAQ',
            header: { v: 1, dh: reset.failedChainDh, pn: 0, n },
            recipient_device_id: SESSION_IDS.b1,
            ciphertext: 'x',
          },
        ],
        recipientDeviceIds: [SESSION_IDS.b1],
        retryOfClientMessageId: null,
        localMessageId: '44444444-4444-4444-8444-444444444444',
        sendOrder,
        supersededAt,
      }) as unknown as OutboxEntry;
    const entries = [
      entry(1, '11111111-1111-4111-8111-111111111111', 0, 5),
      entry(2, '22222222-2222-4222-8222-222222222222', 1),
      entry(3, '33333333-3333-4333-8333-333333333333', 0),
      entry(4, '44444444-4444-4444-8444-444444444444', 1),
    ];

    expect(
      selectRetryWindowEntries(entries, reset).selected.map((item) => item.clientMessageId),
    ).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ]);
    expect(
      selectRetryWindowEntries(entries, {
        ...reset,
        retryOfClientMessageId: '33333333-3333-4333-8333-333333333333',
      }).selected.map((item) => item.clientMessageId),
    ).toEqual(['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']);
    const bounded = selectRetryWindowEntries(entries, reset, 2);
    expect(bounded.selected).toHaveLength(2);
    expect(bounded.remaining).toBe(1);
    // A superseded anchor is still found; the pending tail survives.
    expect(
      selectRetryWindowEntries(entries, {
        ...reset,
        retryOfClientMessageId: '11111111-1111-4111-8111-111111111111',
      }).selected.map((item) => item.clientMessageId),
    ).toEqual([
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
    ]);
  });

  it('excludes a sent-but-superseded replacement from a partial retry window', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const context = {
      storage: a1.storage,
      kStorage: a1.kStorage,
      identity: a1.identity,
      now: a1.now,
    };
    const first = await sendE2eeMessage(context, {
      chatId: SESSION_IDS.chat,
      body: { type: 'TEXT_JSON', text: 'first' },
      recipients: [recipientPlan(await claimBundleFromWorld(b1))],
      expectedPeerDeviceIds: [b1.deviceId],
    });
    const second = await sendE2eeMessage(context, {
      chatId: SESSION_IDS.chat,
      body: { type: 'TEXT_JSON', text: 'second' },
      recipients: [recipientPlan(await claimBundleFromWorld(b1))],
      expectedPeerDeviceIds: [b1.deviceId],
    });
    // First replacement was confirmed and then superseded by the same R-15
    // batch; its outbox row is terminal `sent` but must not re-enter the window.
    await markOutboxSent(a1.storage, first.clientMessageId, {
      serverMessageId: '11111111-1111-4111-8111-111111111111',
      seq: 1,
    });
    await markOutboxSuperseded(a1.storage, first.clientMessageId);

    const envelope = first.envelopes[0]!;
    const window = await selectRetryWindow(a1.storage, a1.kStorage, {
      chatId: SESSION_IDS.chat,
      failedSessionId: first.sessionId,
      reset: {
        failedSessionId: first.sessionId,
        failedChainDh: envelope.header.dh,
        failedN: envelope.header.n,
        reason: 'DECRYPT_FAILED',
        retryOfClientMessageId: first.clientMessageId,
      },
    });
    expect(window.status).toBe('pending');
    expect(window.candidates.map((candidate) => candidate.text)).toEqual(['second']);
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('isolates a corrupt local copy and reports the skipped entry (P2-35)', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const context = {
      storage: a1.storage,
      kStorage: a1.kStorage,
      identity: a1.identity,
      now: a1.now,
    };
    const first = await sendE2eeMessage(context, {
      chatId: SESSION_IDS.chat,
      body: { type: 'TEXT_JSON', text: 'first' },
      recipients: [recipientPlan(await claimBundleFromWorld(b1))],
      expectedPeerDeviceIds: [b1.deviceId],
    });
    const second = await sendE2eeMessage(context, {
      chatId: SESSION_IDS.chat,
      body: { type: 'TEXT_JSON', text: 'second' },
      recipients: [recipientPlan(await claimBundleFromWorld(b1))],
      expectedPeerDeviceIds: [b1.deviceId],
    });

    // Corrupt the first message's local copy: the whole reset must not abort.
    const copyKey = localCopyStorageKey({
      chatId: SESSION_IDS.chat,
      direction: 'outgoing',
      senderDeviceId: a1.deviceId,
      clientMessageId: first.clientMessageId,
      localMessageId: first.localMessageId,
    });
    const stored = (await a1.storage.get<StoredLocalMessageCopy>(
      'localMessages',
      copyKey,
    )) as StoredLocalMessageCopy;
    await a1.storage.put('localMessages', copyKey, {
      ...stored,
      chatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const envelope = first.envelopes[0]!;
    const reset: SessionResetBody = {
      failedSessionId: first.sessionId,
      failedChainDh: envelope.header.dh,
      failedN: envelope.header.n,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: first.clientMessageId,
    };
    const window = await selectRetryWindow(a1.storage, a1.kStorage, {
      chatId: SESSION_IDS.chat,
      failedSessionId: first.sessionId,
      reset,
    });
    expect(window.status).toBe('pending');
    expect(window.skipped).toBe(1);
    expect(window.candidates.map((candidate) => candidate.text)).toEqual(['second']);
    expect(second.sessionId).toBe(first.sessionId);
  });
});

describe('G4e #30 pending replacement in the R-15 window', () => {
  it('never re-encrypts an original whose replacement is still pending', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const context = {
      storage: a1.storage,
      kStorage: a1.kStorage,
      identity: a1.identity,
      now: a1.now,
    };
    const first = await sendE2eeMessage(context, {
      chatId: SESSION_IDS.chat,
      body: { type: 'TEXT_JSON', text: 'first' },
      recipients: [recipientPlan(await claimBundleFromWorld(b1))],
      expectedPeerDeviceIds: [b1.deviceId],
    });
    const replacement = await sendE2eeMessage(context, {
      chatId: SESSION_IDS.chat,
      body: { type: 'TEXT_JSON', text: 'first' },
      // A real R-15 replacement uses a fresh prekey session, i.e. its envelope
      // does not carry the failed session id; the window must still find it.
      recipients: [recipientPlan(await claimBundleFromWorld(b1), { freshPrekey: true })],
      expectedPeerDeviceIds: [b1.deviceId],
      retryOfClientMessageId: first.clientMessageId,
    });
    expect(replacement.clientMessageId).not.toBe(first.clientMessageId);
    expect(replacement.sessionId).not.toBe(first.sessionId);
    const envelope = first.envelopes[0]!;
    const reset: SessionResetBody = {
      failedSessionId: first.sessionId,
      failedChainDh: envelope.header.dh,
      failedN: envelope.header.n,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: first.clientMessageId,
    };

    const pending = await selectRetryWindow(a1.storage, a1.kStorage, {
      chatId: SESSION_IDS.chat,
      failedSessionId: first.sessionId,
      reset,
    });
    expect(pending.status).toBe('pending');
    expect(pending.candidates).toEqual([]);
    expect(pending.pendingReplacements).toBe(1);

    // The durable drain confirms the exact replacement bytes; no second
    // encryption of the same plaintext happens.
    await markOutboxSent(a1.storage, replacement.clientMessageId, {
      serverMessageId: '11111111-1111-4111-8111-111111111111',
      seq: 2,
    });
    const done = await selectRetryWindow(a1.storage, a1.kStorage, {
      chatId: SESSION_IDS.chat,
      failedSessionId: first.sessionId,
      reset,
    });
    expect(done.status).toBe('empty');
    expect(done.candidates).toEqual([]);
    expect(done.pendingReplacements).toBe(0);
  });

  it('pure selector skips replaced originals and reports pending replacements', () => {
    const reset: SessionResetBody = {
      failedSessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
      failedChainDh: 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI',
      failedN: 0,
      reason: 'DECRYPT_FAILED',
      retryOfClientMessageId: '11111111-1111-4111-8111-111111111111',
    };
    const entry = (
      sendOrder: number,
      clientMessageId: string,
      retryOfClientMessageId: string | null,
      status: 'pending' | 'sent' | 'failed' | 'superseded',
    ) =>
      ({
        clientMessageId,
        chatId: SESSION_IDS.chat,
        sessionId: 'AQEBAQEBAQEBAQEBAQEBAQ',
        senderDeviceId: SESSION_IDS.a1,
        status,
        createdAt: 1_000,
        updatedAt: 1_000,
        attempts: 0,
        lastErrorCode: null,
        serverMessageId: null,
        seq: null,
        warning: null,
        type: 'TEXT_JSON',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        envelopes: [
          {
            session_id: 'AQEBAQEBAQEBAQEBAQEBAQ',
            header: { v: 1, dh: reset.failedChainDh, pn: 0, n: 0 },
            recipient_device_id: SESSION_IDS.b1,
            ciphertext: 'x',
          },
        ],
        recipientDeviceIds: [SESSION_IDS.b1],
        retryOfClientMessageId,
        localMessageId: '44444444-4444-4444-8444-444444444444',
        sendOrder,
        supersededAt: null,
        nextAttemptAt: null,
        lastAttemptAt: null,
      }) as unknown as OutboxEntry;
    const entries = [
      entry(1, '11111111-1111-4111-8111-111111111111', null, 'sent'),
      entry(
        2,
        '22222222-2222-4222-8222-222222222222',
        '11111111-1111-4111-8111-111111111111',
        'pending',
      ),
      entry(3, '33333333-3333-4333-8333-333333333333', null, 'sent'),
    ];
    const selection = selectRetryWindowEntries(entries, reset);
    expect(selection.status).toBe('pending');
    expect(selection.selected).toEqual([]);
    expect(selection.pendingReplacements).toBe(1);
  });
});

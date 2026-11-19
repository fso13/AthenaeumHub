/**
 * E7-F4 send/receive integration (no network, no UI).
 *
 * Covers the two-party dialogue, prekey/normal envelopes, OPK/SPK lifecycle,
 * TOFU first contact and key change, out-of-order delivery, replay, session
 * restore, multi-device fan-out with atomic session commits, and the client-side
 * coverage pre-check.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { E2eeError } from './errors';
import { dumpStorage, dumpText } from './test/fixtures';
import {
  SESSION_IDS,
  claimBundleFromWorld,
  createTestWorld,
  recipientPlan,
  reloadWorld,
  verifiedIdentityOf,
  type TestWorld,
} from './test/sessionFixtures';
import { prepareE2eeSend, sendE2eeMessage, commitE2eeSend } from './session/send';
import { openIncomingE2eeMessage, receiveE2eeMessage } from './session/receive';
import { deleteSession, loadSession, listSessionsByPeer } from './session/sessionStore';
import { selectSendingSession } from './session/send';
import { listOneTimePrekeys, deleteSignedPrekey } from './session/prekeyStore';
import { readPin } from './device/pins';
import { lookupIncomingLocalCopy, lookupLocalCopy } from './outbox/outboxStore';
import { serializeSessionResetBody, parseSessionResetBody } from './session/reset';
import { decodeBase64Url, encodeBase64Url } from './encoding/base64url';
import type { WireCryptoEnvelope } from './api/deviceKeys';
import type { SessionState } from './session/types';

const CHAT = SESSION_IDS.chat;

function contextOf(world: TestWorld) {
  return {
    storage: world.storage,
    kStorage: world.kStorage,
    identity: world.identity,
    now: world.now,
  };
}

async function sendText(
  from: TestWorld,
  recipients: ReturnType<typeof recipientPlan>[],
  text: string,
  options: {
    readonly chatId?: string;
    readonly peerDeviceIds?: string[];
    readonly selfDeviceIds?: string[];
    readonly now?: number;
    readonly replyToId?: string | null;
  } = {},
) {
  return sendE2eeMessage(
    { ...contextOf(from), now: options.now ?? from.now },
    {
      chatId: options.chatId ?? CHAT,
      body: { type: 'TEXT_JSON', text, replyToId: options.replyToId ?? null },
      recipients,
      ...(options.peerDeviceIds ? { expectedPeerDeviceIds: options.peerDeviceIds } : {}),
      ...(options.selfDeviceIds ? { expectedSelfDeviceIds: options.selfDeviceIds } : {}),
    },
  );
}

async function receiveFrom(
  to: TestWorld,
  from: TestWorld,
  envelope: WireCryptoEnvelope,
  options: {
    readonly now?: number;
    readonly isSelfDevice?: boolean;
    readonly clientMessageId?: string | null;
    readonly serverMessageId?: string;
  } = {},
) {
  return receiveE2eeMessage(
    { ...contextOf(to), now: options.now ?? to.now },
    {
      chatId: CHAT,
      envelope,
      sender: await verifiedIdentityOf(from),
      isSelfDevice: options.isSelfDevice ?? from.userId === to.userId,
      clientMessageId: options.clientMessageId ?? null,
      createdAt: options.now ?? to.now,
    },
    options.serverMessageId === undefined ? {} : { serverMessageId: options.serverMessageId },
  );
}

async function pair(): Promise<{ a: TestWorld; b: TestWorld }> {
  const a = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
  const b = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
  return { a, b };
}

describe('E7-F4 two-party dialogue', () => {
  it('A1 → B1 prekey, B1 replies, A1 replies again', async () => {
    const { a, b } = await pair();
    const bBundle = await claimBundleFromWorld(b);

    const first = await sendText(a, [recipientPlan(bBundle)], 'hello Боб');
    expect(first.envelopes).toHaveLength(1);
    expect(first.envelopes[0]!.prekey).not.toBeNull();
    expect(first.envelopes[0]!.recipient_device_id).toBe(b.deviceId);
    expect(first.envelopes[0]!.sender_device_id).toBe(a.deviceId);
    expect(first.coverage).toMatchObject({ peerDevices: 1, peerCovered: 1 });

    // Persist-before-send: the local copy and the outbox row exist without a network.
    const local = await lookupLocalCopy(a.storage, a.kStorage, CHAT, first.clientMessageId);
    expect(local.available).toBe(true);
    if (local.available) expect(local.copy.text).toBe('hello Боб');

    const aSession = await loadSession(a.storage, a.kStorage, first.sessionId);
    expect(aSession?.initiatedBy).toBe('local');
    expect(aSession?.spkId).toBe(bBundle.signedPrekey.key_id);

    const received = await receiveFrom(b, a, first.envelopes[0]!);
    expect(received.text).toBe('hello Боб');
    expect(received.contentType).toBe(1);
    expect(received.prekey).toBe(true);
    expect(received.session.initiatedBy).toBe('peer');
    expect(received.oneTimePrekeyId).toBe(bBundle.oneTimePrekey?.keyId);

    const bSession = await loadSession(b.storage, b.kStorage, first.sessionId);
    expect(bSession).not.toBeNull();
    expect(bSession?.spkId).toBe(bBundle.signedPrekey.key_id);
    expect(bSession?.lastReceivedAt).not.toBeNull();
    // The OPK private key is consumed in the same commit as the session.
    expect(
      await listOneTimePrekeys(b.storage).then((opks) =>
        opks.some((opk) => opk.keyId === bBundle.oneTimePrekey?.keyId),
      ),
    ).toBe(false);
    // TOFU pin for the sender's device.
    const aPin = await readPin(b.storage, a.userId, a.deviceId);
    expect(aPin).not.toBeNull();
    expect(aPin?.verified).toBe(false);

    // B1 replies on the existing session (no prekey block).
    const reply = await sendText(b, [recipientPlan(await claimBundleFromWorld(a))], 'привет Алиса');
    expect(reply.envelopes[0]!.prekey ?? null).toBeNull();
    const receivedReply = await receiveFrom(a, b, reply.envelopes[0]!);
    expect(receivedReply.text).toBe('привет Алиса');
    expect(receivedReply.prekey).toBe(false);
    expect(receivedReply.dhRatchet).toBe(true);

    // A1 answers on the ratcheted chain.
    const third = await sendText(
      a,
      [recipientPlan(await claimBundleFromWorld(b))],
      'третье сообщение',
    );
    const receivedThird = await receiveFrom(b, a, third.envelopes[0]!);
    expect(receivedThird.text).toBe('третье сообщение');
    expect(receivedThird.dhRatchet).toBe(true);
    expect(receivedThird.session.nr).toBe(1);

    // No plaintext at rest.
    expect(dumpText(await dumpStorage(a.storage))).not.toContain('привет Алиса');
    expect(dumpText(await dumpStorage(b.storage))).not.toContain('hello Боб');
  });

  it('seals and restores the v1.1 R-15 marker in the incoming local copy', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const originalClientMessageId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const sent = await sendE2eeMessage(contextOf(a), {
      chatId: CHAT,
      body: {
        type: 'TEXT_JSON',
        text: 'replacement text',
        retryOfClientMessageId: originalClientMessageId,
      },
      retryOfClientMessageId: originalClientMessageId,
      recipients: [recipientPlan(bundle)],
    });
    const received = await receiveFrom(b, a, sent.envelopes[0]!, {
      clientMessageId: sent.clientMessageId,
      serverMessageId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(received.retryOfClientMessageId).toBe(originalClientMessageId);

    // The reload path only reads IndexedDB; the marker must be in the sealed
    // copy, not only in the in-memory receive result.
    const lookup = await lookupIncomingLocalCopy(
      b.storage,
      b.kStorage,
      CHAT,
      a.deviceId,
      sent.clientMessageId,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    expect(lookup.available).toBe(true);
    if (lookup.available) {
      expect(lookup.copy.text).toBe('replacement text');
      expect(lookup.copy.retryOfClientMessageId).toBe(originalClientMessageId);
    }
    // The sender's outgoing copy carries the same marker (self-describing).
    const outgoing = await lookupLocalCopy(a.storage, a.kStorage, CHAT, sent.clientMessageId);
    expect(outgoing.available && outgoing.copy.retryOfClientMessageId).toBe(
      originalClientMessageId,
    );
  });

  it('restores a received message from its sealed incoming copy after a reload', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const sent = await sendText(a, [recipientPlan(bundle)], 'incoming reload copy');

    const received = await receiveFrom(b, a, sent.envelopes[0]!, {
      clientMessageId: sent.clientMessageId,
    });
    expect(received.text).toBe('incoming reload copy');

    // The incoming copy is scoped by the sender device and the server client id;
    // the local sender's outgoing lookup can never resolve it (P1-02).
    const incoming = await lookupIncomingLocalCopy(
      b.storage,
      b.kStorage,
      CHAT,
      a.deviceId,
      sent.clientMessageId,
    );
    expect(incoming.available).toBe(true);
    if (incoming.available) {
      expect(incoming.copy.text).toBe('incoming reload copy');
      expect(incoming.copy.replyToId).toBeNull();
    }
    const outgoing = await lookupLocalCopy(b.storage, b.kStorage, CHAT, sent.clientMessageId);
    expect(outgoing.available).toBe(false);

    // Same-copy replay is still rejected by the ratchet and the copy survives.
    await expect(
      receiveFrom(b, a, sent.envelopes[0]!, {
        clientMessageId: sent.clientMessageId,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_OR_OLD_MESSAGE' });
    const afterReplay = await lookupIncomingLocalCopy(
      b.storage,
      b.kStorage,
      CHAT,
      a.deviceId,
      sent.clientMessageId,
    );
    expect(afterReplay.available).toBe(true);
  });

  it('keeps the incoming copy usable after deleteSession (NO_SESSION / prekey duplicate)', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const first = await sendText(a, [recipientPlan(bundle)], 'prekey copy');
    const firstId = '11111111-1111-4111-8111-111111111111';
    const firstReceived = await receiveFrom(b, a, first.envelopes[0]!, {
      clientMessageId: first.clientMessageId,
      serverMessageId: firstId,
    });
    expect(firstReceived.text).toBe('prekey copy');

    // R-15 finish / §5.7 loser deletion removes the session, not the copy.
    await deleteSession(b.storage, firstReceived.sessionId);
    expect(await loadSession(b.storage, b.kStorage, firstReceived.sessionId)).toBeNull();

    // The prekey envelope cannot be re-opened (OPK already consumed).
    await expect(
      receiveFrom(b, a, first.envelopes[0]!, {
        clientMessageId: first.clientMessageId,
        serverMessageId: firstId,
      }),
    ).rejects.toMatchObject({ code: 'KEY_HANDSHAKE_INVALID' });

    const copy = await lookupIncomingLocalCopy(
      b.storage,
      b.kStorage,
      CHAT,
      a.deviceId,
      first.clientMessageId,
      firstId,
    );
    expect(copy.available).toBe(true);
    if (copy.available) {
      expect(copy.copy.text).toBe('prekey copy');
      expect(copy.copy.serverMessageId).toBe(firstId);
    }

    // P2-04: the same copy must not resolve a replayed client id under a new
    // server row.
    const replayed = await lookupIncomingLocalCopy(
      b.storage,
      b.kStorage,
      CHAT,
      a.deviceId,
      first.clientMessageId,
      '22222222-2222-4222-8222-222222222222',
    );
    expect(replayed.available).toBe(false);
  });

  it('keeps the incoming copy usable when a normal envelope needs a deleted session', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const first = await sendText(a, [recipientPlan(bundle)], 'm1');
    await receiveFrom(b, a, first.envelopes[0]!, { clientMessageId: first.clientMessageId });
    const second = await sendText(a, [recipientPlan(bundle)], 'm2 normal');
    const received = await receiveFrom(b, a, second.envelopes[0]!, {
      clientMessageId: second.clientMessageId,
    });
    expect(received.prekey).toBe(false);

    await deleteSession(b.storage, received.sessionId);
    await expect(
      receiveFrom(b, a, second.envelopes[0]!, {
        clientMessageId: second.clientMessageId,
      }),
    ).rejects.toMatchObject({ code: 'NO_SESSION' });

    const copy = await lookupIncomingLocalCopy(
      b.storage,
      b.kStorage,
      CHAT,
      a.deviceId,
      second.clientMessageId,
    );
    expect(copy.available).toBe(true);
    if (copy.available) expect(copy.copy.text).toBe('m2 normal');
  });

  it('implements reply_to inside the inner payload and validates it', async () => {
    const { a, b } = await pair();
    const replyTo = '01234567-89ab-4cde-8f01-23456789abcd';
    const sent = await sendText(a, [recipientPlan(await claimBundleFromWorld(b))], 'ответ', {
      replyToId: replyTo,
    });
    const received = await receiveFrom(b, a, sent.envelopes[0]!);
    expect(received.replyToId).toBe(replyTo);
  });
});

describe('E7-F4 out-of-order, replay and gaps', () => {
  it('delivers m1, m3, m2 and consumes the skipped key', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const first = await sendText(a, [recipientPlan(bundle)], 'm1');
    // Establish the session first; subsequent messages have no prekey block.
    await receiveFrom(b, a, first.envelopes[0]!);
    const second = await sendText(a, [recipientPlan(bundle)], 'm2');
    const third = await sendText(a, [recipientPlan(bundle)], 'm3');

    const r3 = await receiveFrom(b, a, third.envelopes[0]!);
    expect(r3.text).toBe('m3');
    expect(r3.skippedStored).toBe(1);
    const afterThird = await loadSession(b.storage, b.kStorage, first.sessionId);
    expect(afterThird?.skipped.map((key) => key.n)).toEqual([1]);

    const r2 = await receiveFrom(b, a, second.envelopes[0]!);
    expect(r2.text).toBe('m2');
    const afterSecond = await loadSession(b.storage, b.kStorage, first.sessionId);
    expect(afterSecond?.skipped).toHaveLength(0);

    // Replay of m3 is rejected and does not touch storage.
    await expect(receiveFrom(b, a, third.envelopes[0]!)).rejects.toMatchObject({
      code: 'DUPLICATE_OR_OLD_MESSAGE',
    });
    expect((await loadSession(b.storage, b.kStorage, first.sessionId))?.nr).toBe(afterSecond?.nr);
  });

  it('rejects a gap larger than MAX_SKIP before any state change', async () => {
    const { a, b } = await pair();
    const first = await sendText(a, [recipientPlan(await claimBundleFromWorld(b))], 'start');
    await receiveFrom(b, a, first.envelopes[0]!);
    const forged: WireCryptoEnvelope = {
      ...first.envelopes[0]!,
      prekey: null,
      header: {
        ...first.envelopes[0]!.header,
        pn: 1,
        n: 1002,
      },
      session_id: first.envelopes[0]!.session_id,
    };
    const before = await loadSession(b.storage, b.kStorage, first.sessionId);
    await expect(receiveFrom(b, a, forged)).rejects.toMatchObject({
      code: 'SESSION_TOO_FAR_BEHIND',
    });
    const after = await loadSession(b.storage, b.kStorage, first.sessionId);
    expect(after?.nr).toBe(before?.nr);
    expect(after?.skipped).toHaveLength(0);
  });
});

describe('E7-F4 OPK/SPK and decrypt failures', () => {
  it('keeps the OPK when the first AEAD fails and rejects the replay later', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const sent = await sendText(a, [recipientPlan(bundle)], 'tamper me');
    const envelope = sent.envelopes[0]!;
    const ciphertext = decodeCiphertext(envelope.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0x01;
    const broken: WireCryptoEnvelope = {
      ...envelope,
      ciphertext: encodeBase64Url(ciphertext),
    };
    await expect(receiveFrom(b, a, broken)).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    expect(await loadSession(b.storage, b.kStorage, sent.sessionId)).toBeNull();
    expect(
      await listOneTimePrekeys(b.storage).then((opks) =>
        opks.some((opk) => opk.keyId === bundle.oneTimePrekey?.keyId),
      ),
    ).toBe(true);

    // The intact envelope still decrypts, so the OPK was not burned.
    const ok = await receiveFrom(b, a, envelope);
    expect(ok.text).toBe('tamper me');
  });

  it('rejects a second prekey envelope that reuses a consumed OPK', async () => {
    const { a, b } = await pair();
    const staleBundle = await claimBundleFromWorld(b);
    const first = await sendText(a, [recipientPlan(staleBundle)], 'one');
    await receiveFrom(b, a, first.envelopes[0]!);

    // A fresh session that still references the already consumed OPK id.
    const replayBundle = staleBundle;
    const second = await sendText(a, [recipientPlan(replayBundle, { freshPrekey: true })], 'two');
    await expect(receiveFrom(b, a, second.envelopes[0]!)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
    expect(await loadSession(b.storage, b.kStorage, second.sessionId)).toBeNull();
  });

  it('reports SPK_DELETED when the prekey was destroyed', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const sent = await sendText(a, [recipientPlan(bundle)], 'late');
    await deleteSignedPrekey(b.storage, bundle.signedPrekey.key_id);
    await expect(receiveFrom(b, a, sent.envelopes[0]!)).rejects.toMatchObject({
      code: 'SPK_DELETED',
    });
    expect(await loadSession(b.storage, b.kStorage, sent.sessionId)).toBeNull();
  });
});

describe('E7-F4 TOFU and key change', () => {
  it('creates a pin on first contact and detects a substituted identity', async () => {
    const { a, b } = await pair();
    const first = await sendText(
      a,
      [recipientPlan(await claimBundleFromWorld(b))],
      'first contact',
    );
    const received = await receiveFrom(b, a, first.envelopes[0]!);
    expect(received.text).toBe('first contact');
    const pin = await readPin(b.storage, a.userId, a.deviceId);
    expect(pin?.verified).toBe(false);
    expect(pin?.identityDhKey).toBe(encodeBase64Url((await verifiedIdentityOf(a)).identityDhKey));

    // Same user id + device id, new identity keys ("reinstalled" device).
    const impostor = await createTestWorld({
      userId: SESSION_IDS.userA,
      deviceId: SESSION_IDS.a1,
      now: 1_700_000_500_000,
    });
    const impostorSent = await sendText(
      impostor,
      [recipientPlan(await claimBundleFromWorld(b))],
      'substituted',
    );
    const opksBefore = await listOneTimePrekeys(b.storage);
    await expect(receiveFrom(b, impostor, impostorSent.envelopes[0]!)).rejects.toMatchObject({
      code: 'KEY_CHANGE_DETECTED',
    });
    expect(await loadSession(b.storage, b.kStorage, impostorSent.sessionId)).toBeNull();
    expect((await listOneTimePrekeys(b.storage)).length).toBe(opksBefore.length);
    // The pin was not overwritten.
    expect((await readPin(b.storage, a.userId, a.deviceId))?.identityDhKey).toBe(
      pin?.identityDhKey,
    );
    // Sending to the changed device is blocked as well.
    await expect(
      sendText(b, [recipientPlan(await claimBundleFromWorld(impostor))], 'blocked'),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });
  });
});

describe('E7-F4 session restore and DH hygiene', () => {
  it('continues the dialogue after a reload and keeps only the current DH pair', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const first = await sendText(a, [recipientPlan(bundle)], 'before reload');
    await receiveFrom(b, a, first.envelopes[0]!);
    const oldDhA = (await loadSession(a.storage, a.kStorage, first.sessionId))?.dhPublicKey;

    const aReloaded = await reloadWorld(a);
    const bReloaded = await reloadWorld(b);
    const second = await sendText(
      bReloaded,
      [recipientPlan(await claimBundleFromWorld(aReloaded))],
      'after reload',
    );
    const received = await receiveFrom(aReloaded, bReloaded, second.envelopes[0]!);
    expect(received.text).toBe('after reload');

    const reloadedSession = await loadSession(a.storage, a.kStorage, second.sessionId);
    expect(reloadedSession).not.toBeNull();
    // A DH ratchet replaced DHs; the old public key is not in any stored record.
    expect(encodeBase64Url(oldDhA as Uint8Array)).not.toBe(
      encodeBase64Url(reloadedSession!.dhPublicKey),
    );
    expect(dumpText(await dumpStorage(a.storage))).not.toContain(
      encodeBase64Url(oldDhA as Uint8Array),
    );
  });
});

describe('E7-F4 multi-device fan-out', () => {
  it('covers B1, B2 and the sender A2 atomically and never itself', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const a2 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a2 });
    const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const b2 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b2 });

    const sent = await sendText(
      a1,
      [
        recipientPlan(await claimBundleFromWorld(b1)),
        recipientPlan(await claimBundleFromWorld(b2)),
        recipientPlan(await claimBundleFromWorld(a2), { isSelfDevice: true }),
      ],
      'to everyone',
      {
        peerDeviceIds: [b1.deviceId, b2.deviceId],
        selfDeviceIds: [a2.deviceId],
      },
    );
    expect(sent.envelopes).toHaveLength(3);
    expect(sent.envelopes.map((envelope) => envelope.recipient_device_id).sort()).toEqual(
      [a2.deviceId, b1.deviceId, b2.deviceId].sort(),
    );
    expect(sent.envelopes.some((envelope) => envelope.recipient_device_id === a1.deviceId)).toBe(
      false,
    );
    expect(sent.coverage).toMatchObject({
      peerDevices: 2,
      peerCovered: 2,
      selfDevices: 1,
      selfCovered: 1,
      uncoveredDeviceIds: [],
    });

    // All three advanced sessions were committed with the outbox row.
    const aSessions = await listSessionsByPeer(a1.storage, a1.kStorage, CHAT, b1.deviceId);
    expect(aSessions).toHaveLength(1);
    expect(await listSessionsByPeer(a1.storage, a1.kStorage, CHAT, a2.deviceId)).toHaveLength(1);

    const byRecipient = new Map(
      sent.envelopes.map((envelope) => [envelope.recipient_device_id, envelope]),
    );
    expect((await receiveFrom(b1, a1, byRecipient.get(b1.deviceId)!)).text).toBe('to everyone');
    expect((await receiveFrom(b2, a1, byRecipient.get(b2.deviceId)!)).text).toBe('to everyone');
    const selfReceive = await receiveFrom(a2, a1, byRecipient.get(a2.deviceId)!, {
      isSelfDevice: true,
    });
    expect(selfReceive.text).toBe('to everyone');
  });

  it('rolls back every session and the outbox when one additional session is stale', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const a2 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a2 });
    const b1 = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const b1Bundle = await claimBundleFromWorld(b1);

    // Establish both sessions so the next send advances existing states.
    await sendText(
      a1,
      [
        recipientPlan(b1Bundle),
        recipientPlan(await claimBundleFromWorld(a2), { isSelfDevice: true }),
      ],
      'seed',
      { peerDeviceIds: [b1.deviceId], selfDeviceIds: [a2.deviceId] },
    );
    const prepared = await prepareE2eeSend(contextOf(a1), {
      chatId: CHAT,
      body: { type: 'TEXT_JSON', text: 'atomic' },
      recipients: [
        recipientPlan(await claimBundleFromWorld(b1)),
        recipientPlan(await claimBundleFromWorld(a2), { isSelfDevice: true }),
      ],
      expectedPeerDeviceIds: [b1.deviceId],
      expectedSelfDeviceIds: [a2.deviceId],
    });
    expect(prepared.envelopes).toHaveLength(2);

    // Another writer moves the additional (A2) session after prepare.
    const a2Session = (
      await listSessionsByPeer(a1.storage, a1.kStorage, CHAT, a2.deviceId)
    )[0] as SessionState;
    const { saveSession } = await import('./test/sessionTestWrites');
    await saveSession(
      a1.storage,
      a1.kStorage,
      { ...a2Session, lastUsedAt: a2Session.lastUsedAt + 1 },
      { ifRevision: a2Session.revision },
    );
    const b1Before = await loadSession(a1.storage, a1.kStorage, prepared.envelopes[0]!.session_id);

    await expect(commitE2eeSend(a1.storage, prepared)).rejects.toMatchObject({
      code: 'SESSION_STATE_STALE',
    });
    expect(
      await lookupLocalCopy(a1.storage, a1.kStorage, CHAT, prepared.clientMessageId),
    ).toMatchObject({ available: false });
    // The primary (B1) session was not advanced either — one transaction.
    const b1After = await loadSession(a1.storage, a1.kStorage, prepared.envelopes[0]!.session_id);
    expect(b1After?.revision).toBe(b1Before?.revision);
  });

  it('refuses a plan that targets the local device and a send with no peer envelope', async () => {
    const a1 = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    await expect(
      prepareE2eeSend(contextOf(a1), {
        chatId: CHAT,
        body: { type: 'TEXT_JSON', text: 'self' },
        recipients: [recipientPlan(await claimBundleFromWorld(a1), { isSelfDevice: true })],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ENVELOPE_FORMAT' });

    await expect(
      prepareE2eeSend(contextOf(a1), {
        chatId: CHAT,
        body: { type: 'TEXT_JSON', text: 'no peer' },
        recipients: [],
      }),
    ).rejects.toMatchObject({ code: 'PEER_UNCOVERED' });
  });
});

describe('E7-F4 SESSION_RESET control payload', () => {
  it('frames and parses the reset body and encrypts it as content_type=2', async () => {
    const reset = {
      failedSessionId: encodeBase64Url(new Uint8Array(16).fill(7)),
      failedChainDh: encodeBase64Url(new Uint8Array(32).fill(9)),
      failedN: 3,
      reason: 'DECRYPT_FAILED' as const,
      retryOfClientMessageId: null,
    };
    expect(parseSessionResetBody(serializeSessionResetBody(reset))).toEqual(reset);

    const a = await createTestWorld({ userId: SESSION_IDS.userA, deviceId: SESSION_IDS.a1 });
    const b = await createTestWorld({ userId: SESSION_IDS.userB, deviceId: SESSION_IDS.b1 });
    const sent = await sendE2eeMessage(contextOf(a), {
      chatId: CHAT,
      body: { type: 'SESSION_RESET', reset },
      recipients: [recipientPlan(await claimBundleFromWorld(b))],
    });
    expect(sent.envelopes[0]!.prekey).not.toBeNull();
    const received = await receiveFrom(b, a, sent.envelopes[0]!);
    expect(received.contentType).toBe(2);
    expect(received.text).toBeNull();
    expect(received.reset).toEqual(reset);
  });
});

function decodeCiphertext(value: string): Uint8Array {
  return decodeBase64Url(value);
}

describe('E7-F4 error containment', () => {
  it('never surfaces plaintext or key material in an error message', async () => {
    const { a, b } = await pair();
    const sent = await sendText(
      a,
      [recipientPlan(await claimBundleFromWorld(b))],
      'secret plaintext',
    );
    const envelope = sent.envelopes[0]!;
    const ciphertext = decodeCiphertext(envelope.ciphertext);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    try {
      await receiveFrom(b, a, { ...envelope, ciphertext: encodeBase64Url(ciphertext) });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(E2eeError);
      const message = (error as E2eeError).message;
      expect(message).not.toContain('secret plaintext');
      expect(message).not.toContain(envelope.ciphertext);
      expect(message).not.toContain(encodeBase64Url(new Uint8Array(32).fill(1)));
    }
    // The open-only path leaves the state untouched as well.
    await expect(
      openIncomingE2eeMessage(contextOf(b), {
        chatId: CHAT,
        envelope,
        sender: await verifiedIdentityOf(a),
      }),
    ).resolves.toBeTruthy();
  });
});

describe('E7-F4 AD authentication', () => {
  it('rejects a modified header/AD without advancing the receiving chain', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const first = await sendText(a, [recipientPlan(bundle)], 'one');
    await receiveFrom(b, a, first.envelopes[0]!);
    const second = await sendText(a, [recipientPlan(bundle)], 'two');
    const before = await loadSession(b.storage, b.kStorage, first.sessionId);
    const tampered: WireCryptoEnvelope = {
      ...second.envelopes[0]!,
      header: { ...second.envelopes[0]!.header, pn: 99 },
    };
    await expect(receiveFrom(b, a, tampered)).rejects.toMatchObject({
      code: 'DECRYPT_FAILED',
    });
    const after = await loadSession(b.storage, b.kStorage, first.sessionId);
    expect(after?.nr).toBe(before?.nr);
    expect(after?.skipped).toHaveLength(0);
    // The intact envelope still decrypts afterwards.
    expect((await receiveFrom(b, a, second.envelopes[0]!)).text).toBe('two');
  });
});

describe('E7-F4 session selection and simultaneous initiation (§5.7)', () => {
  it('selectSendingSession uses the deterministic pair winner, then received/local/lowest id', async () => {
    const base = await createTestSessionForSelection();
    const localOnly = {
      ...base,
      sessionId: encodeBase64Url(new Uint8Array(16).fill(9)),
      initiatedBy: 'local' as const,
    };
    const peerOnly = {
      ...base,
      sessionId: encodeBase64Url(new Uint8Array(16).fill(8)),
      initiatedBy: 'peer' as const,
    };
    expect(selectSendingSession([])).toBeNull();
    expect(selectSendingSession([peerOnly])?.sessionId).toBe(peerOnly.sessionId);
    // E7-F6 §5.7: one local + one peer session is a simultaneous pair, so the
    // lower canonical session_id wins deterministically on both devices.
    expect(selectSendingSession([peerOnly, localOnly])?.sessionId).toBe(peerOnly.sessionId);
    const receivedOlder = { ...localOnly, lastReceivedAt: 10 };
    const receivedNewer = { ...peerOnly, lastReceivedAt: 20 };
    expect(selectSendingSession([receivedOlder, receivedNewer])?.sessionId).toBe(
      peerOnly.sessionId,
    );
    expect(selectSendingSession([receivedNewer, receivedOlder])?.sessionId).toBe(
      peerOnly.sessionId,
    );
  });

  it('accepts a simultaneous prekey session and converges on the deterministic winner', async () => {
    const { a, b } = await pair();
    const aFirst = await sendText(a, [recipientPlan(await claimBundleFromWorld(b))], 'a first');
    const bFirst = await sendText(b, [recipientPlan(await claimBundleFromWorld(a))], 'b first');
    expect(aFirst.sessionId).not.toBe(bFirst.sessionId);
    const winnerId = aFirst.sessionId < bFirst.sessionId ? aFirst.sessionId : bFirst.sessionId;

    // A accepts B's prekey envelope for an unknown session even though A has
    // its own session with B.
    const atA = await receiveFrom(a, b, bFirst.envelopes[0]!);
    expect(atA.text).toBe('b first');
    // Crossed sends: B also accepts A's first envelope, so both sides know the
    // same pair before either reply is sent.
    const atBFirst = await receiveFrom(b, a, aFirst.envelopes[0]!);
    expect(atBFirst.text).toBe('a first');
    const sessionsAtA = await listSessionsByPeer(a.storage, a.kStorage, CHAT, b.deviceId);
    expect(sessionsAtA).toHaveLength(2);

    const reply = await sendText(a, [recipientPlan(await claimBundleFromWorld(b))], 'a reply');
    expect(reply.sessionId).toBe(winnerId);
    expect(reply.envelopes[0]!.prekey ?? null).toBeNull();
    const atB = await receiveFrom(b, a, reply.envelopes[0]!);
    expect(atB.text).toBe('a reply');
    expect(atB.sessionId).toBe(winnerId);
  });
});

describe('E7-F4 envelope validation failures', () => {
  it('rejects a tampered preamble signature/identity before creating a session', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const sent = await sendText(a, [recipientPlan(bundle)], 'signed');
    const envelope = sent.envelopes[0]!;
    const opksBefore = await listOneTimePrekeys(b.storage);

    const badSignature = {
      ...envelope,
      prekey: {
        ...envelope.prekey!,
        signature: encodeBase64Url(new Uint8Array(64).fill(3)),
      },
    };
    await expect(receiveFrom(b, a, badSignature)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });

    const badIdentity = {
      ...envelope,
      prekey: {
        ...envelope.prekey!,
        sender_identity_dh_key: encodeBase64Url(new Uint8Array(32).fill(4)),
      },
    };
    await expect(receiveFrom(b, a, badIdentity)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });

    const staleGeneration = { ...envelope, sender_key_generation: 2 };
    await expect(receiveFrom(b, a, staleGeneration)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });
    const wrongRecipientGeneration = { ...envelope, recipient_key_generation: 2 };
    await expect(receiveFrom(b, a, wrongRecipientGeneration)).rejects.toMatchObject({
      code: 'KEY_GENERATION_STALE',
    });
    const wrongRecipient = {
      ...envelope,
      recipient_device_id: SESSION_IDS.b2,
    };
    await expect(receiveFrom(b, a, wrongRecipient)).rejects.toMatchObject({
      code: 'KEY_HANDSHAKE_INVALID',
    });

    expect(await loadSession(b.storage, b.kStorage, sent.sessionId)).toBeNull();
    expect((await listOneTimePrekeys(b.storage)).length).toBe(opksBefore.length);
  });

  it('rejects a normal envelope for an unknown session with NO_SESSION', async () => {
    const { a, b } = await pair();
    await sendText(a, [recipientPlan(await claimBundleFromWorld(b))], 'base');
    const forged: WireCryptoEnvelope = {
      v: 1,
      scheme: 'PAIRWISE_X3DH_DR',
      chat_id: CHAT,
      sender_device_id: a.deviceId,
      sender_key_generation: 1,
      recipient_device_id: b.deviceId,
      recipient_key_generation: 1,
      session_id: encodeBase64Url(new Uint8Array(16).fill(5)),
      header: {
        v: 1,
        dh: encodeBase64Url(new Uint8Array(32).fill(6)),
        pn: 0,
        n: 0,
      },
      ciphertext: encodeBase64Url(new Uint8Array(272).fill(7)),
    };
    await expect(receiveFrom(b, a, forged)).rejects.toMatchObject({ code: 'NO_SESSION' });
  });

  it('consumes the OPK exactly once when the same prekey envelope races', async () => {
    const { a, b } = await pair();
    const bundle = await claimBundleFromWorld(b);
    const sent = await sendText(a, [recipientPlan(bundle)], 'raced');
    const results = await Promise.allSettled([
      receiveFrom(b, a, sent.envelopes[0]!),
      receiveFrom(b, a, sent.envelopes[0]!),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(['SESSION_STATE_STALE', 'KEY_HANDSHAKE_INVALID']).toContain(
      (rejected[0] as PromiseRejectedResult).reason.code,
    );
    const remainingOpks = await listOneTimePrekeys(b.storage);
    expect(remainingOpks).toHaveLength(1);
    expect(remainingOpks.some((opk) => opk.keyId === bundle.oneTimePrekey?.keyId)).toBe(false);
    expect(await listSessionsByPeer(b.storage, b.kStorage, CHAT, a.deviceId)).toHaveLength(1);
  });
});

async function createTestSessionForSelection(): Promise<SessionState> {
  const { createTestSession } = await import('./test/fixtures');
  return createTestSession();
}

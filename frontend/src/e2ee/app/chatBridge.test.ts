/**
 * E7-F5 bridge integration: real F3+F4 modules, fake device transport.
 *
 * Two independently registered device worlds talk through `createE2eeBridge`
 * exactly as the store will: claim -> pin -> prepare/commit -> deliver ->
 * decrypt -> local copy. No network and no UI are involved.
 */
import { describe, expect, it } from 'vitest';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';
import { uuidToBytes } from '../encoding/bytes';
import { listOneTimePrekeys } from '../session/prekeyStore';
import { listSessionIds } from '../session/sessionStore';
import { makeDeviceKeyInfo, makeWireBundle } from '../test/deviceFixtures';
import { createTestWorld, DEFAULT_NOW, type TestWorld } from '../test/sessionFixtures';
import type {
  WireChatKeysResponse,
  WireCryptoEnvelope,
  WireKeyClaimRequest,
  WireKeyClaimResponse,
} from '../api/deviceKeys';
import type { E2eeDeviceTransport } from './chatBridge';
import { createE2eeBridge, type E2eeBridge } from './chatBridge';

const CHAT = '77777777-7777-4777-8777-777777777777';

interface Side {
  readonly world: TestWorld;
  readonly bridge: E2eeBridge;
  readonly transport: FakeTransport;
}

interface FakeTransport extends E2eeDeviceTransport {
  readonly claims: WireKeyClaimRequest[];
  readonly verifications: Array<{
    chatId: string;
    body: {
      device_id: string;
      method: 'QR' | 'MANUAL';
      vh_version: 2;
      safety_number_hash: string;
      expected_key_generation?: number;
    };
  }>;
  peerVerified: boolean;
}

async function opkQueue(world: TestWorld): Promise<Array<{ key_id: string; public_key: string }>> {
  const records = await listOneTimePrekeys(world.storage);
  return records
    .filter((record) => record.expiresAt >= world.now)
    .map((record) => ({ key_id: record.keyId, public_key: record.publicKey }));
}

function makeTransport(
  self: TestWorld,
  peer: () => TestWorld,
  peerOpks: Array<{ key_id: string; public_key: string }>,
): FakeTransport {
  const claims: WireKeyClaimRequest[] = [];
  const verifications: FakeTransport['verifications'] = [];
  const transport: FakeTransport = {
    claims,
    verifications,
    peerVerified: false,
    async registerDevice() {
      throw new Error('registerDevice must not be called for an already registered world');
    },
    async uploadPrekeys() {
      throw new Error('uploadPrekeys must not be called when OPKs are sufficient');
    },
    async getChatKeys(chatId): Promise<WireChatKeysResponse> {
      const other = peer();
      return {
        chat_id: chatId,
        security_mode: 'E2EE',
        my_device_id: self.deviceId,
        verifier_device_id: self.deviceId,
        verified_count: 0,
        verified_by_other_devices_count: 0,
        devices_total: 2,
        devices: [
          makeDeviceKeyInfo(self.identity, {
            device_id: self.deviceId,
            user_id: self.userId,
            is_self: true,
          }),
          makeDeviceKeyInfo(other.identity, {
            device_id: other.deviceId,
            user_id: other.userId,
            is_self: false,
            verified: transport.peerVerified ? true : null,
            verified_at: transport.peerVerified ? new Date(self.now).toISOString() : null,
            verification_method: transport.peerVerified ? 'MANUAL' : null,
          }),
        ],
      };
    },
    async claimPrekeys(request) {
      claims.push(request);
      const other = peer();
      const bundles = request.devices.map((requested) => {
        const opk = peerOpks.shift() ?? null;
        if (requested.device_id !== other.deviceId) {
          throw new Error('claim for a device outside the two-device world');
        }
        return makeWireBundle(other.identity, other.spk, {
          user_id: other.userId,
          device_id: other.deviceId,
          key_generation: other.identity.record.keyGeneration,
          one_time_prekey: opk,
          otp_exhausted: opk === null,
        });
      });
      return { bundles, unavailable: [] } as WireKeyClaimResponse;
    },
    async verifyDevice(chatId, body) {
      verifications.push({ chatId, body });
      const target = self.deviceId === body.device_id ? self : peer();
      return {
        chat_id: chatId,
        verifier_device_id: self.deviceId,
        device_id: body.device_id,
        key_generation: target.identity.record.keyGeneration,
        verified: true,
        verified_at: new Date(self.now).toISOString(),
        method: body.method,
      };
    },
  };
  return transport;
}

async function makeSide(
  world: TestWorld,
  peer: () => TestWorld,
  peerOpks: Array<{ key_id: string; public_key: string }>,
): Promise<Side> {
  const transport = makeTransport(world, peer, peerOpks);
  const bridge = createE2eeBridge({ storage: world.storage, transport, now: () => world.now });
  await bridge.initialize({
    userId: world.userId,
    name: 'E7-F5 bridge test',
    appVersion: '0.7.0',
  });
  return { world, bridge, transport };
}

async function makeWorlds(): Promise<{ alice: TestWorld; bob: TestWorld }> {
  const alice = await createTestWorld({
    userId: '11111111-1111-4111-8111-111111111111',
    deviceId: '33333333-3333-4333-8333-333333333333',
    now: DEFAULT_NOW,
    opkCount: 100,
  });
  const bob = await createTestWorld({
    userId: '22222222-2222-4222-8222-222222222222',
    deviceId: '55555555-5555-4555-8555-555555555555',
    now: DEFAULT_NOW,
    opkCount: 100,
  });
  return { alice, bob };
}

function incomingOf(
  prepared: { envelopes: readonly WireCryptoEnvelope[]; clientMessageId: string },
  id: string,
  senderUserId: string,
): {
  id: string;
  chatId: string;
  senderId: string;
  senderDeviceId: string;
  clientMessageId: string;
  createdAt: string;
  crypto: WireCryptoEnvelope;
} {
  const envelope = prepared.envelopes[0];
  if (!envelope) throw new Error('bridge test: no envelope');
  return {
    id,
    chatId: CHAT,
    senderId: senderUserId,
    senderDeviceId: envelope.sender_device_id,
    clientMessageId: prepared.clientMessageId,
    createdAt: new Date(DEFAULT_NOW).toISOString(),
    crypto: envelope,
  };
}

describe('E2EE chat bridge', () => {
  it('registers, loads chat keys, sends and receives with a sealed local copy', async () => {
    const { alice, bob } = await makeWorlds();
    const bobOpks = await opkQueue(bob);
    const aliceOpks = await opkQueue(alice);
    const aliceSide = await makeSide(alice, () => bob, bobOpks);
    const bobSide = await makeSide(bob, () => alice, aliceOpks);

    const snapshot = await aliceSide.bridge.loadChat({
      chatId: CHAT,
      serverMode: 'E2EE',
    });
    expect(snapshot.securityMode).toBe('E2EE');
    expect(snapshot.modeAction).toBe('allow_e2ee');
    expect(snapshot.peerDeviceIds).toEqual([bob.deviceId]);
    expect(snapshot.selfDeviceId).toBe(alice.deviceId);
    expect(snapshot.safetyNumbers[0]?.display).toMatch(/^(\d{5} ){11}\d{5}$/);
    expect(snapshot.safetyNumbers[0]?.qrPayload.startsWith('krug://verify/v1?')).toBe(true);

    const prepared = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'привет' });
    expect(prepared.kind).toBe('text');
    expect(prepared.envelopes).toHaveLength(1);
    expect(prepared.coverage.peerCovered).toBe(1);
    expect(aliceSide.transport.claims).toHaveLength(1);

    const received = await bobSide.bridge.receive(
      CHAT,
      incomingOf(prepared, '00000000-0000-4000-8000-000000000101', alice.userId),
    );
    expect(received.kind).toBe('message');
    if (received.kind !== 'message') throw new Error('expected a message');
    expect(received.text).toBe('привет');

    const copy = await bobSide.bridge.lookupLocalCopy(CHAT, '00000000-0000-4000-8000-000000000102');
    // The incoming copy is not in the outgoing namespace by design (P1-02).
    expect(copy).toBeNull();
  });

  it('builds a R-15 reset even when the server omitted clientMessageId', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));
    const bobSide = await makeSide(bob, () => alice, await opkQueue(alice));
    const sent = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'fail me' });
    const envelope = sent.envelopes[0]!;
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    ciphertext[ciphertext.length - 1] = (ciphertext[ciphertext.length - 1] ?? 0) ^ 0x01;
    const broken = { ...envelope, ciphertext: encodeBase64Url(ciphertext) };

    const outcome = await bobSide.bridge.receive(CHAT, {
      ...incomingOf(sent, '00000000-0000-4000-8000-000000000301', alice.userId),
      clientMessageId: null,
      crypto: broken,
    });
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('expected an error');
    expect(outcome.code).toBe('DECRYPT_FAILED');
    expect(outcome.reset).not.toBeNull();
    expect(outcome.reset?.retryOfClientMessageId).toBeNull();
  });

  it('reports a TOFU key change, blocks send until acceptObserved, then uses new keys', async () => {
    const { alice, bob } = await makeWorlds();
    const bobReplacement = await createTestWorld({
      userId: bob.userId,
      deviceId: bob.deviceId,
      now: DEFAULT_NOW,
      opkCount: 100,
    });
    let bobCurrent = bob;
    const bobOpks = await opkQueue(bobReplacement);
    const aliceSide = await makeSide(alice, () => bobCurrent, bobOpks);

    const first = await aliceSide.bridge.loadChat({ chatId: CHAT, serverMode: 'E2EE' });
    expect(first.keyChanges).toHaveLength(0);

    // Even if the server still returns a stale attestation, a TOFU key change
    // must force `verified=false` locally (P1-02 reset).
    aliceSide.transport.peerVerified = true;
    bobCurrent = bobReplacement;
    const changed = await aliceSide.bridge.loadChat({ chatId: CHAT, serverMode: 'E2EE' });
    expect(changed.keyChanges).toHaveLength(1);
    expect(changed.devices.find((device) => device.deviceId === bob.deviceId)?.verified).toBe(
      false,
    );
    expect(changed.keyChanges[0]?.deviceId).toBe(bob.deviceId);
    expect(changed.keyChanges[0]?.pinnedFingerprint).not.toBe(
      changed.keyChanges[0]?.observedFingerprint,
    );

    await expect(
      aliceSide.bridge.sendText({ chatId: CHAT, text: 'blocked' }),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });
    await expect(aliceSide.bridge.verifyDevice(CHAT, bob.deviceId, 'MANUAL')).rejects.toMatchObject(
      { code: 'KEY_CHANGE_DETECTED' },
    );

    await aliceSide.bridge.acceptKeyChange(bob.userId, bob.deviceId);
    const accepted = await aliceSide.bridge.loadChat({ chatId: CHAT, serverMode: 'E2EE' });
    expect(accepted.keyChanges).toHaveLength(0);
    const after = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'after accept' });
    expect(after.envelopes).toHaveLength(1);
  });

  it('does not reuse a pre-change session after the accepted new key', async () => {
    const { alice, bob } = await makeWorlds();
    const bobReplacement = await createTestWorld({
      userId: bob.userId,
      deviceId: bob.deviceId,
      now: DEFAULT_NOW,
      opkCount: 100,
    });
    let bobCurrent: TestWorld = bob;
    const aliceSide = await makeSide(alice, () => bobCurrent, await opkQueue(bobReplacement));
    const bobSide = await makeSide(bob, () => alice, await opkQueue(alice));

    // Bob sends first, so Alice already has a responder session bound to Bob's
    // old identity keys before the key change is detected.
    const fromBob = await bobSide.bridge.sendText({ chatId: CHAT, text: 'old key' });
    await aliceSide.bridge.receive(
      CHAT,
      incomingOf(fromBob, '00000000-0000-4000-8000-000000000401', bob.userId),
    );
    const sessionsBefore = await listSessionIds(alice.storage);
    expect(sessionsBefore).toHaveLength(1);
    expect(aliceSide.transport.claims).toHaveLength(0);

    bobCurrent = bobReplacement;
    const changed = await aliceSide.bridge.loadChat({ chatId: CHAT, serverMode: 'E2EE' });
    expect(changed.keyChanges).toHaveLength(1);

    // Blocked while unaccepted, and the old session is neither deleted nor
    // overwritten by the failed attempt.
    await expect(
      aliceSide.bridge.sendText({ chatId: CHAT, text: 'blocked' }),
    ).rejects.toMatchObject({ code: 'KEY_CHANGE_DETECTED' });
    expect(await listSessionIds(alice.storage)).toEqual(sessionsBefore);
    expect(aliceSide.transport.claims).toHaveLength(0);

    await aliceSide.bridge.acceptKeyChange(bob.userId, bob.deviceId);
    const after = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'after accept' });
    expect(after.envelopes).toHaveLength(1);
    // The accepted keys require a fresh prekey session; the old session stays
    // on disk (history is not deleted), but it must never carry new traffic.
    expect(after.envelopes[0]!.prekey).not.toBeNull();
    const sessionsAfter = await listSessionIds(alice.storage);
    expect(sessionsAfter).toContain(sessionsBefore[0]);
    expect(sessionsAfter).toHaveLength(2);
    expect(aliceSide.transport.claims).toHaveLength(1);
  });

  it('attests the safety number and reads verified back from DeviceKeyInfo', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));

    const before = await aliceSide.bridge.loadChat({ chatId: CHAT, serverMode: 'E2EE' });
    expect(before.devices.find((device) => device.deviceId === bob.deviceId)?.verified).toBe(false);
    expect(before.safetyNumbers[0]?.verificationHash).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const result = await aliceSide.bridge.verifyDevice(CHAT, bob.deviceId, 'MANUAL');
    expect(result).toMatchObject({ deviceId: bob.deviceId, verified: true, method: 'MANUAL' });
    expect(aliceSide.transport.verifications).toHaveLength(1);
    const body = aliceSide.transport.verifications[0]!.body;
    expect(body).toMatchObject({
      device_id: bob.deviceId,
      method: 'MANUAL',
      vh_version: 2,
      expected_key_generation: bob.identity.record.keyGeneration,
    });
    expect(decodeBase64Url(body.safety_number_hash)).toHaveLength(32);

    // The server now returns the attestation for THIS verifier device.
    aliceSide.transport.peerVerified = true;
    const after = await aliceSide.bridge.loadChat({ chatId: CHAT, serverMode: 'E2EE' });
    expect(after.devices.find((device) => device.deviceId === bob.deviceId)?.verified).toBe(true);
  });

  it('maps 409 KEY_CHANGED during attestation to a blocking key change', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));
    aliceSide.transport.verifyDevice = async () => {
      throw Object.assign(new Error('key changed'), {
        kind: 'key_changed',
        code: 'KEY_CHANGED',
        status: 409,
      });
    };
    await expect(aliceSide.bridge.verifyDevice(CHAT, bob.deviceId, 'MANUAL')).rejects.toMatchObject(
      { code: 'KEY_CHANGE_DETECTED' },
    );
  });

  it('never sends plaintext in the mode-alert / fresh-device flow', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));

    const alert = await aliceSide.bridge.loadChat({
      chatId: CHAT,
      serverMode: 'MANAGED',
      peerHasE2eeCapableDevices: true,
    });
    expect(alert.modeAction).toBe('block_security_alert');

    const confirm = await aliceSide.bridge.loadChat({
      chatId: CHAT,
      serverMode: 'MANAGED',
      peerHasE2eeCapableDevices: false,
      e2eeHistoryMarker: false,
    });
    expect(confirm.modeAction).toBe('confirm_mode_required');

    await aliceSide.bridge.confirmManagedMode(CHAT, []);
    const allowed = await aliceSide.bridge.loadChat({
      chatId: CHAT,
      serverMode: 'MANAGED',
      peerHasE2eeCapableDevices: false,
    });
    expect(allowed.modeAction).toBe('allow_plaintext');
  });

  it('receiver builds a reset; sender retries only the window after the anchor', async () => {
    const { alice, bob } = await makeWorlds();
    const bobOpks = await opkQueue(bob);
    const aliceOpks = await opkQueue(alice);
    const aliceSide = await makeSide(alice, () => bob, bobOpks);
    const bobSide = await makeSide(bob, () => alice, aliceOpks);

    const first = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm1' });
    const second = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm2' });
    expect(second.sessionId).toBe(first.sessionId);

    const received = await bobSide.bridge.receive(
      CHAT,
      incomingOf(first, '00000000-0000-4000-8000-000000000201', alice.userId),
    );
    expect(received.kind).toBe('message');

    const outcome = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset: {
        failedSessionId: first.sessionId,
        failedChainDh: encodeBase64Url(uuidToBytes(CHAT)),
        failedN: 1,
        reason: 'DECRYPT_FAILED',
        retryOfClientMessageId: second.clientMessageId,
      },
    });
    expect(outcome.status).toBe('pending');
    if (outcome.status !== 'pending') throw new Error('expected pending');
    expect(outcome.candidates.map((candidate) => candidate.text)).toEqual(['m2']);
    expect(outcome.remaining).toBe(0);

    // The failed session is gone, so another reset cannot be replayed.
    const replay = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset: {
        failedSessionId: first.sessionId,
        failedChainDh: encodeBase64Url(uuidToBytes(CHAT)),
        failedN: 1,
        reason: 'DECRYPT_FAILED',
        retryOfClientMessageId: second.clientMessageId,
      },
    });
    expect(replay).toEqual({ status: 'ignored', reason: 'duplicate' });

    // A fresh prekey session is used for the retry.
    const retried = await aliceSide.bridge.sendText({
      chatId: CHAT,
      text: 'm2',
      retryOfClientMessageId: second.clientMessageId,
      freshPrekey: true,
    });
    expect(retried.sessionId).not.toBe(first.sessionId);
    const delivered = await bobSide.bridge.receive(
      CHAT,
      incomingOf(retried, '00000000-0000-4000-8000-000000000202', alice.userId),
    );
    expect(delivered.kind).toBe('message');
  });

  it('does not lose a reset when the retry batch fails', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));
    const first = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm1' });
    const second = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm2' });
    const envelope = first.envelopes[0]!;
    const reset = {
      failedSessionId: first.sessionId,
      failedChainDh: envelope.header.dh,
      failedN: envelope.header.n,
      reason: 'DECRYPT_FAILED' as const,
      retryOfClientMessageId: first.clientMessageId,
    };

    const pending = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset,
    });
    expect(pending.status).toBe('pending');
    if (pending.status !== 'pending') throw new Error('expected pending');
    expect(pending.candidates.map((candidate) => candidate.text)).toEqual(['m1', 'm2']);

    // A failed batch must unmark the reset; the failed session stays so a
    // repeated reset can re-drive the window.
    await aliceSide.bridge.finishReset({
      chatId: CHAT,
      reset,
      failedSessionId: first.sessionId,
      status: 'failed',
    });
    const retry = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset,
    });
    expect(retry.status).toBe('pending');
    if (retry.status !== 'pending') throw new Error('expected pending retry');
    expect(retry.candidates.map((candidate) => candidate.text)).toEqual(['m1', 'm2']);

    // The broken session is not selected for a new normal send.
    const fresh = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'after failure' });
    expect(fresh.sessionId).not.toBe(first.sessionId);

    // Success deletes the failed session and keeps the reset deduplicated.
    await aliceSide.bridge.finishReset({
      chatId: CHAT,
      reset,
      failedSessionId: first.sessionId,
      status: 'completed',
    });
    expect(await listSessionIds(alice.storage)).not.toContain(first.sessionId);
    const replay = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset,
    });
    expect(replay.status).toBe('ignored');
    if (replay.status !== 'ignored') throw new Error('expected ignored');
    expect(replay.reason).toBe('duplicate');
    expect(second.sessionId).toBe(first.sessionId);
  });

  it('reuses the exact fresh retry session for the rest of the batch (P2-30)', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));
    const first = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm1' });
    await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm2' });
    const envelope = first.envelopes[0]!;
    const reset = {
      failedSessionId: first.sessionId,
      failedChainDh: envelope.header.dh,
      failedN: envelope.header.n,
      reason: 'DECRYPT_FAILED' as const,
      retryOfClientMessageId: first.clientMessageId,
    };
    const pending = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset,
    });
    expect(pending.status).toBe('pending');

    const retriedFirst = await aliceSide.bridge.sendText({
      chatId: CHAT,
      text: 'm1',
      freshPrekey: true,
    });
    const retriedSecond = await aliceSide.bridge.sendText({
      chatId: CHAT,
      text: 'm2',
      reuseSessionIds: retriedFirst.sessionIds,
    });
    expect(retriedSecond.sessionId).toBe(retriedFirst.sessionId);
    expect(retriedSecond.sessionId).not.toBe(first.sessionId);

    // A reuse id that is no longer available must produce a fresh prekey
    // session, never an old live session.
    const mismatched = await aliceSide.bridge.sendText({
      chatId: CHAT,
      text: 'm3',
      reuseSessionIds: ['AAAAAAAAAAAAAAAAAAAAAA'],
    });
    expect(mismatched.sessionId).not.toBe(first.sessionId);
    expect(mismatched.sessionId).not.toBe(retriedFirst.sessionId);
  });

  it('caps the retry window at MAX_RESET_BATCH and reports the remainder', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));
    const first = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'm0' });
    for (let index = 1; index <= 20; index += 1) {
      await aliceSide.bridge.sendText({ chatId: CHAT, text: `m${index}` });
    }
    const outcome = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset: {
        failedSessionId: first.sessionId,
        failedChainDh: encodeBase64Url(uuidToBytes(CHAT)),
        failedN: 0,
        reason: 'DECRYPT_FAILED',
        retryOfClientMessageId: first.clientMessageId,
      },
    });
    expect(outcome.status).toBe('pending');
    if (outcome.status !== 'pending') throw new Error('expected pending');
    expect(outcome.candidates).toHaveLength(20);
    expect(outcome.candidates[0]?.text).toBe('m0');
    expect(outcome.candidates[19]?.text).toBe('m19');
    expect(outcome.remaining).toBe(1);
  });

  it('ignores a reset whose anchor is unknown locally (no guessed wide retry)', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));
    const sent = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'only' });
    const outcome = await aliceSide.bridge.handleReset({
      chatId: CHAT,
      senderDeviceId: bob.deviceId,
      reset: {
        failedSessionId: sent.sessionId,
        failedChainDh: encodeBase64Url(uuidToBytes(CHAT)),
        failedN: 0,
        reason: 'DECRYPT_FAILED',
        retryOfClientMessageId: '99999999-9999-4999-8999-999999999999',
      },
    });
    expect(outcome).toEqual({ status: 'ignored', reason: 'anchor_unknown' });
  });
});

describe('G4e #30 durable retry state', () => {
  it('keeps the failed session while a replacement is pending and deletes it after confirmation', async () => {
    const { alice, bob } = await makeWorlds();
    const aliceSide = await makeSide(alice, () => bob, await opkQueue(bob));

    const original = await aliceSide.bridge.sendText({ chatId: CHAT, text: 'first' });
    await aliceSide.bridge.confirmSent(original.clientMessageId, {
      serverMessageId: '00000000-0000-4000-8000-000000000201',
      seq: 1,
    });
    const replacement = await aliceSide.bridge.sendText({
      chatId: CHAT,
      text: 'first',
      retryOfClientMessageId: original.clientMessageId,
    });
    const envelope = original.envelopes[0]!;
    const reset = {
      failedSessionId: original.sessionId,
      failedChainDh: envelope.header.dh,
      failedN: envelope.header.n,
      reason: 'DECRYPT_FAILED' as const,
      retryOfClientMessageId: original.clientMessageId,
    };
    await aliceSide.bridge.saveRetryState({
      chatId: CHAT,
      senderDeviceId: alice.deviceId,
      reset,
    });

    const pending = await aliceSide.bridge.reconcileRetryState(CHAT);
    expect(pending.statuses[0]).toMatchObject({ chatId: CHAT, pending: 1 });
    expect(pending.statuses[0]?.retries).toHaveLength(1);
    expect(pending.completedFailedSessionIds).toEqual([]);
    expect(await listSessionIds(alice.storage)).toContain(original.sessionId);

    await aliceSide.bridge.confirmSent(replacement.clientMessageId, {
      serverMessageId: '00000000-0000-4000-8000-000000000202',
      seq: 2,
    });
    const completed = await aliceSide.bridge.reconcileRetryState(CHAT);
    expect(completed.completedFailedSessionIds).toContain(original.sessionId);
    expect(completed.statuses[0]?.retries ?? []).toEqual([]);
    expect(await listSessionIds(alice.storage)).not.toContain(original.sessionId);
  });
});

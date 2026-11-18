/**
 * E7-F4 known-answer tests through the **production** session engine.
 *
 * B1/B2 X3DH, C2/C3 KDF and E1/E2 Double Ratchet vectors from
 * `docs/E2EE-TEST-VECTORS.json` are reproduced byte for byte by
 * `createInitiatorSession`/`ratchetSend`/`ratchetReceive` (no test-only copy of
 * the algorithm). F1/F2 envelope byte-exactness remains in `vectors.test.ts`
 * because the vector set has no Alice `IK_sig` private key to re-sign the
 * preamble; here every envelope field except that signature is compared.
 */
import { describe, expect, it } from 'vitest';
import { getVector, loadVectorFile } from './test/vectors';
import { bytesToHex, hexToBytes, uuidToBytes, zeros } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';
import { generateX25519KeyPair, x25519KeyPairFromPrivate } from './crypto/x25519';
import { generateEd25519KeyPair } from './crypto/ed25519';
import { sha256 } from './crypto/digest';
import { buildAd } from './protocol/ad';
import { encodeEnvelope } from './protocol/envelope';
import { encodeHeader, type ParsedHeader } from './protocol/header';
import { decodePrekeyBundle, type WirePrekeyBundle } from './api/deviceKeys';
import { verifyClaimedBundle } from './device/binding';
import type { VerifiedClaimedBundle } from './device/types';
import { createInitiatorSession, type LocalIdentityKeys } from './session/handshake';
import { assertFreshRatchetKey, ratchetReceive, ratchetSend } from './session/ratchet';
import type { SessionState } from './session/types';

const file = loadVectorFile();

interface E1Header {
  v: number;
  dh: string;
  pn: number;
  n: number;
}
interface E1Step {
  step: string;
  message_key: string;
  header: E1Header;
  ad_hex: string;
  ciphertext: string;
  plaintext_hex?: string;
}
interface E1InitialState {
  x3dh_sk: string;
  session_id: string;
  alice_ratchet_0_private: string;
  alice_ratchet_0_public: string;
  bob_signed_prekey_private: string;
  bob_signed_prekey_public: string;
  alice_ratchet_1_private: string;
  alice_ratchet_1_public: string;
  bob_ratchet_1_private: string;
  bob_ratchet_1_public: string;
  bob_ratchet_2_private: string;
  bob_ratchet_2_public: string;
}
interface E1Inputs {
  chat_id: string;
  sender_device_id: string;
  recipient_device_id: string;
  sender_identity_signing_key: string;
  sender_identity_dh_key: string;
  sender_ephemeral_key: string;
  recipient_identity_dh_key: string;
  recipient_identity_signing_key: string;
  recipient_spk_id: string;
  recipient_spk_public: string;
  recipient_opk_id: string;
  recipient_opk_public: string;
  session_id: string;
}
interface X3dhInputs {
  alice_identity_dh_private: string;
  alice_ephemeral_private: string;
  bob_identity_dh_public: string;
  bob_signed_prekey_public: string;
  bob_one_time_prekey_public: string | null;
  salt: string;
  info: string;
}
interface X3dhExpected {
  ikm: string;
  sk: string;
  session_id: string;
}

const b1 = getVector<{ inputs: X3dhInputs; expected: X3dhExpected }>(file, 'B1-X3DH-4DH');
const b2 = getVector<{ inputs: X3dhInputs; expected: X3dhExpected }>(
  file,
  'B2-X3DH-3DH-otp-exhausted',
);
const b3 = getVector<{
  inputs: { signing_seed: string; key_id: string; spk_public: string };
  expected: { signature_hex: string };
}>(file, 'B3-SPK-signature');
const b4 = getVector<{ inputs: E1Inputs; expected: { preamble: string; preamble_sha256: string } }>(
  file,
  'B4-prekey-preamble',
);
const b5 = getVector<{
  expected: { bob_identity_binding_signature: string };
}>(file, 'B5-identity-binding-signature');
const c2 = getVector<{
  inputs: { root_key: string; dh_output: string };
  expected: { root_key_next: string; chain_key_sending: string };
}>(file, 'C2-DR-root-step-alice-initial');
const c3 = getVector<{ inputs: { chain_key: string } }>(file, 'C3-DR-chain-3-messages');
const d1 = getVector<{ expected: { padded_hex: string } }>(file, 'D1-inner-payload-framing');
const e1 = getVector<{ initial_state: E1InitialState; expected_steps: E1Step[] }>(
  file,
  'E1-conversation-trace',
);
const f1 = getVector<{ expected: { envelope_json: string } }>(file, 'F1-envelope-prekey');
const f2 = getVector<{ expected: { envelope_json: string } }>(file, 'F2-envelope-no-prekey');
const e2 = getVector<{
  inputs: {
    session_id: string;
    chain_key_0: string;
    ratchet_public: string;
    chat_id: string;
    sender_device_id: string;
    recipient_device_id: string;
  };
  expected: {
    messages: Array<{
      n: number;
      message_key: string;
      header: E1Header;
      ad_hex: string;
      ciphertext: string;
      plaintext_hex: string;
    }>;
    delivery_order: number[];
    skipped_message_key_n1: string;
    receiver_state_after_m3: {
      Nr: number;
      stored_skipped: Array<{ n: number; message_key: string }>;
    };
    receiver_state_after_m2: {
      Nr: number;
      stored_skipped: Array<{ n: number; message_key: string }>;
    };
  };
}>(file, 'E2-skipped-key-trace');
const c3Vector = getVector<{
  expected: Array<{ n: number; message_key: string; next_chain_key: string }>;
}>(file, 'C3-DR-chain-3-messages');

const TXT = 11;
const a2b = { sender: b4.inputs.sender_device_id, recipient: b4.inputs.recipient_device_id };
const b2a = { sender: b4.inputs.recipient_device_id, recipient: b4.inputs.sender_device_id };

/** Bob's claim bundle as F1/F3 would deliver it (all bytes from the vectors). */
async function vectorBobBundle(withOpk: boolean): Promise<VerifiedClaimedBundle> {
  const wire: WirePrekeyBundle = {
    user_id: '00000000-0000-4000-8000-000000000002',
    device_id: b4.inputs.recipient_device_id,
    key_generation: 1,
    identity_signing_key: encodeBase64Url(hexToBytes(b4.inputs.recipient_identity_signing_key)),
    identity_dh_key: encodeBase64Url(hexToBytes(b4.inputs.recipient_identity_dh_key)),
    identity_binding_signature: encodeBase64Url(
      hexToBytes(b5.expected.bob_identity_binding_signature),
    ),
    identity_key_alg: 'Ed25519+X25519',
    signed_prekey: {
      key_id: b4.inputs.recipient_spk_id,
      public_key: encodeBase64Url(hexToBytes(b4.inputs.recipient_spk_public)),
      signature: encodeBase64Url(hexToBytes(b3.expected.signature_hex)),
    },
    one_time_prekey: withOpk
      ? {
          key_id: b4.inputs.recipient_opk_id,
          public_key: encodeBase64Url(hexToBytes(b4.inputs.recipient_opk_public)),
        }
      : null,
    otp_exhausted: !withOpk,
  };
  return verifyClaimedBundle(decodePrekeyBundle(wire));
}

/** Alice's local identity as required by `createInitiatorSession`. */
async function vectorAliceIdentity(): Promise<LocalIdentityKeys> {
  const dh = await x25519KeyPairFromPrivate(hexToBytes(b1.inputs.alice_identity_dh_private));
  const signing = await generateEd25519KeyPair();
  return {
    userId: '00000000-0000-4000-8000-000000000001',
    deviceId: b4.inputs.sender_device_id,
    keyGeneration: 1,
    signingPrivateKey: signing.privateKey,
    dhPrivateKey: dh.privateKey,
    identitySigningKey: hexToBytes(b4.inputs.sender_identity_signing_key),
    identityDhKey: hexToBytes(b4.inputs.sender_identity_dh_key),
  };
}

function vectorHeader(header: E1Header): ParsedHeader {
  return {
    v: 1,
    dh: hexToBytes(header.dh),
    pn: header.pn,
    n: header.n,
  };
}

async function buildStepAd(
  direction: { sender: string; recipient: string },
  header: ParsedHeader,
  prekey: boolean,
  preambleHash: Uint8Array,
): Promise<Uint8Array> {
  return buildAd({
    chatId: uuidToBytes(b4.inputs.chat_id),
    senderDeviceId: uuidToBytes(direction.sender),
    senderKeyGeneration: 1,
    recipientDeviceId: uuidToBytes(direction.recipient),
    recipientKeyGeneration: 1,
    sessionId: hexToBytes(b4.inputs.session_id),
    prekey,
    preambleHash,
    header,
  });
}

async function aliceWithVectorKeys(): Promise<Awaited<ReturnType<typeof createInitiatorSession>>> {
  const ephemeral = await x25519KeyPairFromPrivate(hexToBytes(b1.inputs.alice_ephemeral_private));
  const ratchet = await x25519KeyPairFromPrivate(
    hexToBytes(e1.initial_state.alice_ratchet_0_private),
  );
  return createInitiatorSession({
    identity: await vectorAliceIdentity(),
    chatId: b4.inputs.chat_id,
    bundle: await vectorBobBundle(true),
    ephemeralKeyPair: ephemeral,
    ratchetKeyPair: ratchet,
    now: 1,
  });
}

describe('E7-F4 KAT — B X3DH via createInitiatorSession', () => {
  it('B1 4-DH: session id and first sending chain match the vector', async () => {
    const created = await aliceWithVectorKeys();
    expect(encodeBase64Url(created.sessionId)).toBe(
      encodeBase64Url(hexToBytes(b1.expected.session_id)),
    );
    expect(bytesToHex(created.preamble)).toBe(b4.expected.preamble);
    expect(bytesToHex(await sha256(created.preamble))).toBe(b4.expected.preamble_sha256);
    expect(bytesToHex(created.session.dhPublicKey)).toBe(e1.initial_state.alice_ratchet_0_public);
    expect(bytesToHex(created.session.dhRemote as Uint8Array)).toBe(
      e1.initial_state.bob_signed_prekey_public,
    );
    // SK after the C2 root step: the chain key is verified through the m1 KAT.
    expect(bytesToHex(created.session.rootKey)).toBe(c2.expected.root_key_next);
  });

  it('B2 3-DH (otp_exhausted): DH4 omitted, different SK/SID', async () => {
    const ephemeral = await x25519KeyPairFromPrivate(hexToBytes(b2.inputs.alice_ephemeral_private));
    const ratchet = await x25519KeyPairFromPrivate(
      hexToBytes(e1.initial_state.alice_ratchet_0_private),
    );
    const created = await createInitiatorSession({
      identity: await vectorAliceIdentity(),
      chatId: b4.inputs.chat_id,
      bundle: await vectorBobBundle(false),
      ephemeralKeyPair: ephemeral,
      ratchetKeyPair: ratchet,
    });
    expect(encodeBase64Url(created.sessionId)).toBe(
      encodeBase64Url(hexToBytes(b2.expected.session_id)),
    );
    expect(created.otpExhausted).toBe(true);
    expect(created.prekey.opkId).toBeNull();
    expect(created.prekey.opkPublic).toBeNull();
  });

  it('rejects a ratchet pair that is an X3DH input (P1-9)', async () => {
    const identity = await vectorAliceIdentity();
    const ephemeral = await x25519KeyPairFromPrivate(hexToBytes(b1.inputs.alice_ephemeral_private));
    await expect(
      createInitiatorSession({
        identity,
        chatId: b4.inputs.chat_id,
        bundle: await vectorBobBundle(true),
        ephemeralKeyPair: ephemeral,
        ratchetKeyPair: ephemeral,
      }),
    ).rejects.toMatchObject({ code: 'KEY_HANDSHAKE_INVALID' });

    const other = await generateX25519KeyPair();
    expect(() =>
      assertFreshRatchetKey(other.publicKeyBytes, [identity.identityDhKey]),
    ).not.toThrow();
  });
});

describe('E7-F4 KAT — E1 Double Ratchet conversation', () => {
  it('reproduces m1, r1, m2 and r2 through the production ratchet', async () => {
    const created = await aliceWithVectorKeys();
    const preamble = created.preamble;
    const preambleHash = await sha256(preamble);
    const steps = e1.expected_steps;
    expect(steps).toHaveLength(4);

    const m1 = await ratchetSend(created.session, {
      plaintext: hexToBytes(d1.expected.padded_hex),
      buildAd: (header) => buildStepAd(a2b, header, true, preambleHash),
      now: 2,
    });
    expect(bytesToHex(m1.messageKey)).toBe(steps[0]!.message_key);
    expect(bytesToHex(encodeHeader(m1.header))).toBe(
      bytesToHex(
        encodeHeader({
          v: 1,
          dh: hexToBytes(steps[0]!.header.dh),
          pn: steps[0]!.header.pn,
          n: steps[0]!.header.n,
        }),
      ),
    );
    expect(bytesToHex(m1.ciphertext)).toBe(steps[0]!.ciphertext);

    // Alice receives Bob's r1 and ratchets with the documented fresh pair.
    const r1 = await ratchetReceive(m1.state, {
      header: vectorHeader(steps[1]!.header),
      ciphertext: hexToBytes(steps[1]!.ciphertext),
      buildAd: (header) => buildStepAd(b2a, header, false, zeros(32)),
      nextRatchetKeyPair: await x25519KeyPairFromPrivate(
        hexToBytes(e1.initial_state.alice_ratchet_1_private),
      ),
      now: 3,
    });
    expect(bytesToHex(r1.messageKey)).toBe(steps[1]!.message_key);
    expect(bytesToHex(r1.plaintext)).toBe(steps[1]!.plaintext_hex);
    expect(r1.dhRatchet).toBe(true);
    expect(bytesToHex(r1.state.dhPublicKey)).toBe(e1.initial_state.alice_ratchet_1_public);
    expect(r1.state.ns).toBe(0);
    expect(r1.state.pn).toBe(1);

    const m2 = await ratchetSend(r1.state, {
      plaintext: hexToBytes(steps[2]!.plaintext_hex as string),
      buildAd: (header) => buildStepAd(a2b, header, false, zeros(32)),
      now: 4,
    });
    expect(bytesToHex(m2.messageKey)).toBe(steps[2]!.message_key);
    expect(bytesToHex(encodeHeader(m2.header))).toBe(
      bytesToHex(
        encodeHeader({
          v: 1,
          dh: hexToBytes(steps[2]!.header.dh),
          pn: steps[2]!.header.pn,
          n: steps[2]!.header.n,
        }),
      ),
    );
    expect(bytesToHex(m2.ciphertext)).toBe(steps[2]!.ciphertext);

    // r2 only needs Alice's current DHs private; the next pair is fresh.
    const r2 = await ratchetReceive(m2.state, {
      header: vectorHeader(steps[3]!.header),
      ciphertext: hexToBytes(steps[3]!.ciphertext),
      buildAd: (header) => buildStepAd(b2a, header, false, zeros(32)),
      now: 5,
    });
    expect(bytesToHex(r2.messageKey)).toBe(steps[3]!.message_key);
    expect(bytesToHex(r2.plaintext)).toBe(steps[3]!.plaintext_hex);
    expect(r2.state.dhRemote).not.toBeNull();
    expect(bytesToHex(r2.state.dhRemote as Uint8Array)).toBe(steps[3]!.header.dh);
  });
});

describe('E7-F4 KAT — C KDF chains', () => {
  it('C2 root step and C3 chain produce the vector keys', async () => {
    const session: SessionState = {
      sessionId: encodeBase64Url(new Uint8Array(16).fill(TXT)),
      deviceId: b4.inputs.sender_device_id,
      chatId: b4.inputs.chat_id,
      peerUserId: '00000000-0000-4000-8000-000000000002',
      peerDeviceId: b4.inputs.recipient_device_id,
      peerIkSig: hexToBytes(b4.inputs.recipient_identity_signing_key),
      peerIkDh: hexToBytes(b4.inputs.recipient_identity_dh_key),
      rootKey: hexToBytes(c2.inputs.root_key),
      dhPrivateKey: (await generateX25519KeyPair()).privateKey,
      dhPublicKey: hexToBytes(e1.initial_state.alice_ratchet_0_public),
      dhRemote: null,
      chainSend: hexToBytes(c3.inputs.chain_key),
      chainRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: [],
      createdAt: 1,
      lastUsedAt: 1,
      localCopyRef: null,
      revision: 0,
    };
    let state = session;
    for (const expected of c3Vector.expected) {
      const step = await ratchetSend(state, {
        plaintext: new Uint8Array(0),
        buildAd: () => zeros(32),
        now: 2,
      });
      expect(step.header.n).toBe(expected.n);
      expect(bytesToHex(step.messageKey)).toBe(expected.message_key);
      state = step.state;
      expect(bytesToHex(state.chainSend as Uint8Array)).toBe(expected.next_chain_key);
    }
  });
});

describe('E7-F4 KAT — E2 skipped keys via the production ratchet', () => {
  const sessionId = encodeBase64Url(hexToBytes(e2.inputs.session_id));

  function senderState(): SessionState {
    return {
      sessionId,
      deviceId: e2.inputs.sender_device_id,
      chatId: e2.inputs.chat_id,
      peerUserId: '00000000-0000-4000-8000-000000000002',
      peerDeviceId: e2.inputs.recipient_device_id,
      peerIkSig: new Uint8Array(32).fill(1),
      peerIkDh: new Uint8Array(32).fill(2),
      rootKey: new Uint8Array(32).fill(3),
      dhPrivateKey: {} as CryptoKey,
      dhPublicKey: hexToBytes(e2.inputs.ratchet_public),
      dhRemote: hexToBytes(e2.inputs.ratchet_public),
      chainSend: hexToBytes(e2.inputs.chain_key_0),
      chainRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
      skipped: [],
      createdAt: 1,
      lastUsedAt: 1,
      localCopyRef: null,
      revision: 0,
    };
  }

  async function receiverState(): Promise<SessionState> {
    const pair = await generateX25519KeyPair();
    return {
      ...senderState(),
      deviceId: e2.inputs.recipient_device_id,
      peerUserId: '00000000-0000-4000-8000-000000000001',
      peerDeviceId: e2.inputs.sender_device_id,
      dhPrivateKey: pair.privateKey,
      chainSend: null,
      chainRecv: hexToBytes(e2.inputs.chain_key_0),
    };
  }

  const adFor = (header: ParsedHeader) =>
    buildAd({
      chatId: uuidToBytes(e2.inputs.chat_id),
      senderDeviceId: uuidToBytes(e2.inputs.sender_device_id),
      senderKeyGeneration: 1,
      recipientDeviceId: uuidToBytes(e2.inputs.recipient_device_id),
      recipientKeyGeneration: 1,
      sessionId: hexToBytes(e2.inputs.session_id),
      prekey: false,
      preambleHash: zeros(32),
      header,
    });

  it('derives n=0..2, delivers 0,2,1 and consumes the skipped n=1 key', async () => {
    const messages = e2.expected.messages;
    let sender = senderState();
    const produced: Array<{ ciphertext: Uint8Array; header: ParsedHeader }> = [];
    for (const expected of messages) {
      const step = await ratchetSend(sender, {
        plaintext: hexToBytes(expected.plaintext_hex),
        buildAd: adFor,
        now: 2,
      });
      expect(step.header.n).toBe(expected.n);
      expect(bytesToHex(step.messageKey)).toBe(expected.message_key);
      expect(bytesToHex(step.ciphertext)).toBe(expected.ciphertext);
      produced.push({ ciphertext: step.ciphertext, header: step.header });
      sender = step.state;
    }

    let receiver = await receiverState();

    const first = await ratchetReceive(receiver, {
      header: produced[0]!.header,
      ciphertext: produced[0]!.ciphertext,
      buildAd: adFor,
      now: 3,
    });
    expect(bytesToHex(first.plaintext)).toBe(messages[0]!.plaintext_hex);
    receiver = first.state;
    expect(receiver.nr).toBe(1);

    const third = await ratchetReceive(receiver, {
      header: produced[2]!.header,
      ciphertext: produced[2]!.ciphertext,
      buildAd: adFor,
      now: 4,
    });
    expect(bytesToHex(third.plaintext)).toBe(messages[2]!.plaintext_hex);
    expect(third.skippedStored).toBe(1);
    receiver = third.state;
    expect(receiver.nr).toBe(e2.expected.receiver_state_after_m3.Nr);
    expect(receiver.skipped.map((key) => key.n)).toEqual([1]);
    expect(bytesToHex(receiver.skipped[0]!.messageKey)).toBe(e2.expected.skipped_message_key_n1);

    const second = await ratchetReceive(receiver, {
      header: produced[1]!.header,
      ciphertext: produced[1]!.ciphertext,
      buildAd: adFor,
      now: 5,
    });
    expect(bytesToHex(second.plaintext)).toBe(messages[1]!.plaintext_hex);
    receiver = second.state;
    expect(receiver.nr).toBe(e2.expected.receiver_state_after_m2.Nr);
    expect(receiver.skipped).toHaveLength(0);

    // Replay of n=2 is rejected without changing the state.
    await expect(
      ratchetReceive(receiver, {
        header: produced[2]!.header,
        ciphertext: produced[2]!.ciphertext,
        buildAd: adFor,
        now: 6,
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_OR_OLD_MESSAGE' });
    expect(receiver.nr).toBe(e2.expected.receiver_state_after_m2.Nr);
  });

  it('rejects a gap larger than MAX_SKIP without moving the chain', async () => {
    const receiver = await receiverState();
    const header: ParsedHeader = {
      v: 1,
      dh: hexToBytes(e2.inputs.ratchet_public),
      pn: 0,
      n: 1001,
    };
    await expect(
      ratchetReceive(receiver, {
        header,
        ciphertext: new Uint8Array(272),
        buildAd: () =>
          buildAd({
            chatId: uuidToBytes(e2.inputs.chat_id),
            senderDeviceId: uuidToBytes(e2.inputs.sender_device_id),
            senderKeyGeneration: 1,
            recipientDeviceId: uuidToBytes(e2.inputs.recipient_device_id),
            recipientKeyGeneration: 1,
            sessionId: hexToBytes(e2.inputs.session_id),
            prekey: false,
            preambleHash: zeros(32),
            header,
          }),
        now: 3,
      }),
    ).rejects.toMatchObject({ code: 'SESSION_TOO_FAR_BEHIND' });
    expect(receiver.nr).toBe(0);
  });
});

describe('E7-F4 KAT — F envelope serialization from engine output', () => {
  it('F1: every field except the vector signature is byte-identical', async () => {
    const created = await aliceWithVectorKeys();
    const preambleHash = await sha256(created.preamble);
    const step = await ratchetSend(created.session, {
      plaintext: hexToBytes(d1.expected.padded_hex),
      buildAd: (header) => buildStepAd(a2b, header, true, preambleHash),
      now: 2,
    });
    const produced = encodeEnvelope({
      v: 1,
      scheme: 'PAIRWISE_X3DH_DR',
      chatId: b4.inputs.chat_id,
      senderDeviceId: b4.inputs.sender_device_id,
      senderKeyGeneration: 1,
      recipientDeviceId: b4.inputs.recipient_device_id,
      recipientKeyGeneration: 1,
      sessionId: hexToBytes(b4.inputs.session_id),
      header: step.header,
      ciphertext: step.ciphertext,
      prekey: created.prekey,
    });
    const expected = JSON.parse(f1.expected.envelope_json) as {
      prekey: { signature: string };
    };
    // The vector's Ed25519 private key for Alice is not published, so the
    // signature value cannot be reproduced; every other field is normative.
    expect(encodeBase64Url(new Uint8Array(0))).toBe('');
    expect({
      ...produced,
      prekey: { ...produced.prekey, signature: expected.prekey.signature },
    }).toEqual(expected);
    expect(produced.prekey?.signature.length).toBe(86);
  });

  it('F2: the non-prekey reply envelope matches byte for byte', async () => {
    const created = await aliceWithVectorKeys();
    const preambleHash = await sha256(created.preamble);
    const m1 = await ratchetSend(created.session, {
      plaintext: hexToBytes(d1.expected.padded_hex),
      buildAd: (header) => buildStepAd(a2b, header, true, preambleHash),
      now: 2,
    });
    const r1 = await ratchetReceive(m1.state, {
      header: vectorHeader(e1.expected_steps[1]!.header),
      ciphertext: hexToBytes(e1.expected_steps[1]!.ciphertext),
      buildAd: (header) => buildStepAd(b2a, header, false, zeros(32)),
      nextRatchetKeyPair: await x25519KeyPairFromPrivate(
        hexToBytes(e1.initial_state.alice_ratchet_1_private),
      ),
      now: 3,
    });
    const m2 = await ratchetSend(r1.state, {
      plaintext: hexToBytes(e1.expected_steps[2]!.plaintext_hex as string),
      buildAd: (header) => buildStepAd(a2b, header, false, zeros(32)),
      now: 4,
    });
    const produced = encodeEnvelope({
      v: 1,
      scheme: 'PAIRWISE_X3DH_DR',
      chatId: b4.inputs.chat_id,
      senderDeviceId: b4.inputs.sender_device_id,
      senderKeyGeneration: 1,
      recipientDeviceId: b4.inputs.recipient_device_id,
      recipientKeyGeneration: 1,
      sessionId: hexToBytes(b4.inputs.session_id),
      header: m2.header,
      ciphertext: m2.ciphertext,
      prekey: null,
    });
    expect(produced).toEqual(JSON.parse(f2.expected.envelope_json));
  });
});

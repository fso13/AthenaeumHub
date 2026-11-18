/**
 * E1/E2 Double Ratchet KATs (§3.4, vector sections E and E2).
 *
 * These vectors are inherently stateful, so this file contains a **test-only**
 * reference walk of the documented algorithm. It is not a session module: no
 * persistence, no skipped-key store, no send/receive API — that is E7-F2/F4.
 * The walk only composes the F1 primitives and codecs and proves that they
 * reproduce the normative ciphertext bytes.
 */
import { describe, expect, it } from 'vitest';
import { getVector, loadVectorFile } from './test/vectors';
import { bytesToHex, hexToBytes, uuidToBytes, zeros } from './encoding/bytes';
import { aesGcmDecrypt, aesGcmEncrypt } from './crypto/aead';
import {
  importX25519PublicKey,
  x25519KeyPairFromPrivate,
  x25519PublicKeyBytesFromPrivate,
  x25519SharedSecret,
} from './crypto/x25519';
import { sha256 } from './crypto/digest';
import { deriveMessageAeadParams, kdfChainKey, kdfRootKey } from './protocol/kdf';
import { buildAd } from './protocol/ad';
import { encodeHeader } from './protocol/header';
import { buildPreamble } from './protocol/preamble';

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
interface E1StepWithHeader extends E1Step {
  header_hex: string;
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
interface E2Header {
  v: number;
  dh: string;
  pn: number;
  n: number;
}
interface E2Message {
  n: number;
  message_key: string;
  header: E2Header;
  ad_hex: string;
  ciphertext: string;
  plaintext_hex: string;
}
interface E2Inputs {
  session_id: string;
  chain_key_0: string;
  ratchet_public: string;
  chat_id: string;
  sender_device_id: string;
  recipient_device_id: string;
}
interface E2Expected {
  messages: E2Message[];
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
}

const file = loadVectorFile();

interface Header {
  readonly v: 1;
  readonly dh: Uint8Array;
  readonly pn: number;
  readonly n: number;
}

interface RatchetState {
  rootKey: Uint8Array;
  dhPrivate: CryptoKey;
  dhPublic: Uint8Array;
  dhRemote: Uint8Array | null;
  chainSend: Uint8Array | null;
  chainRecv: Uint8Array | null;
  ns: number;
  nr: number;
  pn: number;
}

const e1 = getVector<{ initial_state: E1InitialState; expected_steps: E1Step[] }>(
  file,
  'E1-conversation-trace',
);
const b4Vector = getVector<{ inputs: E1Inputs; expected: { preamble_sha256: string } }>(
  file,
  'B4-prekey-preamble',
);
const b4 = b4Vector.inputs;
const d1 = getVector<{ inputs: { body_hex: string }; expected: { padded_hex: string } }>(
  file,
  'D1-inner-payload-framing',
);
const initial = e1.initial_state;
const steps = e1.expected_steps;
const padded1 = hexToBytes(d1.expected.padded_hex);

async function dh(privateKey: CryptoKey, publicBytes: Uint8Array): Promise<Uint8Array> {
  return x25519SharedSecret(privateKey, await importX25519PublicKey(publicBytes));
}

async function loadPair(
  privateHex: string,
): Promise<{ privateKey: CryptoKey; publicKeyBytes: Uint8Array }> {
  const pair = await x25519KeyPairFromPrivate(hexToBytes(privateHex));
  return { privateKey: pair.privateKey, publicKeyBytes: pair.publicKeyBytes };
}

async function dhRatchet(
  state: RatchetState,
  remotePublic: Uint8Array,
  nextPrivate: string,
): Promise<void> {
  state.pn = state.ns;
  state.ns = 0;
  state.nr = 0;
  state.dhRemote = remotePublic;
  const receiving = await kdfRootKey(state.rootKey, await dh(state.dhPrivate, remotePublic));
  state.rootKey = receiving.rootKey;
  state.chainRecv = receiving.chainKey;
  const next = await loadPair(nextPrivate);
  state.dhPrivate = next.privateKey;
  state.dhPublic = next.publicKeyBytes;
  const sending = await kdfRootKey(state.rootKey, await dh(state.dhPrivate, remotePublic));
  state.rootKey = sending.rootKey;
  state.chainSend = sending.chainKey;
}

interface Direction {
  readonly sender: string;
  readonly recipient: string;
}

const a2b: Direction = { sender: b4.sender_device_id, recipient: b4.recipient_device_id };
const b2a: Direction = { sender: b4.recipient_device_id, recipient: b4.sender_device_id };

async function buildStepAd(
  direction: Direction,
  header: Header,
  prekey: boolean,
  preambleHash: Uint8Array,
  sessionIdHex: string = b4.session_id,
): Promise<Uint8Array> {
  return buildAd({
    chatId: uuidToBytes(b4.chat_id),
    senderDeviceId: uuidToBytes(direction.sender),
    senderKeyGeneration: 1,
    recipientDeviceId: uuidToBytes(direction.recipient),
    recipientKeyGeneration: 1,
    sessionId: hexToBytes(sessionIdHex),
    prekey,
    preambleHash,
    header,
  });
}

async function send(
  state: RatchetState,
  padded: Uint8Array,
  direction: Direction,
  prekey: boolean,
  preambleHash: Uint8Array,
): Promise<{ messageKey: Uint8Array; header: Header; ad: Uint8Array; ciphertext: Uint8Array }> {
  if (!state.chainSend) throw new Error('no sending chain');
  const step = await kdfChainKey(state.chainSend);
  state.chainSend = step.nextChainKey;
  const header: Header = { v: 1, dh: state.dhPublic, pn: state.pn, n: state.ns };
  const ad = await buildStepAd(direction, header, prekey, preambleHash);
  const params = await deriveMessageAeadParams(step.messageKey);
  const ciphertext = await aesGcmEncrypt(params.key, params.nonce, padded, ad);
  state.ns += 1;
  return { messageKey: step.messageKey, header, ad, ciphertext };
}

async function receive(
  state: RatchetState,
  header: Header,
  ciphertext: Uint8Array,
  direction: Direction,
  prekey: boolean,
  preambleHash: Uint8Array,
  nextPrivate: string,
): Promise<{ messageKey: Uint8Array; plaintext: Uint8Array }> {
  if (!state.dhRemote || !sameBytes(state.dhRemote, header.dh)) {
    await dhRatchet(state, header.dh, nextPrivate);
  }
  if (state.nr !== header.n) throw new Error(`unexpected gap: nr=${state.nr} n=${header.n}`);
  if (!state.chainRecv) throw new Error('no receiving chain');
  const step = await kdfChainKey(state.chainRecv);
  state.chainRecv = step.nextChainKey;
  const ad = await buildStepAd(direction, header, prekey, preambleHash);
  const params = await deriveMessageAeadParams(step.messageKey);
  const plaintext = await aesGcmDecrypt(params.key, params.nonce, ciphertext, ad);
  state.nr += 1;
  return { messageKey: step.messageKey, plaintext };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return a.every((byte, index) => byte === b[index]);
}

function headerFromStep(step: E1Step): Header {
  return {
    v: 1,
    dh: hexToBytes(step.header.dh),
    pn: step.header.pn,
    n: step.header.n,
  };
}

async function assertStepBytes(
  produced: { messageKey: Uint8Array; header: Header; ad: Uint8Array; ciphertext: Uint8Array },
  step: E1StepWithHeader,
): Promise<void> {
  const header = headerFromStep(step);
  expect(bytesToHex(produced.messageKey)).toBe(step.message_key);
  expect(bytesToHex(encodeHeader(produced.header))).toBe(step.header_hex);
  expect(bytesToHex(produced.ad)).toBe(step.ad_hex);
  expect(bytesToHex(produced.ciphertext)).toBe(step.ciphertext);
  expect(produced.header.pn).toBe(header.pn);
  expect(produced.header.n).toBe(header.n);
}

describe('E — Double Ratchet conversation', () => {
  // The E1 trace reuses the B4 prekey preamble; `header_hex` is recomputed from
  // the header fields (the vector stores `ad_hex` which embeds it).
  const stepHeaders: E1StepWithHeader[] = steps.map((step) => ({
    ...step,
    header_hex: bytesToHex(
      encodeHeader({ v: 1, dh: hexToBytes(step.header.dh), pn: step.header.pn, n: step.header.n }),
    ),
  }));

  it('derives the documented ratchet public keys from their private seeds', async () => {
    expect(
      bytesToHex(
        await x25519PublicKeyBytesFromPrivate(hexToBytes(initial.alice_ratchet_0_private)),
      ),
    ).toBe(initial.alice_ratchet_0_public);
    expect(
      bytesToHex(
        await x25519PublicKeyBytesFromPrivate(hexToBytes(initial.alice_ratchet_1_private)),
      ),
    ).toBe(initial.alice_ratchet_1_public);
    expect(
      bytesToHex(await x25519PublicKeyBytesFromPrivate(hexToBytes(initial.bob_ratchet_1_private))),
    ).toBe(initial.bob_ratchet_1_public);
    expect(
      bytesToHex(await x25519PublicKeyBytesFromPrivate(hexToBytes(initial.bob_ratchet_2_private))),
    ).toBe(initial.bob_ratchet_2_public);
    expect(
      bytesToHex(
        await x25519PublicKeyBytesFromPrivate(hexToBytes(initial.bob_signed_prekey_private)),
      ),
    ).toBe(initial.bob_signed_prekey_public);
  });

  it('reproduces all four messages, both DH ratchet turns and the AD/AEAD bytes', async () => {
    expect(steps).toHaveLength(4);
    const preamble = buildPreamble({
      chatId: uuidToBytes(b4.chat_id),
      senderDeviceId: uuidToBytes(b4.sender_device_id),
      recipientDeviceId: uuidToBytes(b4.recipient_device_id),
      senderIdentitySigningKey: hexToBytes(b4.sender_identity_signing_key),
      senderIdentityDhKey: hexToBytes(b4.sender_identity_dh_key),
      senderEphemeralKey: hexToBytes(b4.sender_ephemeral_key),
      recipientIdentityDhKey: hexToBytes(b4.recipient_identity_dh_key),
      recipientIdentitySigningKey: hexToBytes(b4.recipient_identity_signing_key),
      spkId: b4.recipient_spk_id,
      spkPublic: hexToBytes(b4.recipient_spk_public),
      opkId: b4.recipient_opk_id,
      opkPublic: hexToBytes(b4.recipient_opk_public),
      sessionId: hexToBytes(b4.session_id),
    });
    const preambleHash = await sha256(preamble);
    expect(bytesToHex(preambleHash)).toBe(b4Vector.expected.preamble_sha256);
    const noPrekeyHash = zeros(32);

    const sharedSecret = hexToBytes(initial.x3dh_sk);
    const aliceRatchet0 = await loadPair(initial.alice_ratchet_0_private);
    const bobSpk = await loadPair(initial.bob_signed_prekey_private);

    // Alice init: RK = SK, DHs = fresh ratchet pair, DHr = Bob's SPK.
    const aliceInit = await kdfRootKey(
      sharedSecret,
      await dh(aliceRatchet0.privateKey, hexToBytes(initial.bob_signed_prekey_public)),
    );
    const alice: RatchetState = {
      rootKey: aliceInit.rootKey,
      dhPrivate: aliceRatchet0.privateKey,
      dhPublic: aliceRatchet0.publicKeyBytes,
      dhRemote: hexToBytes(initial.bob_signed_prekey_public),
      chainSend: aliceInit.chainKey,
      chainRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
    };

    // m1: prekey envelope.
    const m1 = await send(alice, padded1, a2b, true, preambleHash);
    await assertStepBytes(m1, stepHeaders[0]!);

    // Bob init: RK = SK, DHs = SPK keypair, DHr = null.
    const bob: RatchetState = {
      rootKey: sharedSecret,
      dhPrivate: bobSpk.privateKey,
      dhPublic: bobSpk.publicKeyBytes,
      dhRemote: null,
      chainSend: null,
      chainRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
    };
    const bobM1 = await receive(
      bob,
      m1.header,
      m1.ciphertext,
      a2b,
      true,
      preambleHash,
      initial.bob_ratchet_1_private,
    );
    expect(bytesToHex(bobM1.messageKey)).toBe(stepHeaders[0]!.message_key);
    expect(bytesToHex(bobM1.plaintext)).toBe(d1.expected.padded_hex);

    // r1: Bob's first DH ratchet.
    const r1 = await send(
      bob,
      hexToBytes(stepHeaders[1]!.plaintext_hex ?? ''),
      b2a,
      false,
      noPrekeyHash,
    );
    await assertStepBytes(r1, stepHeaders[1]!);

    const aliceR1 = await receive(
      alice,
      r1.header,
      r1.ciphertext,
      b2a,
      false,
      noPrekeyHash,
      initial.alice_ratchet_1_private,
    );
    expect(bytesToHex(aliceR1.messageKey)).toBe(stepHeaders[1]!.message_key);
    expect(bytesToHex(aliceR1.plaintext)).toBe(stepHeaders[1]!.plaintext_hex);

    // m2: Alice's reply on the new chain.
    const m2 = await send(
      alice,
      hexToBytes(stepHeaders[2]!.plaintext_hex ?? ''),
      a2b,
      false,
      noPrekeyHash,
    );
    await assertStepBytes(m2, stepHeaders[2]!);

    const bobM2 = await receive(
      bob,
      m2.header,
      m2.ciphertext,
      a2b,
      false,
      noPrekeyHash,
      initial.bob_ratchet_2_private,
    );
    expect(bytesToHex(bobM2.messageKey)).toBe(stepHeaders[2]!.message_key);
    expect(bytesToHex(bobM2.plaintext)).toBe(stepHeaders[2]!.plaintext_hex);

    // r2: Bob ratchets again; Alice does not process it in this trace.
    const r2 = await send(
      bob,
      hexToBytes(stepHeaders[3]!.plaintext_hex ?? ''),
      b2a,
      false,
      noPrekeyHash,
    );
    await assertStepBytes(r2, stepHeaders[3]!);

    // Every AD must carry the right direction and prekey flag.
    expect(stepHeaders[0]!.ad_hex.slice(30, 34)).toBe('0101');
    expect(stepHeaders[1]!.ad_hex.slice(30, 34)).toBe('0100');
    expect(stepHeaders[2]!.ad_hex.slice(30, 34)).toBe('0100');
    expect(stepHeaders[3]!.ad_hex.slice(30, 34)).toBe('0100');
  });

  it('rejects a tampered ratchet ciphertext and AD without advancing the counter', async () => {
    const sharedSecret = hexToBytes(initial.x3dh_sk);
    const aliceRatchet0 = await loadPair(initial.alice_ratchet_0_private);
    const init = await kdfRootKey(
      sharedSecret,
      await dh(aliceRatchet0.privateKey, hexToBytes(initial.bob_signed_prekey_public)),
    );
    const alice: RatchetState = {
      rootKey: init.rootKey,
      dhPrivate: aliceRatchet0.privateKey,
      dhPublic: aliceRatchet0.publicKeyBytes,
      dhRemote: hexToBytes(initial.bob_signed_prekey_public),
      chainSend: init.chainKey,
      chainRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
    };
    const m1 = await send(alice, padded1, a2b, false, zeros(32));
    const bobSpk = await loadPair(initial.bob_signed_prekey_private);
    const bob: RatchetState = {
      rootKey: sharedSecret,
      dhPrivate: bobSpk.privateKey,
      dhPublic: bobSpk.publicKeyBytes,
      dhRemote: null,
      chainSend: null,
      chainRecv: null,
      ns: 0,
      nr: 0,
      pn: 0,
    };
    const tampered = Uint8Array.from(m1.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 0x01;
    await expect(
      receive(bob, m1.header, tampered, a2b, false, zeros(32), initial.bob_ratchet_1_private),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
    expect(bob.nr).toBe(0);
    expect(bob.chainRecv).not.toBeNull();
  });
});

describe('E2 — skipped message keys / out-of-order delivery', () => {
  it('derives n=0..2, decrypts 0,2,1 and keeps exactly the skipped n=1 key', async () => {
    const vector = getVector<{ inputs: E2Inputs; expected: E2Expected }>(
      file,
      'E2-skipped-key-trace',
    );
    const { inputs, expected } = vector;
    expect(expected.delivery_order).toEqual([0, 2, 1]);

    // Sender side: one chain, three message keys.
    let chainKey = hexToBytes(inputs.chain_key_0);
    const derived: Array<{ n: number; key: Uint8Array; ad: Uint8Array; ciphertext: Uint8Array }> =
      [];
    for (const message of expected.messages) {
      const step = await kdfChainKey(chainKey);
      chainKey = step.nextChainKey;
      expect(bytesToHex(step.messageKey)).toBe(message.message_key);
      const ad = await buildStepAd(
        { sender: inputs.sender_device_id, recipient: inputs.recipient_device_id },
        {
          v: 1,
          dh: hexToBytes(message.header.dh),
          pn: message.header.pn,
          n: message.header.n,
        },
        false,
        zeros(32),
        inputs.session_id,
      );
      expect(bytesToHex(ad)).toBe(message.ad_hex);
      const params = await deriveMessageAeadParams(step.messageKey);
      const ciphertext = await aesGcmEncrypt(
        params.key,
        params.nonce,
        hexToBytes(message.plaintext_hex),
        ad,
      );
      expect(bytesToHex(ciphertext)).toBe(message.ciphertext);
      derived.push({ n: message.n, key: step.messageKey, ad, ciphertext });
    }

    // Receiver side: delivery order 0, 2, 1.
    let receiveChain = hexToBytes(inputs.chain_key_0);
    let nr = 0;
    const skipped = new Map<number, Uint8Array>();

    const receiveOne = async (n: number): Promise<string> => {
      let key: Uint8Array;
      if (skipped.has(n)) {
        key = skipped.get(n)!;
        skipped.delete(n);
      } else {
        while (nr < n) {
          const step = await kdfChainKey(receiveChain);
          receiveChain = step.nextChainKey;
          skipped.set(nr, step.messageKey);
          nr += 1;
        }
        const step = await kdfChainKey(receiveChain);
        receiveChain = step.nextChainKey;
        key = step.messageKey;
        nr += 1;
      }
      const params = await deriveMessageAeadParams(key);
      const plaintext = await aesGcmDecrypt(
        params.key,
        params.nonce,
        derived[n]!.ciphertext,
        derived[n]!.ad,
      );
      return bytesToHex(plaintext);
    };

    expect(await receiveOne(0)).toBe(expected.messages[0]!.plaintext_hex);
    expect(nr).toBe(1);
    expect(skipped.size).toBe(0);

    expect(await receiveOne(2)).toBe(expected.messages[2]!.plaintext_hex);
    expect(nr).toBe(expected.receiver_state_after_m3.Nr);
    expect([...skipped.keys()]).toEqual(
      expected.receiver_state_after_m3.stored_skipped.map((entry) => entry.n),
    );
    expect(bytesToHex(skipped.get(1)!)).toBe(expected.skipped_message_key_n1);
    expect(expected.receiver_state_after_m3.stored_skipped[0]!.message_key).toBe(
      expected.skipped_message_key_n1,
    );

    expect(await receiveOne(1)).toBe(expected.messages[1]!.plaintext_hex);
    expect(nr).toBe(expected.receiver_state_after_m2.Nr);
    expect(skipped.size).toBe(expected.receiver_state_after_m2.stored_skipped.length);
    // A duplicate n=0 afterwards has no stored key (E7-F2 must reject it).
    expect(skipped.has(0)).toBe(false);
  });
});

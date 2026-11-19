/**
 * Known-answer tests for the eight normative crypto sections of
 * `docs/E2EE-TEST-VECTORS.json` (v4 + E7-F2G addendum): A primitives, B X3DH,
 * C KDF, D AEAD, E Double Ratchet, E2 skipped keys, F envelope, G verification.
 * The local-storage AAD section (O) is verified by `kStorageKAT.test.ts`.
 *
 * E1/E2 need a stateful walk and live in `ratchet.test.ts`; this file covers the
 * stateless derivations and codecs. Every expected value comes from the vector
 * file — no value is duplicated in the test source.
 */
import { describe, expect, it } from 'vitest';
import { CRYPTO_SECTIONS, allVectors, getSection, getVector, loadVectorFile } from './test/vectors';
import { bytesToHex, hexToBytes, utf8, uuidToBytes } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';
import {
  ed25519KeyPairFromSeed,
  ed25519Sign,
  ed25519Verify,
  importEd25519PublicKey,
} from './crypto/ed25519';
import {
  importX25519PublicKey,
  x25519KeyPairFromPrivate,
  x25519SharedSecret,
} from './crypto/x25519';
import { aesGcmDecrypt, aesGcmEncrypt } from './crypto/aead';
import { sha256 } from './crypto/digest';
import { hkdfSha256 } from './crypto/hkdf';
import { deriveMessageAeadParams, kdfChainKey, kdfRootKey } from './protocol/kdf';
import { deriveX3dhSharedSecret } from './protocol/x3dh';
import { CONTENT_TYPE_TEXT_JSON, buildInnerPayload, parseInnerPayload } from './protocol/payload';
import {
  buildEnvelopeAd,
  buildEnvelopePreamble,
  envelopeHeaderBytes,
  parseEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
} from './protocol/envelope';
import { buildPreamble, parsePreamble, verifyPreambleSignature } from './protocol/preamble';
import {
  identityBindingMessage,
  spkSignatureMessage,
  verifyIdentityBinding,
  verifySpkSignature,
} from './protocol/signatures';
import { deviceFingerprint } from './verification/fingerprint';
import {
  buildSafetyNumberQrPayload,
  computeSafetyNumber,
  formatSafetyNumberDigits,
} from './verification/safetyNumber';
import { computeVerificationHash } from './verification/verificationHash';

interface A1Inputs {
  alice_private: string;
  alice_public: string;
  bob_private: string;
  bob_public: string;
}
interface A1Expected {
  shared_secret: string;
  alice_public_derived: string;
  bob_public_derived: string;
}
interface A2Inputs {
  private_seed: string;
  message: string;
}
interface A2Expected {
  public_key: string;
  signature: string;
}
interface A3Inputs {
  ikm: string;
  salt: string;
  info: string;
  length: number;
}
interface A3Expected {
  okm: string;
}
interface A4Inputs {
  key: string;
  nonce: string;
  plaintext: string;
  aad: string;
}
interface A4Expected {
  ciphertext_including_tag: string;
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
  dh1: string;
  dh2: string;
  dh3: string;
  dh4?: string | null;
  ikm: string;
  sk: string;
  session_id: string;
}
interface B3Inputs {
  signing_seed: string;
  signed_message: string;
  key_id: string;
  spk_public: string;
}
interface B3Expected {
  public_key: string;
  signature: string;
  signature_hex: string;
}
interface B4Inputs {
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
interface B4Expected {
  preamble: string;
  preamble_sha256: string;
  signature: string;
  signature_hex: string;
}
interface B5Inputs {
  domain: string;
  version: number;
  alice_ik_sig_public: string;
  alice_ik_dh_public: string;
  bob_ik_sig_public: string;
  bob_ik_dh_public: string;
  alice_signed_message: string;
  bob_signed_message: string;
}
interface B5Expected {
  alice_identity_binding_signature: string;
  bob_identity_binding_signature: string;
  alice_binding_verifies: boolean;
  bob_binding_verifies: boolean;
  mismatched_ik_dh_verifies: boolean;
  wrong_signer_verifies: boolean;
  signed_message_len: number;
}
interface C2Inputs {
  root_key: string;
  dh_output: string;
  salt: string;
  info: string;
  length: number;
}
interface C2Expected {
  root_key_next: string;
  chain_key_sending: string;
}
interface C3Inputs {
  chain_key: string;
}
interface C3ExpectedRow {
  n: number;
  message_key: string;
  next_chain_key: string;
}
interface D1Inputs {
  body_utf8: string;
  body_hex: string;
  body_len: number;
}
interface D1Expected {
  raw_len: number;
  padded_len: number;
  padding_zero_bytes: number;
  padded_hex: string;
}
interface D2Inputs {
  message_key: string;
  padded_plaintext_hex: string;
  ad_hex: string;
  ad_len: number;
}
interface D2Expected {
  aead_key: string;
  nonce: string;
  ciphertext_including_tag: string;
  ciphertext_len: number;
}
interface F1Expected {
  envelope_json: string;
  envelope_len_bytes: number;
  decoded: {
    header_hex: string;
    ad_hex: string;
    preamble_hex: string;
    preamble_sha256: string;
    ciphertext_hex: string;
    session_id_hex: string;
  };
}
interface F2Expected {
  envelope_json: string;
  envelope_len_bytes: number;
  decoded: {
    header_hex: string;
    ad_hex: string;
    ciphertext_hex: string;
  };
}
interface G1Inputs {
  identity_signing_key: string;
  identity_dh_key: string;
  domain: string;
}
interface G1Expected {
  alice_fingerprint: string;
  bob_fingerprint: string;
}
interface SafetyEntryJson {
  user_id: string;
  device_id: string;
  fingerprint: string;
}
interface G2Inputs {
  entries: [SafetyEntryJson, SafetyEntryJson];
}
interface G2Expected {
  sha512: string;
  digits: string;
  display: string;
  qr_payload: string;
}
interface G3Inputs {
  entries: [SafetyEntryJson, SafetyEntryJson];
}
interface G3Expected {
  sha512: string;
  digits: string;
  display: string;
}
interface G4Inputs {
  chat_id: string;
  verifier_user_id: string;
  verifier_device_id: string;
  target_device_id: string;
  target_key_generation: number;
  safety_number_digits: string;
  vh_version: number;
}
interface G4Expected {
  safety_number_hash: string;
  vh_version: number;
}
interface G5Inputs {
  chat_id: string;
  verifier_user_id: string;
  verifier_device_id_l1: string;
  verifier_device_id_l2: string;
  target_device_id: string;
  target_key_generation: number;
  l1_safety_number_digits: string;
  l2_safety_number_digits: string;
  l2_fingerprint: string;
}
interface G5Expected {
  l1_verification_hash: string;
  l2_verification_hash: string;
  hashes_differ: boolean;
  device_pair_digits_differ: boolean;
  verifier_device_bound_in_hash: boolean;
  l2_display: string;
}

const file = loadVectorFile();

describe('vector set', () => {
  it('is the v5 normative set with the E7-F2G addendum (48 unique vectors, 18 sections)', () => {
    expect(file.meta.vector_set_version).toBe(5);
    expect(file.sections).toHaveLength(18);
    const vectors = allVectors(file);
    expect(vectors).toHaveLength(48);
    expect(new Set(vectors.map((vector) => vector.id)).size).toBe(48);
    for (const section of file.sections) {
      expect(section.vectors.length).toBeGreaterThan(0);
    }
  });

  it('exposes the eight normative crypto sections with 24 vectors', () => {
    const counts = CRYPTO_SECTIONS.map((id) => getSection(file, id).vectors.length);
    expect(counts).toEqual([4, 5, 3, 3, 1, 1, 2, 5]);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(24);
    for (const id of CRYPTO_SECTIONS) {
      expect(getSection(file, id).normative).toBe(true);
    }
  });
});

describe('A — published primitive KATs', () => {
  it('A1 X25519 RFC 7748 §6.1', async () => {
    const vector = getVector<{ inputs: A1Inputs; expected: A1Expected }>(file, 'A1-X25519-RFC7748');
    const alice = await x25519KeyPairFromPrivate(hexToBytes(vector.inputs.alice_private));
    const bob = await x25519KeyPairFromPrivate(hexToBytes(vector.inputs.bob_private));
    expect(bytesToHex(alice.publicKeyBytes)).toBe(vector.inputs.alice_public);
    expect(bytesToHex(alice.publicKeyBytes)).toBe(vector.expected.alice_public_derived);
    expect(bytesToHex(bob.publicKeyBytes)).toBe(vector.expected.bob_public_derived);
    const aliceSecret = await x25519SharedSecret(alice.privateKey, bob.publicKey);
    const bobSecret = await x25519SharedSecret(bob.privateKey, alice.publicKey);
    expect(bytesToHex(aliceSecret)).toBe(vector.expected.shared_secret);
    expect(bytesToHex(bobSecret)).toBe(vector.expected.shared_secret);
    // Re-importing a public key must agree with the private key's public half.
    const alicePublic = await importX25519PublicKey(hexToBytes(vector.inputs.alice_public));
    expect(bytesToHex(await x25519SharedSecret(bob.privateKey, alicePublic))).toBe(
      vector.expected.shared_secret,
    );
    expect(alice.privateKey.extractable).toBe(false);
  });

  it('A2 Ed25519 RFC 8032 §7.1 TEST 1', async () => {
    const vector = getVector<{ inputs: A2Inputs; expected: A2Expected }>(
      file,
      'A2-Ed25519-RFC8032',
    );
    const keyPair = await ed25519KeyPairFromSeed(hexToBytes(vector.inputs.private_seed));
    expect(bytesToHex(keyPair.publicKeyBytes)).toBe(vector.expected.public_key);
    const message = hexToBytes(vector.inputs.message);
    const signature = await ed25519Sign(keyPair.privateKey, message);
    expect(bytesToHex(signature)).toBe(vector.expected.signature);
    expect(await ed25519Verify(keyPair.publicKey, message, signature)).toBe(true);
    expect(await ed25519Verify(keyPair.publicKey, hexToBytes('00'), signature)).toBe(false);
    expect(await ed25519Verify(keyPair.publicKey, message, signature.slice(0, 63))).toBe(false);
    expect(keyPair.privateKey.extractable).toBe(false);
  });

  it('A3 HKDF-SHA-256 RFC 5869 Test Case 1', async () => {
    const vector = getVector<{ inputs: A3Inputs; expected: A3Expected }>(
      file,
      'A3-HKDF-SHA256-RFC5869',
    );
    const okm = await hkdfSha256(
      hexToBytes(vector.inputs.ikm),
      hexToBytes(vector.inputs.salt),
      hexToBytes(vector.inputs.info),
      vector.inputs.length,
    );
    expect(bytesToHex(okm)).toBe(vector.expected.okm);
  });

  it('A4 AES-256-GCM NIST CAVP empty plaintext/AAD', async () => {
    const vector = getVector<{ inputs: A4Inputs; expected: A4Expected }>(file, 'A4-AES256GCM-NIST');
    const ciphertext = await aesGcmEncrypt(
      hexToBytes(vector.inputs.key),
      hexToBytes(vector.inputs.nonce),
      hexToBytes(vector.inputs.plaintext),
      hexToBytes(vector.inputs.aad),
    );
    expect(bytesToHex(ciphertext)).toBe(vector.expected.ciphertext_including_tag);
    const plaintext = await aesGcmDecrypt(
      hexToBytes(vector.inputs.key),
      hexToBytes(vector.inputs.nonce),
      ciphertext,
      hexToBytes(vector.inputs.aad),
    );
    expect(plaintext).toHaveLength(0);
  });
});

describe('B — X3DH, SPK signature, preamble, identity binding', () => {
  it('B1 X3DH 4-DH with one-time prekey', async () => {
    const vector = getVector<{ inputs: X3dhInputs; expected: X3dhExpected }>(file, 'B1-X3DH-4DH');
    const aliceIdentity = await x25519KeyPairFromPrivate(
      hexToBytes(vector.inputs.alice_identity_dh_private),
    );
    const aliceEphemeral = await x25519KeyPairFromPrivate(
      hexToBytes(vector.inputs.alice_ephemeral_private),
    );
    const result = await deriveX3dhSharedSecret({
      senderIdentityDhPrivateKey: aliceIdentity.privateKey,
      senderEphemeralPrivateKey: aliceEphemeral.privateKey,
      recipientIdentityDhPublicKey: await importX25519PublicKey(
        hexToBytes(vector.inputs.bob_identity_dh_public),
      ),
      recipientSignedPrekeyPublicKey: await importX25519PublicKey(
        hexToBytes(vector.inputs.bob_signed_prekey_public),
      ),
      recipientOneTimePrekeyPublicKey: await importX25519PublicKey(
        hexToBytes(vector.inputs.bob_one_time_prekey_public ?? ''),
      ),
    });
    expect(bytesToHex(result.dh1)).toBe(vector.expected.dh1);
    expect(bytesToHex(result.dh2)).toBe(vector.expected.dh2);
    expect(bytesToHex(result.dh3)).toBe(vector.expected.dh3);
    expect(bytesToHex(result.dh4 ?? new Uint8Array())).toBe(vector.expected.dh4);
    expect(bytesToHex(result.ikm)).toBe(vector.expected.ikm);
    expect(bytesToHex(result.sharedSecret)).toBe(vector.expected.sk);
    expect(bytesToHex(result.sessionId)).toBe(vector.expected.session_id);
  });

  it('B2 X3DH 3-DH with OTP exhausted', async () => {
    const vector = getVector<{ inputs: X3dhInputs; expected: X3dhExpected }>(
      file,
      'B2-X3DH-3DH-otp-exhausted',
    );
    expect(vector.inputs.bob_one_time_prekey_public).toBeNull();
    const aliceIdentity = await x25519KeyPairFromPrivate(
      hexToBytes(vector.inputs.alice_identity_dh_private),
    );
    const aliceEphemeral = await x25519KeyPairFromPrivate(
      hexToBytes(vector.inputs.alice_ephemeral_private),
    );
    const result = await deriveX3dhSharedSecret({
      senderIdentityDhPrivateKey: aliceIdentity.privateKey,
      senderEphemeralPrivateKey: aliceEphemeral.privateKey,
      recipientIdentityDhPublicKey: await importX25519PublicKey(
        hexToBytes(vector.inputs.bob_identity_dh_public),
      ),
      recipientSignedPrekeyPublicKey: await importX25519PublicKey(
        hexToBytes(vector.inputs.bob_signed_prekey_public),
      ),
      recipientOneTimePrekeyPublicKey: null,
    });
    expect(result.dh4).toBeNull();
    expect(bytesToHex(result.ikm)).toBe(vector.expected.ikm);
    expect(bytesToHex(result.sharedSecret)).toBe(vector.expected.sk);
    expect(bytesToHex(result.sessionId)).toBe(vector.expected.session_id);
  });

  it('B3 SPK signature (wire b64u + byte-level hex)', async () => {
    const vector = getVector<{ inputs: B3Inputs; expected: B3Expected }>(file, 'B3-SPK-signature');
    const signing = await ed25519KeyPairFromSeed(hexToBytes(vector.inputs.signing_seed));
    expect(bytesToHex(signing.publicKeyBytes)).toBe(vector.expected.public_key);
    expect(
      bytesToHex(spkSignatureMessage(vector.inputs.key_id, hexToBytes(vector.inputs.spk_public))),
    ).toBe(vector.inputs.signed_message);
    const signature = await ed25519Sign(
      signing.privateKey,
      spkSignatureMessage(vector.inputs.key_id, hexToBytes(vector.inputs.spk_public)),
    );
    expect(bytesToHex(signature)).toBe(vector.expected.signature_hex);
    expect(encodeBase64Url(signature)).toBe(vector.expected.signature);
    expect(
      await verifySpkSignature(
        signing.publicKey,
        vector.inputs.key_id,
        hexToBytes(vector.inputs.spk_public),
        signature,
      ),
    ).toBe(true);
    expect(
      await verifySpkSignature(
        signing.publicKey,
        'spk-2',
        hexToBytes(vector.inputs.spk_public),
        signature,
      ),
    ).toBe(false);
  });

  it('B4 prekey preamble (323 bytes) and its signature', async () => {
    const vector = getVector<{ inputs: B4Inputs; expected: B4Expected }>(
      file,
      'B4-prekey-preamble',
    );
    const preamble = buildPreamble({
      chatId: uuidToBytes(vector.inputs.chat_id),
      senderDeviceId: uuidToBytes(vector.inputs.sender_device_id),
      recipientDeviceId: uuidToBytes(vector.inputs.recipient_device_id),
      senderIdentitySigningKey: hexToBytes(vector.inputs.sender_identity_signing_key),
      senderIdentityDhKey: hexToBytes(vector.inputs.sender_identity_dh_key),
      senderEphemeralKey: hexToBytes(vector.inputs.sender_ephemeral_key),
      recipientIdentityDhKey: hexToBytes(vector.inputs.recipient_identity_dh_key),
      recipientIdentitySigningKey: hexToBytes(vector.inputs.recipient_identity_signing_key),
      spkId: vector.inputs.recipient_spk_id,
      spkPublic: hexToBytes(vector.inputs.recipient_spk_public),
      opkId: vector.inputs.recipient_opk_id,
      opkPublic: hexToBytes(vector.inputs.recipient_opk_public),
      sessionId: hexToBytes(vector.inputs.session_id),
    });
    expect(preamble).toHaveLength(323);
    expect(bytesToHex(preamble)).toBe(vector.expected.preamble);
    expect(bytesToHex(await sha256(preamble))).toBe(vector.expected.preamble_sha256);

    const parsed = parsePreamble(preamble);
    expect(parsed.spkId).toBe(vector.inputs.recipient_spk_id);
    expect(parsed.opkId).toBe(vector.inputs.recipient_opk_id);
    expect(bytesToHex(parsed.sessionId)).toBe(vector.inputs.session_id);
    expect(bytesToHex(parsed.senderEphemeralKey)).toBe(vector.inputs.sender_ephemeral_key);

    const signature = hexToBytes(vector.expected.signature_hex);
    expect(encodeBase64Url(signature)).toBe(vector.expected.signature);
    expect(
      await verifyPreambleSignature(
        hexToBytes(vector.inputs.sender_identity_signing_key),
        preamble,
        signature,
      ),
    ).toBe(true);
    const tampered = Uint8Array.from(preamble);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(
      await verifyPreambleSignature(
        hexToBytes(vector.inputs.sender_identity_signing_key),
        tampered,
        signature,
      ),
    ).toBe(false);
    expect(() => parsePreamble(preamble.slice(0, 300))).toThrow();
    expect(() => parsePreamble(Uint8Array.from([...preamble, 0]))).toThrow();
  });

  it('B5 identity binding signature (88-byte message)', async () => {
    const vector = getVector<{ inputs: B5Inputs; expected: B5Expected }>(
      file,
      'B5-identity-binding-signature',
    );
    const aliceMessage = identityBindingMessage(
      hexToBytes(vector.inputs.alice_ik_dh_public),
      hexToBytes(vector.inputs.alice_ik_sig_public),
    );
    const bobMessage = identityBindingMessage(
      hexToBytes(vector.inputs.bob_ik_dh_public),
      hexToBytes(vector.inputs.bob_ik_sig_public),
    );
    expect(aliceMessage).toHaveLength(vector.expected.signed_message_len);
    expect(bytesToHex(aliceMessage)).toBe(vector.inputs.alice_signed_message);
    expect(bytesToHex(bobMessage)).toBe(vector.inputs.bob_signed_message);

    expect(
      await verifyIdentityBinding(
        hexToBytes(vector.inputs.alice_ik_sig_public),
        hexToBytes(vector.inputs.alice_ik_dh_public),
        hexToBytes(vector.inputs.alice_ik_sig_public),
        hexToBytes(vector.expected.alice_identity_binding_signature),
      ),
    ).toBe(vector.expected.alice_binding_verifies);
    expect(
      await verifyIdentityBinding(
        hexToBytes(vector.inputs.bob_ik_sig_public),
        hexToBytes(vector.inputs.bob_ik_dh_public),
        hexToBytes(vector.inputs.bob_ik_sig_public),
        hexToBytes(vector.expected.bob_identity_binding_signature),
      ),
    ).toBe(vector.expected.bob_binding_verifies);
    // Binding over a different IK_dh must fail even with a valid signature.
    expect(
      await verifyIdentityBinding(
        hexToBytes(vector.inputs.alice_ik_sig_public),
        hexToBytes(vector.inputs.bob_ik_dh_public),
        hexToBytes(vector.inputs.alice_ik_sig_public),
        hexToBytes(vector.expected.alice_identity_binding_signature),
      ),
    ).toBe(vector.expected.mismatched_ik_dh_verifies);
    // A signature by Alice must not verify under Bob's signing key.
    expect(
      await verifyIdentityBinding(
        hexToBytes(vector.inputs.bob_ik_sig_public),
        hexToBytes(vector.inputs.alice_ik_dh_public),
        hexToBytes(vector.inputs.alice_ik_sig_public),
        hexToBytes(vector.expected.alice_identity_binding_signature),
      ),
    ).toBe(vector.expected.wrong_signer_verifies);
    // Public-key objects and raw bytes are interchangeable.
    expect(
      await verifyIdentityBinding(
        await importEd25519PublicKey(hexToBytes(vector.inputs.alice_ik_sig_public)),
        hexToBytes(vector.inputs.alice_ik_dh_public),
        hexToBytes(vector.inputs.alice_ik_sig_public),
        hexToBytes(vector.expected.alice_identity_binding_signature),
      ),
    ).toBe(true);
  });
});

describe('C — KDF chains', () => {
  it('C1 session-id derivation', async () => {
    const vector = getVector<{ inputs: A3Inputs; expected: A3Expected }>(
      file,
      'C1-HKDF-session-id',
    );
    const okm = await hkdfSha256(
      hexToBytes(vector.inputs.ikm),
      hexToBytes(vector.inputs.salt),
      utf8(vector.inputs.info),
      vector.inputs.length,
    );
    expect(bytesToHex(okm)).toBe(vector.expected.okm);
  });

  it('C2 DR root step', async () => {
    const vector = getVector<{ inputs: C2Inputs; expected: C2Expected }>(
      file,
      'C2-DR-root-step-alice-initial',
    );
    expect(vector.inputs.salt).toBe(vector.inputs.root_key);
    expect(vector.inputs.info).toBe('Krug/E2EE/v1/dr-root');
    expect(vector.inputs.length).toBe(64);
    const step = await kdfRootKey(
      hexToBytes(vector.inputs.root_key),
      hexToBytes(vector.inputs.dh_output),
    );
    expect(bytesToHex(step.rootKey)).toBe(vector.expected.root_key_next);
    expect(bytesToHex(step.chainKey)).toBe(vector.expected.chain_key_sending);
  });

  it('C3 DR chain of three message keys', async () => {
    const vector = getVector<{ inputs: C3Inputs; expected: C3ExpectedRow[] }>(
      file,
      'C3-DR-chain-3-messages',
    );
    expect(vector.expected).toHaveLength(3);
    let chainKey = hexToBytes(vector.inputs.chain_key);
    for (const row of vector.expected) {
      const step = await kdfChainKey(chainKey);
      expect(bytesToHex(step.messageKey)).toBe(row.message_key);
      expect(bytesToHex(step.nextChainKey)).toBe(row.next_chain_key);
      chainKey = step.nextChainKey;
    }
  });
});

describe('D — AEAD, framing and padding', () => {
  it('D1 inner payload framing', () => {
    const vector = getVector<{ inputs: D1Inputs; expected: D1Expected }>(
      file,
      'D1-inner-payload-framing',
    );
    const body = hexToBytes(vector.inputs.body_hex);
    expect(body).toHaveLength(vector.inputs.body_len);
    expect(new TextDecoder().decode(body)).toBe(vector.inputs.body_utf8);
    const padded = buildInnerPayload(CONTENT_TYPE_TEXT_JSON, body);
    expect(padded).toHaveLength(vector.expected.padded_len);
    expect(bytesToHex(padded)).toBe(vector.expected.padded_hex);
    expect(padded.length - (26 + body.length)).toBe(vector.expected.padding_zero_bytes);
    const parsed = parseInnerPayload(padded);
    expect(parsed.contentType).toBe(CONTENT_TYPE_TEXT_JSON);
    expect(bytesToHex(parsed.body)).toBe(vector.inputs.body_hex);
  });

  it('D2 AEAD of the first (prekey) message', async () => {
    const vector = getVector<{ inputs: D2Inputs; expected: D2Expected }>(
      file,
      'D2-message-aead-m1',
    );
    const ad = hexToBytes(vector.inputs.ad_hex);
    expect(ad).toHaveLength(vector.inputs.ad_len);
    const params = await deriveMessageAeadParams(hexToBytes(vector.inputs.message_key));
    expect(bytesToHex(params.key)).toBe(vector.expected.aead_key);
    expect(bytesToHex(params.nonce)).toBe(vector.expected.nonce);
    const padded = hexToBytes(vector.inputs.padded_plaintext_hex);
    const ciphertext = await aesGcmEncrypt(params.key, params.nonce, padded, ad);
    expect(ciphertext).toHaveLength(vector.expected.ciphertext_len);
    expect(bytesToHex(ciphertext)).toBe(vector.expected.ciphertext_including_tag);
    expect(bytesToHex(await aesGcmDecrypt(params.key, params.nonce, ciphertext, ad))).toBe(
      vector.inputs.padded_plaintext_hex,
    );
  });

  it('D3 AEAD of the second message (n=1, no prekey AD)', async () => {
    const vector = getVector<{ inputs: D2Inputs; expected: D2Expected }>(
      file,
      'D3-message-aead-m2',
    );
    const ad = hexToBytes(vector.inputs.ad_hex);
    const params = await deriveMessageAeadParams(hexToBytes(vector.inputs.message_key));
    expect(bytesToHex(params.key)).toBe(vector.expected.aead_key);
    expect(bytesToHex(params.nonce)).toBe(vector.expected.nonce);
    const ciphertext = await aesGcmEncrypt(
      params.key,
      params.nonce,
      hexToBytes(vector.inputs.padded_plaintext_hex),
      ad,
    );
    expect(bytesToHex(ciphertext)).toBe(vector.expected.ciphertext_including_tag);
  });
});

describe('F — envelope serialization', () => {
  it('F1 prekey envelope is byte-identical and its AD/preamble match', async () => {
    const vector = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey');
    const preambleInputs = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
    const parsed = parseEnvelopeJson(vector.expected.envelope_json);
    expect(serializeEnvelope(parsed)).toBe(vector.expected.envelope_json);
    expect(new TextEncoder().encode(serializeEnvelope(parsed))).toHaveLength(
      vector.expected.envelope_len_bytes,
    );
    expect(bytesToHex(envelopeHeaderBytes(parsed))).toBe(vector.expected.decoded.header_hex);
    expect(bytesToHex(parsed.ciphertext)).toBe(vector.expected.decoded.ciphertext_hex);
    expect(bytesToHex(parsed.sessionId)).toBe(vector.expected.decoded.session_id_hex);
    expect(parsed.prekey).not.toBeNull();

    const preamble = buildEnvelopePreamble(
      parsed,
      hexToBytes(preambleInputs.recipient_identity_signing_key),
    );
    expect(bytesToHex(preamble)).toBe(vector.expected.decoded.preamble_hex);
    expect(bytesToHex(await sha256(preamble))).toBe(vector.expected.decoded.preamble_sha256);
    expect(bytesToHex(await buildEnvelopeAd(parsed, preamble))).toBe(
      vector.expected.decoded.ad_hex,
    );

    // The prekey signature verifies over the rebuilt preamble.
    const signature = parsed.prekey?.signature ?? new Uint8Array();
    expect(
      await verifyPreambleSignature(
        parsed.prekey?.senderIdentitySigningKey ?? new Uint8Array(),
        preamble,
        signature,
      ),
    ).toBe(true);

    // Object input and JSON input produce the same parsed envelope.
    const fromObject = parseEnvelope(JSON.parse(vector.expected.envelope_json));
    expect(serializeEnvelope(fromObject)).toBe(vector.expected.envelope_json);
  });

  it('F2 non-prekey envelope is byte-identical with zero preamble hash', async () => {
    const vector = getVector<{ expected: F2Expected }>(file, 'F2-envelope-no-prekey');
    const parsed = parseEnvelopeJson(vector.expected.envelope_json);
    expect(parsed.prekey).toBeNull();
    expect(serializeEnvelope(parsed)).toBe(vector.expected.envelope_json);
    expect(serializeEnvelope(parsed)).not.toContain('prekey');
    expect(new TextEncoder().encode(serializeEnvelope(parsed))).toHaveLength(
      vector.expected.envelope_len_bytes,
    );
    expect(bytesToHex(envelopeHeaderBytes(parsed))).toBe(vector.expected.decoded.header_hex);
    expect(bytesToHex(parsed.ciphertext)).toBe(vector.expected.decoded.ciphertext_hex);
    expect(bytesToHex(await buildEnvelopeAd(parsed))).toBe(vector.expected.decoded.ad_hex);
    await expect(buildEnvelopeAd(parsed, new Uint8Array(32))).rejects.toThrow();
  });
});

describe('G — verification', () => {
  it('G1 device fingerprint hashes both identity keys', async () => {
    const vector = getVector<{ inputs: G1Inputs; expected: G1Expected }>(
      file,
      'G1-device-fingerprint',
    );
    const b5 = getVector<{ inputs: B5Inputs }>(file, 'B5-identity-binding-signature').inputs;
    expect(
      bytesToHex(
        await deviceFingerprint(
          hexToBytes(vector.inputs.identity_signing_key),
          hexToBytes(vector.inputs.identity_dh_key),
        ),
      ),
    ).toBe(vector.expected.alice_fingerprint);
    expect(
      bytesToHex(
        await deviceFingerprint(hexToBytes(b5.bob_ik_sig_public), hexToBytes(b5.bob_ik_dh_public)),
      ),
    ).toBe(vector.expected.bob_fingerprint);
  });

  it('G2 safety number is symmetric, 60 digits, 12 groups and QR-ready', async () => {
    const vector = getVector<{ inputs: G2Inputs; expected: G2Expected }>(file, 'G2-safety-number');
    const toEntry = (entry: SafetyEntryJson) => ({
      userId: entry.user_id,
      deviceId: entry.device_id,
      fingerprint: hexToBytes(entry.fingerprint),
    });
    const [first, second] = vector.inputs.entries;
    const forward = await computeSafetyNumber(toEntry(first), toEntry(second));
    const backward = await computeSafetyNumber(toEntry(second), toEntry(first));
    expect(bytesToHex(forward.digest)).toBe(vector.expected.sha512);
    expect(forward.digits).toBe(vector.expected.digits);
    expect(forward.display).toBe(vector.expected.display);
    expect(backward.digits).toBe(forward.digits);
    expect(backward.digest).toStrictEqual(forward.digest);
    expect(forward.digits).toHaveLength(60);
    expect(forward.display.split(' ')).toHaveLength(12);
    expect(forward.display.replace(/ /g, '')).toHaveLength(60);
    expect(formatSafetyNumberDigits(forward.digits)).toBe(forward.display);
    expect(
      buildSafetyNumberQrPayload(
        { deviceId: first.device_id, fingerprint: hexToBytes(first.fingerprint) },
        { deviceId: second.device_id, fingerprint: hexToBytes(second.fingerprint) },
      ),
    ).toBe(vector.expected.qr_payload);
  });

  it('G3 safety number changes after a peer key change', async () => {
    const vector = getVector<{ inputs: G3Inputs; expected: G3Expected }>(
      file,
      'G3-safety-number-after-key-change',
    );
    const toEntry = (entry: SafetyEntryJson) => ({
      userId: entry.user_id,
      deviceId: entry.device_id,
      fingerprint: hexToBytes(entry.fingerprint),
    });
    const [first, second] = vector.inputs.entries;
    const changed = await computeSafetyNumber(toEntry(first), toEntry(second));
    expect(bytesToHex(changed.digest)).toBe(vector.expected.sha512);
    expect(changed.digits).toBe(vector.expected.digits);
    expect(changed.display).toBe(vector.expected.display);
    const untouched = getVector<{ expected: G2Expected }>(file, 'G2-safety-number').expected;
    expect(changed.digits).not.toBe(untouched.digits);
  });

  it('G4 verification hash v2 binds the verifier device', async () => {
    const vector = getVector<{ inputs: G4Inputs; expected: G4Expected }>(
      file,
      'G4-verification-hash',
    );
    expect(vector.inputs.vh_version).toBe(2);
    expect(vector.expected.vh_version).toBe(2);
    expect(
      bytesToHex(
        await computeVerificationHash({
          chatId: vector.inputs.chat_id,
          verifierUserId: vector.inputs.verifier_user_id,
          verifierDeviceId: vector.inputs.verifier_device_id,
          targetDeviceId: vector.inputs.target_device_id,
          targetKeyGeneration: vector.inputs.target_key_generation,
          safetyNumberDigits: vector.inputs.safety_number_digits,
        }),
      ),
    ).toBe(vector.expected.safety_number_hash);
  });

  it('G5 two verifier devices of the same user get different hashes', async () => {
    const vector = getVector<{ inputs: G5Inputs; expected: G5Expected }>(
      file,
      'G5-verification-per-device',
    );
    const base = {
      chatId: vector.inputs.chat_id,
      verifierUserId: vector.inputs.verifier_user_id,
      targetDeviceId: vector.inputs.target_device_id,
      targetKeyGeneration: vector.inputs.target_key_generation,
    };
    const l1 = await computeVerificationHash({
      ...base,
      verifierDeviceId: vector.inputs.verifier_device_id_l1,
      safetyNumberDigits: vector.inputs.l1_safety_number_digits,
    });
    const l2 = await computeVerificationHash({
      ...base,
      verifierDeviceId: vector.inputs.verifier_device_id_l2,
      safetyNumberDigits: vector.inputs.l2_safety_number_digits,
    });
    expect(bytesToHex(l1)).toBe(vector.expected.l1_verification_hash);
    expect(bytesToHex(l2)).toBe(vector.expected.l2_verification_hash);
    expect(bytesToHex(l1)).not.toBe(bytesToHex(l2));
    expect(vector.inputs.l1_safety_number_digits).not.toBe(vector.inputs.l2_safety_number_digits);
    expect(formatSafetyNumberDigits(vector.inputs.l2_safety_number_digits)).toBe(
      vector.expected.l2_display,
    );
    expect(vector.expected.hashes_differ).toBe(true);
    expect(vector.expected.device_pair_digits_differ).toBe(true);
    // A u8(1) hash from the old format must never be accepted as v2.
    expect(vector.expected.verifier_device_bound_in_hash).toBe(true);
  });
});

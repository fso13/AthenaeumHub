/**
 * Browser-safe known-answer runner for the normative A/B/C/D/F/G sections of
 * `docs/E2EE-TEST-VECTORS.json` (E7-F7A).
 *
 * The caller supplies the parsed vector file; this module never imports
 * `node:fs` and never copies an expected crypto value. The Playwright spec
 * fetches the committed JSON in a real browser, so the same production
 * primitives that run in the app are measured against the normative bytes in
 * Chromium, Firefox and WebKit.
 *
 * The runner is also unit-tested in Node (WebCrypto) to keep the browser
 * harness itself honest.
 */
import { aesGcmDecrypt, aesGcmEncrypt } from '../crypto/aead';
import { sha256 } from '../crypto/digest';
import {
  ed25519KeyPairFromSeed,
  ed25519Sign,
  ed25519Verify,
  importEd25519PublicKey,
} from '../crypto/ed25519';
import { hkdfSha256 } from '../crypto/hkdf';
import {
  importX25519PublicKey,
  x25519KeyPairFromPrivate,
  x25519SharedSecret,
} from '../crypto/x25519';
import { encodeBase64Url } from '../encoding/base64url';
import { bytesToHex, hexToBytes, utf8, uuidToBytes } from '../encoding/bytes';
import { isE2eeError } from '../errors';
import {
  buildEnvelopeAd,
  buildEnvelopePreamble,
  envelopeHeaderBytes,
  parseEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
} from '../protocol/envelope';
import { deriveMessageAeadParams, kdfChainKey, kdfRootKey } from '../protocol/kdf';
import { CONTENT_TYPE_TEXT_JSON, buildInnerPayload, parseInnerPayload } from '../protocol/payload';
import { buildPreamble, parsePreamble, verifyPreambleSignature } from '../protocol/preamble';
import {
  identityBindingMessage,
  spkSignatureMessage,
  verifyIdentityBinding,
  verifySpkSignature,
} from '../protocol/signatures';
import { deriveX3dhSharedSecret } from '../protocol/x3dh';
import { deviceFingerprint } from '../verification/fingerprint';
import {
  buildSafetyNumberQrPayload,
  computeSafetyNumber,
  formatSafetyNumberDigits,
} from '../verification/safetyNumber';
import { computeVerificationHash } from '../verification/verificationHash';

export interface BrowserKatVector {
  readonly id: string;
  readonly kind: string;
  readonly note?: string;
  readonly source?: string;
  readonly inputs?: unknown;
  readonly expected?: unknown;
  readonly initial_state?: unknown;
  readonly expected_steps?: unknown;
}

export interface BrowserKatSection {
  readonly id: string;
  readonly title?: string;
  readonly normative: boolean;
  readonly vectors: readonly BrowserKatVector[];
}

export interface BrowserKatVectorFile {
  readonly meta: {
    readonly title?: string;
    readonly spec?: string;
    readonly status?: string;
    readonly vector_set_version: number;
  };
  readonly sections: readonly BrowserKatSection[];
}

export interface KatCaseResult {
  readonly id: string;
  readonly section: string;
  readonly checks: number;
  readonly ok: boolean;
  readonly error?: string;
}

export interface KatRunResult {
  readonly cases: readonly KatCaseResult[];
  readonly checks: number;
  readonly failures: number;
}

export type KatErrorCode = 'KAT_MISMATCH' | 'KAT_SOURCE_INVALID';

export class KatFailure extends Error {
  readonly code: KatErrorCode;

  constructor(code: KatErrorCode, message: string) {
    super(message);
    this.name = 'KatFailure';
    this.code = code;
  }
}

export interface Checker {
  bytes(label: string, actual: Uint8Array, expectedHex: string): void;
  equal(
    label: string,
    actual: string | number | boolean | null,
    expected: string | number | boolean | null,
  ): void;
  isTrue(label: string, actual: boolean): void;
  throwsCode(label: string, operation: () => unknown, code: string): void;
  rejectsCode(label: string, operation: () => Promise<unknown>, code: string): Promise<void>;
  count(): number;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' ? ` (${code})` : ''}: ${error.message}`;
  }
  return String(error);
}

function describeHexMismatch(expectedHex: string, actualHex: string): string {
  if (expectedHex.length !== actualHex.length) {
    return `length ${actualHex.length / 2} B != expected ${expectedHex.length / 2} B`;
  }
  let index = 0;
  while (index < expectedHex.length && expectedHex[index] === actualHex[index]) index += 1;
  const byte = Math.floor(index / 2);
  return `first mismatch at byte ${byte}: got ${actualHex.slice(index, index + 8)} != expected ${expectedHex.slice(index, index + 8)}`;
}

function createChecker(): Checker {
  let checks = 0;

  return {
    bytes(label, actual, expectedHex) {
      checks += 1;
      const actualHex = bytesToHex(actual);
      if (actualHex !== expectedHex) {
        throw new KatFailure(
          'KAT_MISMATCH',
          `${label}: ${describeHexMismatch(expectedHex, actualHex)}`,
        );
      }
    },
    equal(label, actual, expected) {
      checks += 1;
      if (actual !== expected) {
        throw new KatFailure(
          'KAT_MISMATCH',
          `${label}: got ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`,
        );
      }
    },
    isTrue(label, actual) {
      checks += 1;
      if (!actual) throw new KatFailure('KAT_MISMATCH', `${label}: expected true, got false`);
    },
    throwsCode(label, operation, code) {
      checks += 1;
      try {
        operation();
      } catch (error) {
        if (isE2eeError(error) && error.code === code) return;
        throw new KatFailure(
          'KAT_MISMATCH',
          `${label}: expected ${code}, got ${describeError(error)}`,
        );
      }
      throw new KatFailure(
        'KAT_MISMATCH',
        `${label}: expected ${code}, but the operation resolved`,
      );
    },
    async rejectsCode(label, operation, code) {
      checks += 1;
      try {
        await operation();
      } catch (error) {
        if (isE2eeError(error) && error.code === code) return;
        throw new KatFailure(
          'KAT_MISMATCH',
          `${label}: expected ${code}, got ${describeError(error)}`,
        );
      }
      throw new KatFailure(
        'KAT_MISMATCH',
        `${label}: expected ${code}, but the operation resolved`,
      );
    },
    count() {
      return checks;
    },
  };
}

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
}
interface G5Expected {
  l1_verification_hash: string;
  l2_verification_hash: string;
  l2_display: string;
  hashes_differ: boolean;
  device_pair_digits_differ: boolean;
  verifier_device_bound_in_hash: boolean;
}

/** Normative sections and their vector counts (E7-F1/F7A scope). */
const SECTION_COUNTS: Readonly<Record<string, number>> = {
  'A-primitives': 4,
  'B-x3dh': 5,
  'C-kdf': 3,
  'D-aead': 3,
  'F-envelope': 2,
  'G-verification': 5,
};

function toEntry(entry: SafetyEntryJson): {
  userId: string;
  deviceId: string;
  fingerprint: Uint8Array;
} {
  return {
    userId: entry.user_id,
    deviceId: entry.device_id,
    fingerprint: hexToBytes(entry.fingerprint),
  };
}

function getVector<T extends object>(
  file: BrowserKatVectorFile,
  vectorId: string,
): BrowserKatVector & T {
  for (const section of file.sections) {
    for (const vector of section.vectors) {
      if (vector.id === vectorId) return vector as BrowserKatVector & T;
    }
  }
  throw new KatFailure('KAT_SOURCE_INVALID', `${vectorId}: vector is missing from the JSON file`);
}

function validateVectorFile(file: BrowserKatVectorFile): void {
  if (!file || typeof file !== 'object' || !Array.isArray(file.sections)) {
    throw new KatFailure('KAT_SOURCE_INVALID', 'vector file must be a JSON object with sections');
  }
  if (file.meta?.vector_set_version !== 4) {
    throw new KatFailure(
      'KAT_SOURCE_INVALID',
      `meta.vector_set_version must be 4, got ${String(file.meta?.vector_set_version)}`,
    );
  }
  const seen = new Set<string>();
  let total = 0;
  for (const section of file.sections) {
    for (const vector of section.vectors) {
      if (seen.has(vector.id)) {
        throw new KatFailure('KAT_SOURCE_INVALID', `duplicate vector id ${vector.id}`);
      }
      seen.add(vector.id);
      total += 1;
    }
  }
  if (total === 0) throw new KatFailure('KAT_SOURCE_INVALID', 'vector file has no vectors');
  for (const [sectionId, expectedCount] of Object.entries(SECTION_COUNTS)) {
    const section = file.sections.find((candidate) => candidate.id === sectionId);
    if (!section) {
      throw new KatFailure('KAT_SOURCE_INVALID', `section ${sectionId} is missing`);
    }
    if (!section.normative) {
      throw new KatFailure('KAT_SOURCE_INVALID', `section ${sectionId} must be normative`);
    }
    if (section.vectors.length !== expectedCount) {
      throw new KatFailure(
        'KAT_SOURCE_INVALID',
        `section ${sectionId} must have ${expectedCount} vectors, got ${section.vectors.length}`,
      );
    }
  }
}

interface KatCase {
  readonly id: string;
  readonly section: string;
  run(file: BrowserKatVectorFile, check: Checker): Promise<void>;
}

const KAT_CASES: readonly KatCase[] = [
  {
    id: 'A1-X25519-RFC7748',
    section: 'A-primitives',
    async run(file, c) {
      const vector = getVector<{ inputs: A1Inputs; expected: A1Expected }>(
        file,
        'A1-X25519-RFC7748',
      );
      const alice = await x25519KeyPairFromPrivate(hexToBytes(vector.inputs.alice_private));
      const bob = await x25519KeyPairFromPrivate(hexToBytes(vector.inputs.bob_private));
      c.bytes('A1.alice_public', alice.publicKeyBytes, vector.inputs.alice_public);
      c.bytes(
        'A1.alice_public_derived',
        alice.publicKeyBytes,
        vector.expected.alice_public_derived,
      );
      c.bytes('A1.bob_public_derived', bob.publicKeyBytes, vector.expected.bob_public_derived);
      const aliceSecret = await x25519SharedSecret(alice.privateKey, bob.publicKey);
      const bobSecret = await x25519SharedSecret(bob.privateKey, alice.publicKey);
      c.bytes('A1.shared_secret_alice', aliceSecret, vector.expected.shared_secret);
      c.bytes('A1.shared_secret_bob', bobSecret, vector.expected.shared_secret);
      const alicePublic = await importX25519PublicKey(hexToBytes(vector.inputs.alice_public));
      c.bytes(
        'A1.shared_secret_imported_public',
        await x25519SharedSecret(bob.privateKey, alicePublic),
        vector.expected.shared_secret,
      );
      c.isTrue('A1.private_key_non_extractable', alice.privateKey.extractable === false);
    },
  },
  {
    id: 'A2-Ed25519-RFC8032',
    section: 'A-primitives',
    async run(file, c) {
      const vector = getVector<{ inputs: A2Inputs; expected: A2Expected }>(
        file,
        'A2-Ed25519-RFC8032',
      );
      const keyPair = await ed25519KeyPairFromSeed(hexToBytes(vector.inputs.private_seed));
      c.bytes('A2.public_key', keyPair.publicKeyBytes, vector.expected.public_key);
      const message = hexToBytes(vector.inputs.message);
      const signature = await ed25519Sign(keyPair.privateKey, message);
      c.bytes('A2.signature', signature, vector.expected.signature);
      c.isTrue('A2.signature_verifies', await ed25519Verify(keyPair.publicKey, message, signature));
      c.isTrue(
        'A2.tampered_message_rejected',
        !(await ed25519Verify(keyPair.publicKey, hexToBytes('00'), signature)),
      );
      c.isTrue(
        'A2.truncated_signature_rejected',
        !(await ed25519Verify(keyPair.publicKey, message, signature.slice(0, 63))),
      );
      c.isTrue('A2.private_key_non_extractable', keyPair.privateKey.extractable === false);
    },
  },
  {
    id: 'A3-HKDF-SHA256-RFC5869',
    section: 'A-primitives',
    async run(file, c) {
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
      c.bytes('A3.okm', okm, vector.expected.okm);
    },
  },
  {
    id: 'A4-AES256GCM-NIST',
    section: 'A-primitives',
    async run(file, c) {
      const vector = getVector<{ inputs: A4Inputs; expected: A4Expected }>(
        file,
        'A4-AES256GCM-NIST',
      );
      const ciphertext = await aesGcmEncrypt(
        hexToBytes(vector.inputs.key),
        hexToBytes(vector.inputs.nonce),
        hexToBytes(vector.inputs.plaintext),
        hexToBytes(vector.inputs.aad),
      );
      c.bytes('A4.ciphertext_including_tag', ciphertext, vector.expected.ciphertext_including_tag);
      const plaintext = await aesGcmDecrypt(
        hexToBytes(vector.inputs.key),
        hexToBytes(vector.inputs.nonce),
        ciphertext,
        hexToBytes(vector.inputs.aad),
      );
      c.equal('A4.plaintext_length', plaintext.length, 0);
    },
  },
  {
    id: 'B1-X3DH-4DH',
    section: 'B-x3dh',
    async run(file, c) {
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
      c.bytes('B1.dh1', result.dh1, vector.expected.dh1);
      c.bytes('B1.dh2', result.dh2, vector.expected.dh2);
      c.bytes('B1.dh3', result.dh3, vector.expected.dh3);
      c.bytes('B1.dh4', result.dh4 ?? new Uint8Array(), vector.expected.dh4 ?? '');
      c.bytes('B1.ikm', result.ikm, vector.expected.ikm);
      c.bytes('B1.sk', result.sharedSecret, vector.expected.sk);
      c.bytes('B1.session_id', result.sessionId, vector.expected.session_id);
    },
  },
  {
    id: 'B2-X3DH-3DH-otp-exhausted',
    section: 'B-x3dh',
    async run(file, c) {
      const vector = getVector<{ inputs: X3dhInputs; expected: X3dhExpected }>(
        file,
        'B2-X3DH-3DH-otp-exhausted',
      );
      c.isTrue('B2.opk_absent', vector.inputs.bob_one_time_prekey_public === null);
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
      c.isTrue('B2.dh4_omitted', result.dh4 === null);
      c.bytes('B2.ikm', result.ikm, vector.expected.ikm);
      c.bytes('B2.sk', result.sharedSecret, vector.expected.sk);
      c.bytes('B2.session_id', result.sessionId, vector.expected.session_id);
    },
  },
  {
    id: 'B3-SPK-signature',
    section: 'B-x3dh',
    async run(file, c) {
      const vector = getVector<{ inputs: B3Inputs; expected: B3Expected }>(
        file,
        'B3-SPK-signature',
      );
      const signing = await ed25519KeyPairFromSeed(hexToBytes(vector.inputs.signing_seed));
      c.bytes('B3.public_key', signing.publicKeyBytes, vector.expected.public_key);
      const message = spkSignatureMessage(
        vector.inputs.key_id,
        hexToBytes(vector.inputs.spk_public),
      );
      c.bytes('B3.signed_message', message, vector.inputs.signed_message);
      const signature = await ed25519Sign(signing.privateKey, message);
      c.bytes('B3.signature_hex', signature, vector.expected.signature_hex);
      c.equal('B3.signature_b64u', encodeBase64Url(signature), vector.expected.signature);
      c.isTrue(
        'B3.signature_verifies',
        await verifySpkSignature(
          signing.publicKey,
          vector.inputs.key_id,
          hexToBytes(vector.inputs.spk_public),
          signature,
        ),
      );
      c.isTrue(
        'B3.wrong_key_id_rejected',
        !(await verifySpkSignature(
          signing.publicKey,
          'spk-2',
          hexToBytes(vector.inputs.spk_public),
          signature,
        )),
      );
    },
  },
  {
    id: 'B4-prekey-preamble',
    section: 'B-x3dh',
    async run(file, c) {
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
      c.bytes('B4.preamble', preamble, vector.expected.preamble);
      c.bytes('B4.preamble_sha256', await sha256(preamble), vector.expected.preamble_sha256);

      const parsed = parsePreamble(preamble);
      c.equal('B4.parsed_spk_id', parsed.spkId, vector.inputs.recipient_spk_id);
      c.equal('B4.parsed_opk_id', parsed.opkId, vector.inputs.recipient_opk_id);
      c.bytes('B4.parsed_session_id', parsed.sessionId, vector.inputs.session_id);
      c.bytes('B4.parsed_ephemeral', parsed.senderEphemeralKey, vector.inputs.sender_ephemeral_key);

      const signature = hexToBytes(vector.expected.signature_hex);
      c.equal('B4.signature_b64u', encodeBase64Url(signature), vector.expected.signature);
      c.isTrue(
        'B4.signature_verifies',
        await verifyPreambleSignature(
          hexToBytes(vector.inputs.sender_identity_signing_key),
          preamble,
          signature,
        ),
      );
      const tampered = Uint8Array.from(preamble);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
      c.isTrue(
        'B4.tampered_preamble_rejected',
        !(await verifyPreambleSignature(
          hexToBytes(vector.inputs.sender_identity_signing_key),
          tampered,
          signature,
        )),
      );
      c.throwsCode(
        'B4.truncated_preamble_rejected',
        () => parsePreamble(preamble.slice(0, 300)),
        'INVALID_PREAMBLE',
      );
      c.throwsCode(
        'B4.trailing_byte_rejected',
        () => parsePreamble(Uint8Array.from([...preamble, 0])),
        'INVALID_PREAMBLE',
      );
    },
  },
  {
    id: 'B5-identity-binding-signature',
    section: 'B-x3dh',
    async run(file, c) {
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
      c.equal('B5.signed_message_len', aliceMessage.length, vector.expected.signed_message_len);
      c.bytes('B5.alice_signed_message', aliceMessage, vector.inputs.alice_signed_message);
      c.bytes('B5.bob_signed_message', bobMessage, vector.inputs.bob_signed_message);
      c.equal(
        'B5.alice_binding_verifies',
        await verifyIdentityBinding(
          hexToBytes(vector.inputs.alice_ik_sig_public),
          hexToBytes(vector.inputs.alice_ik_dh_public),
          hexToBytes(vector.inputs.alice_ik_sig_public),
          hexToBytes(vector.expected.alice_identity_binding_signature),
        ),
        vector.expected.alice_binding_verifies,
      );
      c.equal(
        'B5.bob_binding_verifies',
        await verifyIdentityBinding(
          hexToBytes(vector.inputs.bob_ik_sig_public),
          hexToBytes(vector.inputs.bob_ik_dh_public),
          hexToBytes(vector.inputs.bob_ik_sig_public),
          hexToBytes(vector.expected.bob_identity_binding_signature),
        ),
        vector.expected.bob_binding_verifies,
      );
      c.equal(
        'B5.mismatched_ik_dh_verifies',
        await verifyIdentityBinding(
          hexToBytes(vector.inputs.alice_ik_sig_public),
          hexToBytes(vector.inputs.bob_ik_dh_public),
          hexToBytes(vector.inputs.alice_ik_sig_public),
          hexToBytes(vector.expected.alice_identity_binding_signature),
        ),
        vector.expected.mismatched_ik_dh_verifies,
      );
      c.equal(
        'B5.wrong_signer_verifies',
        await verifyIdentityBinding(
          hexToBytes(vector.inputs.bob_ik_sig_public),
          hexToBytes(vector.inputs.alice_ik_dh_public),
          hexToBytes(vector.inputs.alice_ik_sig_public),
          hexToBytes(vector.expected.alice_identity_binding_signature),
        ),
        vector.expected.wrong_signer_verifies,
      );
      c.isTrue(
        'B5.key_object_verifies',
        await verifyIdentityBinding(
          await importEd25519PublicKey(hexToBytes(vector.inputs.alice_ik_sig_public)),
          hexToBytes(vector.inputs.alice_ik_dh_public),
          hexToBytes(vector.inputs.alice_ik_sig_public),
          hexToBytes(vector.expected.alice_identity_binding_signature),
        ),
      );
    },
  },
  {
    id: 'C1-HKDF-session-id',
    section: 'C-kdf',
    async run(file, c) {
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
      c.bytes('C1.okm', okm, vector.expected.okm);
    },
  },
  {
    id: 'C2-DR-root-step-alice-initial',
    section: 'C-kdf',
    async run(file, c) {
      const vector = getVector<{ inputs: C2Inputs; expected: C2Expected }>(
        file,
        'C2-DR-root-step-alice-initial',
      );
      c.equal('C2.salt_is_root_key', vector.inputs.salt, vector.inputs.root_key);
      c.equal('C2.info', vector.inputs.info, 'Krug/E2EE/v1/dr-root');
      c.equal('C2.length', vector.inputs.length, 64);
      const step = await kdfRootKey(
        hexToBytes(vector.inputs.root_key),
        hexToBytes(vector.inputs.dh_output),
      );
      c.bytes('C2.root_key_next', step.rootKey, vector.expected.root_key_next);
      c.bytes('C2.chain_key_sending', step.chainKey, vector.expected.chain_key_sending);
    },
  },
  {
    id: 'C3-DR-chain-3-messages',
    section: 'C-kdf',
    async run(file, c) {
      const vector = getVector<{ inputs: C3Inputs; expected: C3ExpectedRow[] }>(
        file,
        'C3-DR-chain-3-messages',
      );
      c.equal('C3.rows', vector.expected.length, 3);
      let chainKey = hexToBytes(vector.inputs.chain_key);
      for (const row of vector.expected) {
        const step = await kdfChainKey(chainKey);
        c.bytes(`C3.n${row.n}.message_key`, step.messageKey, row.message_key);
        c.bytes(`C3.n${row.n}.next_chain_key`, step.nextChainKey, row.next_chain_key);
        chainKey = step.nextChainKey;
      }
    },
  },
  {
    id: 'D1-inner-payload-framing',
    section: 'D-aead',
    async run(file, c) {
      const vector = getVector<{ inputs: D1Inputs; expected: D1Expected }>(
        file,
        'D1-inner-payload-framing',
      );
      const body = hexToBytes(vector.inputs.body_hex);
      c.equal('D1.body_len', body.length, vector.inputs.body_len);
      c.equal('D1.body_utf8', new TextDecoder().decode(body), vector.inputs.body_utf8);
      const padded = buildInnerPayload(CONTENT_TYPE_TEXT_JSON, body);
      c.equal('D1.padded_len', padded.length, vector.expected.padded_len);
      c.bytes('D1.padded_hex', padded, vector.expected.padded_hex);
      c.equal(
        'D1.padding_zero_bytes',
        padded.length - (26 + body.length),
        vector.expected.padding_zero_bytes,
      );
      const parsed = parseInnerPayload(padded);
      c.equal('D1.content_type', parsed.contentType, CONTENT_TYPE_TEXT_JSON);
      c.bytes('D1.parsed_body', parsed.body, vector.inputs.body_hex);
    },
  },
  {
    id: 'D2-message-aead-m1',
    section: 'D-aead',
    async run(file, c) {
      const vector = getVector<{ inputs: D2Inputs; expected: D2Expected }>(
        file,
        'D2-message-aead-m1',
      );
      const ad = hexToBytes(vector.inputs.ad_hex);
      c.equal('D2.ad_len', ad.length, vector.inputs.ad_len);
      const params = await deriveMessageAeadParams(hexToBytes(vector.inputs.message_key));
      c.bytes('D2.aead_key', params.key, vector.expected.aead_key);
      c.bytes('D2.nonce', params.nonce, vector.expected.nonce);
      const padded = hexToBytes(vector.inputs.padded_plaintext_hex);
      const ciphertext = await aesGcmEncrypt(params.key, params.nonce, padded, ad);
      c.equal('D2.ciphertext_len', ciphertext.length, vector.expected.ciphertext_len);
      c.bytes('D2.ciphertext_including_tag', ciphertext, vector.expected.ciphertext_including_tag);
      c.bytes(
        'D2.decrypts_to_padded_plaintext',
        await aesGcmDecrypt(params.key, params.nonce, ciphertext, ad),
        vector.inputs.padded_plaintext_hex,
      );
    },
  },
  {
    id: 'D3-message-aead-m2',
    section: 'D-aead',
    async run(file, c) {
      const vector = getVector<{ inputs: D2Inputs; expected: D2Expected }>(
        file,
        'D3-message-aead-m2',
      );
      const ad = hexToBytes(vector.inputs.ad_hex);
      const params = await deriveMessageAeadParams(hexToBytes(vector.inputs.message_key));
      c.bytes('D3.aead_key', params.key, vector.expected.aead_key);
      c.bytes('D3.nonce', params.nonce, vector.expected.nonce);
      const ciphertext = await aesGcmEncrypt(
        params.key,
        params.nonce,
        hexToBytes(vector.inputs.padded_plaintext_hex),
        ad,
      );
      c.bytes('D3.ciphertext_including_tag', ciphertext, vector.expected.ciphertext_including_tag);
    },
  },
  {
    id: 'F1-envelope-prekey',
    section: 'F-envelope',
    async run(file, c) {
      const vector = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey');
      const preambleInputs = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
      const parsed = parseEnvelopeJson(vector.expected.envelope_json);
      c.equal('F1.serialize_roundtrip', serializeEnvelope(parsed), vector.expected.envelope_json);
      c.equal(
        'F1.envelope_len_bytes',
        new TextEncoder().encode(serializeEnvelope(parsed)).length,
        vector.expected.envelope_len_bytes,
      );
      c.bytes('F1.header_hex', envelopeHeaderBytes(parsed), vector.expected.decoded.header_hex);
      c.bytes('F1.ciphertext_hex', parsed.ciphertext, vector.expected.decoded.ciphertext_hex);
      c.bytes('F1.session_id_hex', parsed.sessionId, vector.expected.decoded.session_id_hex);
      c.isTrue('F1.has_prekey', parsed.prekey !== null);

      const preamble = buildEnvelopePreamble(
        parsed,
        hexToBytes(preambleInputs.recipient_identity_signing_key),
      );
      c.bytes('F1.preamble_hex', preamble, vector.expected.decoded.preamble_hex);
      c.bytes(
        'F1.preamble_sha256',
        await sha256(preamble),
        vector.expected.decoded.preamble_sha256,
      );
      c.bytes('F1.ad_hex', await buildEnvelopeAd(parsed, preamble), vector.expected.decoded.ad_hex);
      c.isTrue(
        'F1.prekey_signature_verifies',
        await verifyPreambleSignature(
          parsed.prekey?.senderIdentitySigningKey ?? new Uint8Array(),
          preamble,
          parsed.prekey?.signature ?? new Uint8Array(),
        ),
      );
      c.equal(
        'F1.object_input_roundtrip',
        serializeEnvelope(parseEnvelope(JSON.parse(vector.expected.envelope_json))),
        vector.expected.envelope_json,
      );
    },
  },
  {
    id: 'F2-envelope-no-prekey',
    section: 'F-envelope',
    async run(file, c) {
      const vector = getVector<{ expected: F2Expected }>(file, 'F2-envelope-no-prekey');
      const parsed = parseEnvelopeJson(vector.expected.envelope_json);
      c.isTrue('F2.has_no_prekey', parsed.prekey === null);
      c.equal('F2.serialize_roundtrip', serializeEnvelope(parsed), vector.expected.envelope_json);
      c.isTrue('F2.serialized_has_no_prekey', !serializeEnvelope(parsed).includes('prekey'));
      c.equal(
        'F2.envelope_len_bytes',
        new TextEncoder().encode(serializeEnvelope(parsed)).length,
        vector.expected.envelope_len_bytes,
      );
      c.bytes('F2.header_hex', envelopeHeaderBytes(parsed), vector.expected.decoded.header_hex);
      c.bytes('F2.ciphertext_hex', parsed.ciphertext, vector.expected.decoded.ciphertext_hex);
      c.bytes('F2.ad_hex', await buildEnvelopeAd(parsed), vector.expected.decoded.ad_hex);
      await c.rejectsCode(
        'F2.preamble_on_non_prekey_rejected',
        () => buildEnvelopeAd(parsed, new Uint8Array(32)),
        'INVALID_ENVELOPE_FORMAT',
      );
    },
  },
  {
    id: 'G1-device-fingerprint',
    section: 'G-verification',
    async run(file, c) {
      const vector = getVector<{ inputs: G1Inputs; expected: G1Expected }>(
        file,
        'G1-device-fingerprint',
      );
      const b5 = getVector<{ inputs: B5Inputs }>(file, 'B5-identity-binding-signature').inputs;
      c.bytes(
        'G1.alice_fingerprint',
        await deviceFingerprint(
          hexToBytes(vector.inputs.identity_signing_key),
          hexToBytes(vector.inputs.identity_dh_key),
        ),
        vector.expected.alice_fingerprint,
      );
      c.bytes(
        'G1.bob_fingerprint',
        await deviceFingerprint(hexToBytes(b5.bob_ik_sig_public), hexToBytes(b5.bob_ik_dh_public)),
        vector.expected.bob_fingerprint,
      );
    },
  },
  {
    id: 'G2-safety-number',
    section: 'G-verification',
    async run(file, c) {
      const vector = getVector<{ inputs: G2Inputs; expected: G2Expected }>(
        file,
        'G2-safety-number',
      );
      const [first, second] = vector.inputs.entries;
      const forward = await computeSafetyNumber(toEntry(first), toEntry(second));
      const backward = await computeSafetyNumber(toEntry(second), toEntry(first));
      c.bytes('G2.sha512', forward.digest, vector.expected.sha512);
      c.equal('G2.digits', forward.digits, vector.expected.digits);
      c.equal('G2.display', forward.display, vector.expected.display);
      c.equal('G2.backward_digits', backward.digits, forward.digits);
      c.bytes('G2.backward_digest', backward.digest, vector.expected.sha512);
      c.equal('G2.digit_count', forward.digits.length, 60);
      c.equal('G2.display_groups', forward.display.split(' ').length, 12);
      c.equal('G2.display_compact', forward.display.replace(/ /g, '').length, 60);
      c.equal('G2.format_digits', formatSafetyNumberDigits(forward.digits), forward.display);
      c.equal(
        'G2.qr_payload',
        buildSafetyNumberQrPayload(
          { deviceId: first.device_id, fingerprint: hexToBytes(first.fingerprint) },
          { deviceId: second.device_id, fingerprint: hexToBytes(second.fingerprint) },
        ),
        vector.expected.qr_payload,
      );
    },
  },
  {
    id: 'G3-safety-number-after-key-change',
    section: 'G-verification',
    async run(file, c) {
      const vector = getVector<{ inputs: G3Inputs; expected: G3Expected }>(
        file,
        'G3-safety-number-after-key-change',
      );
      const [first, second] = vector.inputs.entries;
      const changed = await computeSafetyNumber(toEntry(first), toEntry(second));
      c.bytes('G3.sha512', changed.digest, vector.expected.sha512);
      c.equal('G3.digits', changed.digits, vector.expected.digits);
      c.equal('G3.display', changed.display, vector.expected.display);
      const untouched = getVector<{ expected: G2Expected }>(file, 'G2-safety-number').expected;
      c.isTrue('G3.digits_changed_after_key_change', changed.digits !== untouched.digits);
    },
  },
  {
    id: 'G4-verification-hash',
    section: 'G-verification',
    async run(file, c) {
      const vector = getVector<{ inputs: G4Inputs; expected: G4Expected }>(
        file,
        'G4-verification-hash',
      );
      c.equal('G4.input_vh_version', vector.inputs.vh_version, 2);
      c.equal('G4.expected_vh_version', vector.expected.vh_version, 2);
      c.bytes(
        'G4.safety_number_hash',
        await computeVerificationHash({
          chatId: vector.inputs.chat_id,
          verifierUserId: vector.inputs.verifier_user_id,
          verifierDeviceId: vector.inputs.verifier_device_id,
          targetDeviceId: vector.inputs.target_device_id,
          targetKeyGeneration: vector.inputs.target_key_generation,
          safetyNumberDigits: vector.inputs.safety_number_digits,
        }),
        vector.expected.safety_number_hash,
      );
    },
  },
  {
    id: 'G5-verification-per-device',
    section: 'G-verification',
    async run(file, c) {
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
      c.bytes('G5.l1_verification_hash', l1, vector.expected.l1_verification_hash);
      c.bytes('G5.l2_verification_hash', l2, vector.expected.l2_verification_hash);
      c.isTrue('G5.hashes_differ', bytesToHex(l1) !== bytesToHex(l2));
      c.isTrue(
        'G5.device_pair_digits_differ',
        vector.inputs.l1_safety_number_digits !== vector.inputs.l2_safety_number_digits,
      );
      c.equal(
        'G5.l2_display',
        formatSafetyNumberDigits(vector.inputs.l2_safety_number_digits),
        vector.expected.l2_display,
      );
      c.equal('G5.hashes_differ_expected', vector.expected.hashes_differ, true);
      c.equal('G5.digits_differ_expected', vector.expected.device_pair_digits_differ, true);
      c.equal(
        'G5.verifier_device_bound_expected',
        vector.expected.verifier_device_bound_in_hash,
        true,
      );
    },
  },
];

async function runCases(
  definitions: readonly KatCase[],
  file: BrowserKatVectorFile,
): Promise<KatRunResult> {
  validateVectorFile(file);
  const cases: KatCaseResult[] = [];
  let checks = 0;
  for (const definition of definitions) {
    if (definition.section !== 'tamper' && !SECTION_COUNTS[definition.section]) {
      throw new KatFailure(
        'KAT_SOURCE_INVALID',
        `${definition.id}: unknown section ${definition.section}`,
      );
    }
    const checker = createChecker();
    try {
      await definition.run(file, checker);
      cases.push({
        id: definition.id,
        section: definition.section,
        checks: checker.count(),
        ok: true,
      });
    } catch (error) {
      cases.push({
        id: definition.id,
        section: definition.section,
        checks: checker.count(),
        ok: false,
        error: describeError(error),
      });
    }
    checks += checker.count();
  }
  return {
    cases,
    checks,
    failures: cases.filter((entry) => !entry.ok).length,
  };
}

/** Runs the normative A/B/C/D/F/G KATs; never throws for a value mismatch. */
export async function runBrowserKat(file: BrowserKatVectorFile): Promise<KatRunResult> {
  return runCases(KAT_CASES, file);
}

interface TamperCase {
  readonly id: string;
  readonly section: string;
  run(file: BrowserKatVectorFile, check: Checker): Promise<void>;
}

function flipBase64UrlChar(text: string, index: number): string {
  const current = text[index] ?? 'A';
  const replacement = current === 'A' ? 'B' : 'A';
  return `${text.slice(0, index)}${replacement}${text.slice(index + 1)}`;
}

const TAMPER_CASES: readonly TamperCase[] = [
  {
    id: 'TAMPER-baseline-f1-decrypts',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const b4 = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
      const d2 = getVector<{ inputs: D2Inputs; expected: D2Expected }>(file, 'D2-message-aead-m1');
      const parsed = parseEnvelopeJson(f1.envelope_json);
      const preamble = buildEnvelopePreamble(parsed, hexToBytes(b4.recipient_identity_signing_key));
      const ad = await buildEnvelopeAd(parsed, preamble);
      c.bytes('TAMPER.baseline_ad', ad, d2.inputs.ad_hex);
      const params = await deriveMessageAeadParams(hexToBytes(d2.inputs.message_key));
      c.bytes(
        'TAMPER.baseline_plaintext',
        await aesGcmDecrypt(params.key, params.nonce, parsed.ciphertext, ad),
        d2.inputs.padded_plaintext_hex,
      );
    },
  },
  {
    id: 'TAMPER-ciphertext-byte',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const b4 = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
      const d2 = getVector<{ inputs: D2Inputs }>(file, 'D2-message-aead-m1');
      const parsed = parseEnvelopeJson(f1.envelope_json);
      const preamble = buildEnvelopePreamble(parsed, hexToBytes(b4.recipient_identity_signing_key));
      const ad = await buildEnvelopeAd(parsed, preamble);
      const params = await deriveMessageAeadParams(hexToBytes(d2.inputs.message_key));
      const tampered = Uint8Array.from(parsed.ciphertext);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
      await c.rejectsCode(
        'TAMPER.ciphertext_byte_rejected',
        () => aesGcmDecrypt(params.key, params.nonce, tampered, ad),
        'DECRYPT_FAILED',
      );
    },
  },
  {
    id: 'TAMPER-ad-byte',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const b4 = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
      const d2 = getVector<{ inputs: D2Inputs }>(file, 'D2-message-aead-m1');
      const parsed = parseEnvelopeJson(f1.envelope_json);
      const preamble = buildEnvelopePreamble(parsed, hexToBytes(b4.recipient_identity_signing_key));
      const ad = await buildEnvelopeAd(parsed, preamble);
      const params = await deriveMessageAeadParams(hexToBytes(d2.inputs.message_key));
      const tampered = Uint8Array.from(ad);
      tampered[40] = (tampered[40] ?? 0) ^ 0x01;
      await c.rejectsCode(
        'TAMPER.ad_byte_rejected',
        () => aesGcmDecrypt(params.key, params.nonce, parsed.ciphertext, tampered),
        'DECRYPT_FAILED',
      );
    },
  },
  {
    id: 'TAMPER-preamble-byte',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const b4 = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
      const parsed = parseEnvelopeJson(f1.envelope_json);
      const preamble = buildEnvelopePreamble(parsed, hexToBytes(b4.recipient_identity_signing_key));
      const tampered = Uint8Array.from(preamble);
      tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
      c.isTrue(
        'TAMPER.preamble_byte_rejected',
        !(await verifyPreambleSignature(
          parsed.prekey?.senderIdentitySigningKey ?? new Uint8Array(),
          tampered,
          parsed.prekey?.signature ?? new Uint8Array(),
        )),
      );
    },
  },
  {
    id: 'TAMPER-signature-byte',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const b4 = getVector<{ inputs: B4Inputs }>(file, 'B4-prekey-preamble').inputs;
      const parsed = parseEnvelopeJson(f1.envelope_json);
      const preamble = buildEnvelopePreamble(parsed, hexToBytes(b4.recipient_identity_signing_key));
      const signature = Uint8Array.from(parsed.prekey?.signature ?? new Uint8Array());
      signature[signature.length - 1] = (signature[signature.length - 1] ?? 0) ^ 0x01;
      c.isTrue(
        'TAMPER.signature_byte_rejected',
        !(await verifyPreambleSignature(
          parsed.prekey?.senderIdentitySigningKey ?? new Uint8Array(),
          preamble,
          signature,
        )),
      );
    },
  },
  {
    id: 'TAMPER-wire-ciphertext-char',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const wire = JSON.parse(f1.envelope_json) as Record<string, unknown>;
      const ciphertext = typeof wire.ciphertext === 'string' ? wire.ciphertext : '';
      c.isTrue('TAMPER.wire_has_ciphertext', ciphertext.length > 16);
      wire.ciphertext = flipBase64UrlChar(ciphertext, 10);
      const parsed = parseEnvelope(wire);
      c.isTrue('TAMPER.wire_ciphertext_changed', encodeBase64Url(parsed.ciphertext) !== ciphertext);
      c.equal(
        'TAMPER.wire_not_byte_identical',
        serializeEnvelope(parsed) !== f1.envelope_json,
        true,
      );
    },
  },
  {
    id: 'TAMPER-envelope-version',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const wire = JSON.parse(f1.envelope_json) as Record<string, unknown>;
      wire.v = 2;
      c.throwsCode(
        'TAMPER.version_2_rejected',
        () => parseEnvelope(wire),
        'UNSUPPORTED_ENVELOPE_VERSION',
      );
    },
  },
  {
    id: 'TAMPER-unknown-field',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const wire = JSON.parse(f1.envelope_json) as Record<string, unknown>;
      wire.extra = true;
      c.throwsCode(
        'TAMPER.unknown_field_rejected',
        () => parseEnvelope(wire),
        'INVALID_ENVELOPE_FORMAT',
      );
    },
  },
  {
    id: 'TAMPER-self-envelope',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const wire = JSON.parse(f1.envelope_json) as Record<string, unknown>;
      wire.recipient_device_id = wire.sender_device_id;
      c.throwsCode(
        'TAMPER.self_envelope_rejected',
        () => parseEnvelope(wire),
        'INVALID_ENVELOPE_FORMAT',
      );
    },
  },
  {
    id: 'TAMPER-prekey-opk-mismatch',
    section: 'tamper',
    async run(file, c) {
      const f1 = getVector<{ expected: F1Expected }>(file, 'F1-envelope-prekey').expected;
      const wire = JSON.parse(f1.envelope_json) as Record<string, unknown>;
      const prekey = wire.prekey as Record<string, unknown>;
      prekey.opk_public = null;
      c.throwsCode(
        'TAMPER.opk_mismatch_rejected',
        () => parseEnvelope(wire),
        'INVALID_ENVELOPE_FORMAT',
      );
    },
  },
];

/** Negative envelope/AEAD/preamble tamper checks; values still come from the file. */
export async function runEnvelopeTamperKat(file: BrowserKatVectorFile): Promise<KatRunResult> {
  return runCases(TAMPER_CASES, file);
}

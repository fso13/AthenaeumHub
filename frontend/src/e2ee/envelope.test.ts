/**
 * Envelope codec negative/tamper tests (§4.7, §8.4).
 *
 * Positive byte-identity is covered by the F1/F2 KATs; this file proves that
 * non-canonical encodings, wrong lengths, unknown fields, self-envelopes and
 * AEAD/preamble tampering are rejected instead of being normalised.
 */
import { describe, expect, it } from 'vitest';
import { getVector, loadVectorFile } from './test/vectors';
import { bytesToHex, hexToBytes } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';
import { aesGcmDecrypt } from './crypto/aead';
import { deriveMessageAeadParams } from './protocol/kdf';
import {
  buildEnvelopeAd,
  buildEnvelopePreamble,
  parseEnvelope,
  parseEnvelopeJson,
  serializeEnvelope,
} from './protocol/envelope';
import { verifyPreambleSignature } from './protocol/preamble';
import { parseWireEnvelope, serializeWireEnvelope, isE2eeCapableDevice } from './api/deviceKeys';
import type { WireCryptoEnvelope } from './api/deviceKeys';

interface EnvelopeVector {
  expected: { envelope_json: string; decoded: { preamble_hex?: string; ad_hex: string } };
}
interface B4Vector {
  inputs: { recipient_identity_signing_key: string };
}
interface D2Vector {
  inputs: { message_key: string; padded_plaintext_hex: string; ad_hex: string };
  expected: { ciphertext_including_tag: string };
}

const file = loadVectorFile();
const f1Json = getVector<EnvelopeVector>(file, 'F1-envelope-prekey').expected.envelope_json;
const f2Json = getVector<EnvelopeVector>(file, 'F2-envelope-no-prekey').expected.envelope_json;
const bobIkSig = getVector<B4Vector>(file, 'B4-prekey-preamble').inputs
  .recipient_identity_signing_key;

function envelope(): Record<string, unknown> {
  return JSON.parse(f1Json) as Record<string, unknown>;
}
function noPrekeyEnvelope(): Record<string, unknown> {
  return JSON.parse(f2Json) as Record<string, unknown>;
}
function asObject(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrowError(expect.objectContaining({ code }));
}

describe('envelope codec — canonical input', () => {
  it('round-trips F1 and F2 byte for byte', () => {
    expect(serializeEnvelope(parseEnvelopeJson(f1Json))).toBe(f1Json);
    expect(serializeEnvelope(parseEnvelopeJson(f2Json))).toBe(f2Json);
  });

  it('accepts an omitted prekey key and normalises it to null', () => {
    const parsed = parseEnvelope(noPrekeyEnvelope());
    expect(parsed.prekey).toBeNull();
    expect(serializeEnvelope(parsed)).toBe(f2Json);
  });

  it('builds the same AD as the AEAD vector for the first message', async () => {
    const d2 = getVector<D2Vector>(file, 'D2-message-aead-m1');
    const parsed = parseEnvelopeJson(f1Json);
    const preamble = buildEnvelopePreamble(parsed, hexToBytes(bobIkSig));
    const ad = await buildEnvelopeAd(parsed, preamble);
    expect(bytesToHex(ad)).toBe(d2.inputs.ad_hex);
    expect(bytesToHex(ad)).toBe(
      getVector<EnvelopeVector>(file, 'F1-envelope-prekey').expected.decoded.ad_hex,
    );
  });

  it('the API bridge re-validates and re-serialises the same bytes', () => {
    const wire = JSON.parse(f1Json) as WireCryptoEnvelope;
    const parsed = parseWireEnvelope(wire);
    expect(JSON.stringify(serializeWireEnvelope(parsed))).toBe(f1Json);
  });
});

describe('envelope codec — rejected shapes', () => {
  it('rejects non-object inputs', () => {
    for (const value of [null, undefined, [], 'envelope', 42]) {
      expectCode(() => parseEnvelope(value), 'INVALID_ENVELOPE_FORMAT');
    }
  });

  it('rejects a future envelope version with its own code', () => {
    const env = envelope();
    env.v = 2;
    expectCode(() => parseEnvelope(env), 'UNSUPPORTED_ENVELOPE_VERSION');
  });

  it('rejects wrong scheme and self-envelopes', () => {
    const wrongScheme = envelope();
    wrongScheme.scheme = 'PAIRWISE_X3DH';
    expectCode(() => parseEnvelope(wrongScheme), 'INVALID_ENVELOPE_FORMAT');

    const self = envelope();
    self.recipient_device_id = self.sender_device_id;
    expectCode(() => parseEnvelope(self), 'INVALID_ENVELOPE_FORMAT');
  });

  it('rejects unknown fields at every level', () => {
    const topLevel = envelope();
    topLevel.extra = true;
    expectCode(() => parseEnvelope(topLevel), 'INVALID_ENVELOPE_FORMAT');

    const header = envelope();
    asObject(header.header).extra = true;
    expectCode(() => parseEnvelope(header), 'INVALID_ENVELOPE_FORMAT');

    const prekey = envelope();
    asObject(prekey.prekey).extra = true;
    expectCode(() => parseEnvelope(prekey), 'INVALID_ENVELOPE_FORMAT');
  });

  it('rejects a missing or malformed header', () => {
    const missing = envelope();
    delete missing.header;
    expectCode(() => parseEnvelope(missing), 'INVALID_ENVELOPE_FORMAT');

    const version = envelope();
    asObject(version.header).v = 2;
    expectCode(() => parseEnvelope(version), 'INVALID_HEADER');

    const extra = envelope();
    asObject(extra.header).flags = 0;
    expectCode(() => parseEnvelope(extra), 'INVALID_ENVELOPE_FORMAT');
  });

  it('rejects out-of-range generations and counters', () => {
    const generation = envelope();
    generation.sender_key_generation = 0;
    expectCode(() => parseEnvelope(generation), 'INVALID_ENVELOPE_FORMAT');

    const highGeneration = envelope();
    highGeneration.recipient_key_generation = 2 ** 31;
    expectCode(() => parseEnvelope(highGeneration), 'INVALID_ENVELOPE_FORMAT');

    const counter = envelope();
    asObject(counter.header).n = -1;
    expectCode(() => parseEnvelope(counter), 'INVALID_ENVELOPE_FORMAT');

    const highCounter = envelope();
    asObject(highCounter.header).pn = 2 ** 31;
    expectCode(() => parseEnvelope(highCounter), 'INVALID_ENVELOPE_FORMAT');
  });

  it('rejects non-canonical base64url in ids, keys and ciphertext', () => {
    const padded = envelope();
    padded.ciphertext = `${String(padded.ciphertext)}=`;
    expectCode(() => parseEnvelope(padded), 'INVALID_ENVELOPE_FORMAT');

    const plus = envelope();
    plus.ciphertext = String(plus.ciphertext).replace(/-/g, '+');
    expectCode(() => parseEnvelope(plus), 'INVALID_ENVELOPE_FORMAT');

    // Slicing one character leaves non-zero trailing bits: non-canonical.
    const truncated = envelope();
    truncated.ciphertext = String(truncated.ciphertext).slice(0, -1);
    expectCode(() => parseEnvelope(truncated), 'INVALID_ENVELOPE_FORMAT');

    const badTrailingBits = envelope();
    const sessionId = String(badTrailingBits.session_id);
    const last = sessionId.at(-1) ?? 'A';
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const next = alphabet[(alphabet.indexOf(last) + 1) % alphabet.length] ?? 'A';
    badTrailingBits.session_id = `${sessionId.slice(0, -1)}${next}`;
    expectCode(() => parseEnvelope(badTrailingBits), 'INVALID_ENVELOPE_FORMAT');

    const shortKey = envelope();
    const prekey = asObject(shortKey.prekey);
    prekey.spk_public = encodeBase64Url(new Uint8Array(31));
    expectCode(() => parseEnvelope(shortKey), 'INVALID_ENVELOPE_FORMAT');
  });

  it('enforces the canonical ciphertext acceptance bounds', () => {
    const tooSmall = envelope();
    tooSmall.ciphertext = encodeBase64Url(new Uint8Array(271));
    expectCode(() => parseEnvelope(tooSmall), 'ENVELOPE_TOO_LARGE');

    const tooLarge = envelope();
    tooLarge.ciphertext = encodeBase64Url(new Uint8Array(33041));
    expectCode(() => parseEnvelope(tooLarge), 'ENVELOPE_TOO_LARGE');

    const formGuard = envelope();
    formGuard.ciphertext = 'A'.repeat(65537);
    expectCode(() => parseEnvelope(formGuard), 'ENVELOPE_TOO_LARGE');

    const minimum = envelope();
    minimum.ciphertext = encodeBase64Url(new Uint8Array(272));
    expect(() => parseEnvelope(minimum)).not.toThrow();
  });

  it('rejects partial or inconsistent prekey blocks', () => {
    const missingSignature = envelope();
    delete asObject(missingSignature.prekey).signature;
    expectCode(() => parseEnvelope(missingSignature), 'INVALID_ENVELOPE_FORMAT');

    const opkWithoutPublic = envelope();
    asObject(opkWithoutPublic.prekey).opk_public = null;
    expectCode(() => parseEnvelope(opkWithoutPublic), 'INVALID_ENVELOPE_FORMAT');

    const publicWithoutId = envelope();
    asObject(publicWithoutId.prekey).opk_id = null;
    expectCode(() => parseEnvelope(publicWithoutId), 'INVALID_ENVELOPE_FORMAT');

    const badKeyId = envelope();
    asObject(badKeyId.prekey).spk_id = 'spk/1';
    expectCode(() => parseEnvelope(badKeyId), 'INVALID_ENVELOPE_FORMAT');

    const emptyPrekey = envelope();
    emptyPrekey.prekey = {};
    expectCode(() => parseEnvelope(emptyPrekey), 'INVALID_ENVELOPE_FORMAT');
  });

  it('requires a preamble exactly for prekey envelopes', async () => {
    const prekey = parseEnvelopeJson(f1Json);
    await expect(buildEnvelopeAd(prekey)).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE_FORMAT',
    });
    const plain = parseEnvelopeJson(f2Json);
    await expect(buildEnvelopeAd(plain, new Uint8Array(32))).rejects.toMatchObject({
      code: 'INVALID_ENVELOPE_FORMAT',
    });
    await expect(buildEnvelopeAd(plain)).resolves.toHaveLength(163);
  });
});

describe('envelope codec — tamper detection', () => {
  it('rejects a one-byte AD change and a one-byte ciphertext change', async () => {
    const d2 = getVector<D2Vector>(file, 'D2-message-aead-m1');
    const params = await deriveMessageAeadParams(hexToBytes(d2.inputs.message_key));
    const ciphertext = hexToBytes(d2.expected.ciphertext_including_tag);
    const ad = hexToBytes(d2.inputs.ad_hex);
    await expect(aesGcmDecrypt(params.key, params.nonce, ciphertext, ad)).resolves.toHaveLength(
      256,
    );

    const tamperedAd = Uint8Array.from(ad);
    tamperedAd[40] = (tamperedAd[40] ?? 0) ^ 0x01;
    await expect(
      aesGcmDecrypt(params.key, params.nonce, ciphertext, tamperedAd),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });

    const tamperedCiphertext = Uint8Array.from(ciphertext);
    tamperedCiphertext[tamperedCiphertext.length - 1] =
      (tamperedCiphertext[tamperedCiphertext.length - 1] ?? 0) ^ 0x01;
    await expect(
      aesGcmDecrypt(params.key, params.nonce, tamperedCiphertext, ad),
    ).rejects.toMatchObject({ code: 'DECRYPT_FAILED' });
  });

  it('rejects a tampered preamble signature', async () => {
    const parsed = parseEnvelopeJson(f1Json);
    const preamble = buildEnvelopePreamble(parsed, hexToBytes(bobIkSig));
    const signature = parsed.prekey?.signature ?? new Uint8Array();
    const senderKey = parsed.prekey?.senderIdentitySigningKey ?? new Uint8Array();
    expect(await verifyPreambleSignature(senderKey, preamble, signature)).toBe(true);
    const tamperedPreamble = Uint8Array.from(preamble);
    tamperedPreamble[250] = (tamperedPreamble[250] ?? 0) ^ 0x01;
    expect(await verifyPreambleSignature(senderKey, tamperedPreamble, signature)).toBe(false);
    expect(
      await verifyPreambleSignature(
        parsed.prekey?.senderIdentityDhKey ?? new Uint8Array(),
        preamble,
        signature,
      ),
    ).toBe(false);
  });
});

describe('API device keys', () => {
  it('flags only active e2ee_capable devices as targets', () => {
    expect(isE2eeCapableDevice({ e2ee_capable: true, status: 'ACTIVE' })).toBe(true);
    expect(isE2eeCapableDevice({ e2ee_capable: false, status: 'ACTIVE' })).toBe(false);
    expect(isE2eeCapableDevice({ e2ee_capable: true, status: 'REVOKED' })).toBe(false);
    expect(isE2eeCapableDevice({ status: 'ACTIVE' })).toBe(false);
  });
});

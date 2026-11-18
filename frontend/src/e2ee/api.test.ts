/**
 * Contract bridge for device keys/prekeys (no network calls, no session work).
 * Values come from the KAT vectors: B5 (identity + binding), B3 (SPK), B1 (OPK).
 */
import { describe, expect, it } from 'vitest';
import { getVector, loadVectorFile } from './test/vectors';
import { decodePrekeyBundle, decodeSignedPrekey, type WirePrekeyBundle } from './api/deviceKeys';
import { bytesToHex, hexToBytes } from './encoding/bytes';
import { encodeBase64Url } from './encoding/base64url';

interface B5Vector {
  inputs: {
    bob_ik_sig_public: string;
    bob_ik_dh_public: string;
    alice_ik_sig_public: string;
  };
  expected: { bob_identity_binding_signature: string };
}
interface B3Vector {
  inputs: { key_id: string; spk_public: string };
  expected: { signature: string; signature_hex: string };
}
interface B1Vector {
  inputs: { bob_one_time_prekey_public: string };
}

const file = loadVectorFile();
const b5 = getVector<B5Vector>(file, 'B5-identity-binding-signature');
const b3 = getVector<B3Vector>(file, 'B3-SPK-signature');
const b1 = getVector<B1Vector>(file, 'B1-X3DH-4DH');

function b64(hex: string): string {
  return encodeBase64Url(hexToBytes(hex));
}

function bundle(overrides: Partial<WirePrekeyBundle> = {}): WirePrekeyBundle {
  return {
    user_id: '00000000-0000-4000-8000-000000000002',
    device_id: '00000000-0000-4000-8000-000000000021',
    key_generation: 1,
    identity_signing_key: b64(b5.inputs.bob_ik_sig_public),
    identity_dh_key: b64(b5.inputs.bob_ik_dh_public),
    identity_binding_signature: b64(b5.expected.bob_identity_binding_signature),
    identity_key_alg: 'Ed25519+X25519',
    signed_prekey: {
      key_id: b3.inputs.key_id,
      public_key: b64(b3.inputs.spk_public),
      signature: b3.expected.signature,
      created_at: '2026-11-01T00:00:00Z',
      expires_at: '2026-12-01T00:00:00Z',
    },
    one_time_prekey: {
      key_id: 'opk-1',
      public_key: b64(b1.inputs.bob_one_time_prekey_public),
    },
    otp_exhausted: false,
    ...overrides,
  };
}

describe('prekey bundle decoding', () => {
  it('decodes every binary field into bytes', () => {
    const decoded = decodePrekeyBundle(bundle());
    expect(decoded.userId).toBe('00000000-0000-4000-8000-000000000002');
    expect(decoded.deviceId).toBe('00000000-0000-4000-8000-000000000021');
    expect(decoded.keyGeneration).toBe(1);
    expect(bytesToHex(decoded.identitySigningKey)).toBe(b5.inputs.bob_ik_sig_public);
    expect(bytesToHex(decoded.identityDhKey)).toBe(b5.inputs.bob_ik_dh_public);
    expect(bytesToHex(decoded.identityBindingSignature)).toBe(
      b5.expected.bob_identity_binding_signature,
    );
    expect(decoded.signedPrekey.keyId).toBe(b3.inputs.key_id);
    expect(bytesToHex(decoded.signedPrekey.publicKey)).toBe(b3.inputs.spk_public);
    expect(bytesToHex(decoded.signedPrekey.signature)).toBe(b3.expected.signature_hex);
    expect(decoded.signedPrekey.createdAt).toBe('2026-11-01T00:00:00Z');
    expect(decoded.oneTimePrekey?.keyId).toBe('opk-1');
    expect(bytesToHex(decoded.oneTimePrekey?.publicKey ?? new Uint8Array())).toBe(
      b1.inputs.bob_one_time_prekey_public,
    );
  });

  it('keeps an exhausted one-time prekey as null', () => {
    const decoded = decodePrekeyBundle(bundle({ one_time_prekey: null, otp_exhausted: true }));
    expect(decoded.oneTimePrekey).toBeNull();
    expect(decoded.otpExhausted).toBe(true);
  });

  it('rejects non-canonical base64url', () => {
    expect(() =>
      decodePrekeyBundle(bundle({ identity_dh_key: `${b64(b5.inputs.bob_ik_dh_public)}=` })),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
  });

  it('rejects wrong algorithms, generations and ids', () => {
    expect(() =>
      decodePrekeyBundle(
        bundle({ identity_key_alg: 'LEGACY' as unknown as WirePrekeyBundle['identity_key_alg'] }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_RESPONSE' }));
    expect(() => decodePrekeyBundle(bundle({ key_generation: 0 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
    expect(() => decodePrekeyBundle(bundle({ device_id: 'device-1' }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
    expect(() => decodePrekeyBundle(bundle({ key_generation: 2 ** 31 }))).toThrowError(
      expect.objectContaining({ code: 'INVALID_RESPONSE' }),
    );
  });

  it('decodes a signed prekey without optional dates', () => {
    const decoded = decodeSignedPrekey({
      key_id: b3.inputs.key_id,
      public_key: b64(b3.inputs.spk_public),
      signature: b3.expected.signature,
    });
    expect(decoded.createdAt).toBeNull();
    expect(decoded.expiresAt).toBeNull();
    expect(decoded.signature).toHaveLength(64);
  });
});

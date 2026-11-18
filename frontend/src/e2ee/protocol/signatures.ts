/**
 * Device-key signatures (§2.2, §3.1, §3.3.1):
 *  - SPK: `Ed25519_sign(IK_sig, D_SPKSIG || u8(1) || u16(L) || spk_id || spk_pub)`
 *  - identity binding: `Ed25519_sign(IK_sig, D_IKBIND || u8(1) || IK_dh || IK_sig)`
 *  - prekey preamble: re-exported from `preamble.ts` for one import site.
 */
import { D_IKBIND, D_SPKSIG, KEY_BYTES, KEY_ID_PATTERN, MAX_KEY_ID_CHARS } from '../constants';
import { invalid } from '../errors';
import { concatBytes, u16be, u8, utf8 } from '../encoding/bytes';
import { ed25519Sign, ed25519Verify } from '../crypto/ed25519';

function keyIdBytes(keyId: string): Uint8Array {
  if (typeof keyId !== 'string' || !KEY_ID_PATTERN.test(keyId)) {
    throw invalid('INVALID_KEY', `key_id must match ${KEY_ID_PATTERN.source}`);
  }
  if (keyId.length > MAX_KEY_ID_CHARS) {
    throw invalid('INVALID_KEY', `key_id must be at most ${MAX_KEY_ID_CHARS} characters`);
  }
  return utf8(keyId);
}

function assertKey(bytes: Uint8Array, label: string): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_BYTES) {
    throw invalid('INVALID_KEY', `${label} must be ${KEY_BYTES} bytes`);
  }
  return bytes;
}

/** Bytes signed when the device registers a signed prekey (§3.1). */
export function spkSignatureMessage(keyId: string, spkPublic: Uint8Array): Uint8Array {
  const idBytes = keyIdBytes(keyId);
  return concatBytes(
    D_SPKSIG,
    u8(1),
    u16be(idBytes.length),
    idBytes,
    assertKey(spkPublic, 'spk_public'),
  );
}

export async function signSpk(
  identitySigningPrivateKey: CryptoKey,
  keyId: string,
  spkPublic: Uint8Array,
): Promise<Uint8Array> {
  return ed25519Sign(identitySigningPrivateKey, spkSignatureMessage(keyId, spkPublic));
}

export async function verifySpkSignature(
  identitySigningPublicKey: CryptoKey | Uint8Array,
  keyId: string,
  spkPublic: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return ed25519Verify(identitySigningPublicKey, spkSignatureMessage(keyId, spkPublic), signature);
}

/** `D_IKBIND || u8(1) || IK_dh || IK_sig` — 88 bytes (§2.2, P1-2). */
export function identityBindingMessage(
  identityDhPublic: Uint8Array,
  identitySigningPublic: Uint8Array,
): Uint8Array {
  return concatBytes(
    D_IKBIND,
    u8(1),
    assertKey(identityDhPublic, 'identity_dh_key'),
    assertKey(identitySigningPublic, 'identity_signing_key'),
  );
}

export async function signIdentityBinding(
  identitySigningPrivateKey: CryptoKey,
  identityDhPublic: Uint8Array,
  identitySigningPublic: Uint8Array,
): Promise<Uint8Array> {
  return ed25519Sign(
    identitySigningPrivateKey,
    identityBindingMessage(identityDhPublic, identitySigningPublic),
  );
}

export async function verifyIdentityBinding(
  identitySigningPublicKey: CryptoKey | Uint8Array,
  identityDhPublic: Uint8Array,
  identitySigningPublic: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  return ed25519Verify(
    identitySigningPublicKey,
    identityBindingMessage(identityDhPublic, identitySigningPublic),
    signature,
  );
}

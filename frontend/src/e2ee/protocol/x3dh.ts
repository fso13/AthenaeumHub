/**
 * X3DH key agreement inputs and derivation (§3.3).
 *
 * This is the stateless DH/HKDF core only. Bundle validation (SPK signature,
 * `identity_binding_signature`, TOFU pinning), OPK consumption and session
 * creation are E7-F2/F4; they must call this function rather than re-derive SK.
 */
import { D_SID, D_X3DH, KEY_BYTES, SESSION_ID_BYTES, X3DH_F, ZERO_SALT } from '../constants';
import { x25519SharedSecret } from '../crypto/x25519';
import { hkdfSha256 } from '../crypto/hkdf';
import { concatBytes } from '../encoding/bytes';

export interface X3dhInput {
  readonly senderIdentityDhPrivateKey: CryptoKey;
  readonly senderEphemeralPrivateKey: CryptoKey;
  readonly recipientIdentityDhPublicKey: CryptoKey;
  readonly recipientSignedPrekeyPublicKey: CryptoKey;
  /** Omitted/null for a 3-DH session when `otp_exhausted` is true. */
  readonly recipientOneTimePrekeyPublicKey?: CryptoKey | null;
}

/**
 * Responder-side inputs (B in §3.3). The four DH outputs are byte-identical to
 * the initiator's, so `IKM/SK/SID` match without any wire round-trip of secrets.
 */
export interface X3dhResponderInput {
  readonly recipientIdentityDhPrivateKey: CryptoKey;
  readonly recipientSignedPrekeyPrivateKey: CryptoKey;
  readonly senderIdentityDhPublicKey: CryptoKey;
  readonly senderEphemeralPublicKey: CryptoKey;
  /** Omitted/null for a 3-DH session when no one-time prekey was claimed. */
  readonly recipientOneTimePrekeyPrivateKey?: CryptoKey | null;
}

export interface X3dhResult {
  readonly dh1: Uint8Array;
  readonly dh2: Uint8Array;
  readonly dh3: Uint8Array;
  readonly dh4: Uint8Array | null;
  /** `0xFF×32 || DH1 || DH2 || DH3 [|| DH4]` */
  readonly ikm: Uint8Array;
  readonly sharedSecret: Uint8Array;
  readonly sessionId: Uint8Array;
}

function assembleX3dh(
  dh1: Uint8Array,
  dh2: Uint8Array,
  dh3: Uint8Array,
  dh4: Uint8Array | null,
): Promise<X3dhResult> {
  return (async () => {
    const ikm = dh4 ? concatBytes(X3DH_F, dh1, dh2, dh3, dh4) : concatBytes(X3DH_F, dh1, dh2, dh3);
    const sharedSecret = await hkdfSha256(ikm, ZERO_SALT, D_X3DH, KEY_BYTES);
    const sessionId = await hkdfSha256(sharedSecret, ZERO_SALT, D_SID, SESSION_ID_BYTES);
    return { dh1, dh2, dh3, dh4, ikm, sharedSecret, sessionId };
  })();
}

export async function deriveX3dhSharedSecretResponder(
  input: X3dhResponderInput,
): Promise<X3dhResult> {
  const dh1 = await x25519SharedSecret(
    input.recipientSignedPrekeyPrivateKey,
    input.senderIdentityDhPublicKey,
  );
  const dh2 = await x25519SharedSecret(
    input.recipientIdentityDhPrivateKey,
    input.senderEphemeralPublicKey,
  );
  const dh3 = await x25519SharedSecret(
    input.recipientSignedPrekeyPrivateKey,
    input.senderEphemeralPublicKey,
  );
  const dh4 = input.recipientOneTimePrekeyPrivateKey
    ? await x25519SharedSecret(
        input.recipientOneTimePrekeyPrivateKey,
        input.senderEphemeralPublicKey,
      )
    : null;
  return assembleX3dh(dh1, dh2, dh3, dh4);
}

export async function deriveX3dhSharedSecret(input: X3dhInput): Promise<X3dhResult> {
  const dh1 = await x25519SharedSecret(
    input.senderIdentityDhPrivateKey,
    input.recipientSignedPrekeyPublicKey,
  );
  const dh2 = await x25519SharedSecret(
    input.senderEphemeralPrivateKey,
    input.recipientIdentityDhPublicKey,
  );
  const dh3 = await x25519SharedSecret(
    input.senderEphemeralPrivateKey,
    input.recipientSignedPrekeyPublicKey,
  );
  const dh4 = input.recipientOneTimePrekeyPublicKey
    ? await x25519SharedSecret(
        input.senderEphemeralPrivateKey,
        input.recipientOneTimePrekeyPublicKey,
      )
    : null;

  return assembleX3dh(dh1, dh2, dh3, dh4);
}

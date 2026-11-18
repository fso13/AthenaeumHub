/**
 * Stateless KDF steps used by the Double Ratchet (§3.4.1) and message AEAD
 * (§3.5.2).
 *
 * F1 deliberately ships only these pure functions: session objects, ratchet
 * state, skipped-key storage and send/receive orchestration belong to E7-F2/F4.
 */
import { D_AEADK, D_AEADN, D_RK, KEY_BYTES, ZERO_SALT } from '../constants';
import { assertBytesLength, u8 } from '../encoding/bytes';
import { hmacSha256 } from '../crypto/digest';
import { hkdfSha256 } from '../crypto/hkdf';

export interface RootKeyStep {
  readonly rootKey: Uint8Array;
  readonly chainKey: Uint8Array;
}

export interface ChainKeyStep {
  readonly messageKey: Uint8Array;
  readonly nextChainKey: Uint8Array;
}

export interface MessageAeadParams {
  readonly key: Uint8Array;
  readonly nonce: Uint8Array;
}

/** `KDF_RK`: HKDF(ikm=dh_out, salt=RK, info=D_RK, L=64) → RK' || CK. */
export async function kdfRootKey(rootKey: Uint8Array, dhOutput: Uint8Array): Promise<RootKeyStep> {
  assertBytesLength(rootKey, KEY_BYTES, 'root key');
  assertBytesLength(dhOutput, KEY_BYTES, 'DH output');
  const okm = await hkdfSha256(dhOutput, rootKey, D_RK, 64);
  return { rootKey: okm.slice(0, KEY_BYTES), chainKey: okm.slice(KEY_BYTES, 64) };
}

/** `KDF_CK`: MK = HMAC(CK, 0x01); CK' = HMAC(CK, 0x02). */
export async function kdfChainKey(chainKey: Uint8Array): Promise<ChainKeyStep> {
  assertBytesLength(chainKey, KEY_BYTES, 'chain key');
  return {
    messageKey: await hmacSha256(chainKey, u8(0x01)),
    nextChainKey: await hmacSha256(chainKey, u8(0x02)),
  };
}

/** `K_enc`/`N` are derived deterministically from the message key (§3.5.2). */
export async function deriveMessageAeadParams(messageKey: Uint8Array): Promise<MessageAeadParams> {
  assertBytesLength(messageKey, KEY_BYTES, 'message key');
  return {
    key: await hkdfSha256(messageKey, ZERO_SALT, D_AEADK, 32),
    nonce: await hkdfSha256(messageKey, ZERO_SALT, D_AEADN, 12),
  };
}

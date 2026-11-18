/** Device fingerprint: `SHA-256(D_FP || IK_sig || IK_dh)` (§7.1). */
import { D_FP, KEY_BYTES } from '../constants';
import { sha256 } from '../crypto/digest';
import { assertBytesLength, concatBytes } from '../encoding/bytes';

export async function deviceFingerprint(
  identitySigningKey: Uint8Array,
  identityDhKey: Uint8Array,
): Promise<Uint8Array> {
  assertBytesLength(identitySigningKey, KEY_BYTES, 'identity signing key');
  assertBytesLength(identityDhKey, KEY_BYTES, 'identity DH key');
  return sha256(concatBytes(D_FP, identitySigningKey, identityDhKey));
}

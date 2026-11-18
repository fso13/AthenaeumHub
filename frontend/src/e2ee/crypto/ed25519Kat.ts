/**
 * Runtime RFC 8032 Ed25519 known-answer probe (E7-F8 P1-04 / ADR-26).
 *
 * Feature detection alone is not a browser floor: WebKit exposes Ed25519 and
 * produces self-consistent signatures, but its empty-message path is not the
 * RFC 8032 one and some builds use hedged nonces. Production protocol
 * signatures must be byte-deterministic, so the browser support probe runs
 * RFC 8032 §7.1 TEST 1 (empty message) and rejects the primitive when the
 * signature is not byte-identical or does not verify.
 *
 * This module is intentionally network-free, storage-free and has no fallback:
 * a mismatch means `E2EE_UNSUPPORTED_BROWSER` in the caller.
 */
import { areBytesEqual, hexToBytes, zeroBytes } from '../encoding/bytes';
import { bufferSource } from './bufferSource';
import { wrapEd25519Pkcs8 } from './ed25519Pkcs8';

/** RFC 8032 §7.1 TEST 1: seed, public key and signature for the empty message. */
const RFC8032_SEED = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60');
const RFC8032_PUBLIC_KEY = hexToBytes(
  'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
);
const RFC8032_SIGNATURE = hexToBytes(
  'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
);

/**
 * Returns `true` only when `subtle` reproduces the exact RFC 8032 signature,
 * verifies it, and rejects a tampered signature.
 */
export async function runEd25519KnownAnswerTest(subtle: SubtleCrypto): Promise<boolean> {
  const seed = RFC8032_SEED.slice();
  const pkcs8 = wrapEd25519Pkcs8(seed);
  try {
    const privateKey = await subtle.importKey(
      'pkcs8',
      bufferSource(pkcs8),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    const publicKey = await subtle.importKey(
      'raw',
      bufferSource(RFC8032_PUBLIC_KEY),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const empty = new Uint8Array(0);
    const signature = new Uint8Array(
      await subtle.sign({ name: 'Ed25519' }, privateKey, bufferSource(empty)),
    );
    if (signature.length !== RFC8032_SIGNATURE.length) return false;
    if (!areBytesEqual(signature, RFC8032_SIGNATURE)) return false;
    const valid = await subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      bufferSource(RFC8032_SIGNATURE),
      bufferSource(empty),
    );
    if (valid !== true) return false;
    const tampered = RFC8032_SIGNATURE.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    const rejected = await subtle.verify(
      { name: 'Ed25519' },
      publicKey,
      bufferSource(tampered),
      bufferSource(empty),
    );
    return rejected === false;
  } catch {
    return false;
  } finally {
    zeroBytes(seed);
    zeroBytes(pkcs8);
  }
}

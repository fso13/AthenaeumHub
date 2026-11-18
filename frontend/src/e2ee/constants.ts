/**
 * Normative protocol constants (docs/E2EE-SPEC.md §1.2–§1.4, §3.5, §4.1).
 *
 * Domain strings are exact ASCII, UTF-8, no NUL. Changing a domain or a wire
 * constant requires a new protocol version — never edit them in place.
 */
import { utf8 } from './encoding/bytes';

export const PROTOCOL_VERSION = 1;
export const ENVELOPE_VERSION = 1;
export const HEADER_VERSION = 1;
export const HEADER_FLAGS = 0;
export const ENVELOPE_SCHEME = 'PAIRWISE_X3DH_DR';
export const IDENTITY_KEY_ALG = 'Ed25519+X25519';

/** Envelope AD flag bit 0: a prekey (first) envelope of a session. */
export const AD_FLAG_PREKEY = 0x01;

/** Symmetric/key sizes in bytes (§1.5, §3.5.3, §4.7). */
export const KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
export const SESSION_ID_BYTES = 16;
export const UUID_BYTES = 16;
export const AD_BYTES = 163;
export const HEADER_BYTES = 42;
export const PREAMBLE_FIXED_BYTES = 313;
export const PAD_BLOCK = 256;
export const MAX_INNER_BODY_BYTES = 32768;
export const MAX_TEXT_CHARS = 8000;
export const AES_GCM_NONCE_BYTES = 12;
export const AES_GCM_TAG_BYTES = 16;

/** Canonical ciphertext acceptance bounds (§4.1, §4.7 item 2). */
export const CIPHERTEXT_MIN_BYTES = 272;
export const CIPHERTEXT_MAX_BYTES = 33040;
export const CIPHERTEXT_MIN_CHARS = 363;
export const CIPHERTEXT_MAX_CHARS = 44054;
/** Cheap pre-decode form guard; NOT an acceptance limit (P2-11). */
export const CIPHERTEXT_FORM_GUARD_CHARS = 65536;

export const MAX_DEVICES = 5;
export const MAX_ENVELOPES_PER_MESSAGE = 10;
export const MAX_KEY_GENERATION = 2 ** 31 - 1;
export const MAX_HEADER_COUNTER = 2 ** 31 - 1;
export const MAX_KEY_ID_CHARS = 64;
export const KEY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** Key-id / device-id based labels for local records. */
export const LOCAL_RECORD_VERSION = 1;

/** Double Ratchet skipped-key / session retention (§1.3, §3.4.5.1). */
export const MAX_SKIP = 1000;
export const MAX_SKIPPED_TOTAL = 2000;
export const MAX_SKIPPED_PER_CHAIN = 1000;
export const MAX_SKIPPED_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * E7-F6 §5.7: after the deterministic winner receives its first envelope (the
 * delivery confirmation), the losing simultaneous-handshake session keeps its
 * keys for this window so an already-encrypted in-flight envelope can still be
 * decrypted. Deletion is idempotent and retried on load/receive; a late envelope
 * after the window falls back to the R-15 `SESSION_RESET` recovery path.
 */
export const SUPERSEDED_DELIVERY_WINDOW_MS = 5 * 60 * 1000;

/** SPK/OPK retention: current + 2 previous, 90-day window, 30-day rotation (§1.3, §3.4.5.1). */
export const SPK_RETAIN_PRIVATE = 3;
export const SPK_RETAIN_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * Rotation cadence (and expiry of the currently published SPK). This is **not**
 * a private-SPK retention TTL: private SPKs live up to `SPK_RETAIN_WINDOW_MS`
 * or until they become the 4th (CR1c P1-03 / P2-26).
 */
export const SPK_ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;
export const OPK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** KDF / signature domain prefixes (§1.4). */
export const D_X3DH = utf8('Krug/E2EE/v1/x3dh');
export const D_SID = utf8('Krug/E2EE/v1/session-id');
export const D_RK = utf8('Krug/E2EE/v1/dr-root');
export const D_AEADK = utf8('Krug/E2EE/v1/aead-key');
export const D_AEADN = utf8('Krug/E2EE/v1/aead-nonce');
export const D_AD = utf8('Krug/E2EE/v1/ad');
export const D_PRE = utf8('Krug/E2EE/v1/prekey');
export const D_PRESIG = utf8('Krug/E2EE/v1/prekey-signature');
export const D_SPKSIG = utf8('Krug/E2EE/v1/spk-signature');
export const D_FP = utf8('Krug/E2EE/v1/fingerprint');
export const D_SN = utf8('Krug/E2EE/v1/safety-number');
export const D_VER = utf8('Krug/E2EE/v1/verification');
export const D_PAY = utf8('Krug/E2EE/v1/payload');
export const D_IKBIND = utf8('Krug/E2EE/v1/ik-binding');

/** X3DH IKM prefix F = 0xFF × 32 (§3.3). */
export const X3DH_F = new Uint8Array(KEY_BYTES).fill(0xff);
/** HKDF salt for X3DH / session-id / AEAD key derivation: 0×32. */
export const ZERO_SALT = new Uint8Array(KEY_BYTES);

/** `envelope.v` / `header.v` are wire constants, not feature flags. */
export const VERIFICATION_HASH_VERSION = 2;

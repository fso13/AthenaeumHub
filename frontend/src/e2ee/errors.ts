/**
 * Typed client-side E2EE errors (E7-F1/F2/F4).
 *
 * Codes are the client-visible protocol errors from `docs/E2EE-SPEC.md` §3.6
 * plus the shape errors the codec must reject locally (§4.7). Messages never
 * contain key material, ciphertext or plaintext: only a field path/reason, so
 * they are safe to surface in a security alert without leaking secrets.
 */
export type E2eeErrorCode =
  | 'INVALID_ENCODING'
  | 'INVALID_ENVELOPE_FORMAT'
  | 'UNSUPPORTED_ENVELOPE_VERSION'
  | 'INVALID_HEADER'
  | 'INVALID_PREAMBLE'
  | 'INVALID_PAYLOAD'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'ENVELOPE_TOO_LARGE'
  | 'MESSAGE_TOO_LONG'
  | 'INVALID_KEY'
  | 'INVALID_RESPONSE'
  | 'KEY_HANDSHAKE_INVALID'
  | 'DECRYPT_FAILED'
  | 'KEY_STORAGE_UNAVAILABLE'
  | 'E2EE_UNSUPPORTED_BROWSER'
  // Protocol codes from §3.6 that only session/send/receive code (E7-F2/F4) raises.
  | 'NO_SESSION'
  | 'KEY_CHANGE_DETECTED'
  | 'KEY_GENERATION_STALE'
  | 'DUPLICATE_OR_OLD_MESSAGE'
  | 'SESSION_TOO_FAR_BEHIND'
  | 'SPK_DELETED'
  | 'UNKNOWN_SPK'
  | 'OPK_EXHAUSTED'
  | 'SESSION_RESET_REQUIRED'
  | 'PAYLOAD_INVALID'
  /** Send/receive counter reached 2^31-1 (§4.5, P2-14). */
  | 'CHAIN_EXHAUSTED'
  /** Client pre-check: no peer device could be covered for a send (§4.2, §5.2). */
  | 'PEER_UNCOVERED'
  // Client-local coordination codes: never sent on the wire, never rendered raw.
  /** E2EE send was attempted without the shifted ratchet state (P1-01, fail closed). */
  | 'SESSION_STATE_MISSING'
  | 'SESSION_STATE_STALE'
  | 'OUTBOX_CONFLICT'
  | 'LOCK_TIMEOUT'
  /** The fallback lease expired/was lost while the critical section was running. */
  | 'LOCK_LEASE_EXPIRED'
  /** Two tabs presented the same `tabId`: fallback coordination is untrustworthy. */
  | 'LOCK_TAB_ID_COLLISION'
  // Client-local device lifecycle and security-mode codes (E7-F3).
  | 'DEVICE_NOT_REGISTERED'
  | 'DEVICE_IDENTITY_MISMATCH'
  | 'DEVICE_IDENTITY_CONFLICT'
  | 'DEVICE_IDENTITY_INVALID'
  | 'SECURITY_MODE_MISMATCH'
  | 'MODE_CONFIRMATION_REQUIRED'
  /** Safety-number attestation could not be stored (transport/server error). */
  | 'VERIFICATION_FAILED';

export class E2eeError extends Error {
  readonly code: E2eeErrorCode;

  constructor(code: E2eeErrorCode, message: string) {
    super(message);
    this.name = 'E2eeError';
    this.code = code;
  }
}

export function isE2eeError(value: unknown): value is E2eeError {
  return value instanceof E2eeError;
}

/** Internal helper so codecs stay terse without losing the error code. */
export function invalid(code: E2eeErrorCode, message: string): E2eeError {
  return new E2eeError(code, message);
}

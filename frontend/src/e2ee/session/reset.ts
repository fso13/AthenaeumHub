/**
 * R-15 `SESSION_RESET` inner body (§3.5.1, content_type = 2).
 *
 * The reset travels encrypted inside a **new prekey envelope**; the server never
 * sees it. This module only frames/validates the body. Choosing the retry
 * window, re-encrypting the batch and sending it is F5 orchestration (no
 * network in `src/e2ee/**`).
 */
import { MAX_HEADER_COUNTER, SESSION_ID_BYTES, KEY_BYTES } from '../constants';
import { E2eeError, invalid } from '../errors';
import { fromUtf8, isUuid, utf8 } from '../encoding/bytes';
import { decodeBase64Url, encodeBase64Url } from '../encoding/base64url';

export type SessionResetReason =
  'SPK_DELETED' | 'UNKNOWN_SPK' | 'DECRYPT_FAILED' | 'NO_SESSION' | 'KEY_HANDSHAKE_INVALID';

const RESET_REASONS: ReadonlySet<string> = new Set<SessionResetReason>([
  'SPK_DELETED',
  'UNKNOWN_SPK',
  'DECRYPT_FAILED',
  'NO_SESSION',
  'KEY_HANDSHAKE_INVALID',
]);

/** Rate limit for a reset per failed session (§3.3.3, §4.5: 1 / 300 s). */
export const RESET_RATE_LIMIT_MS = 300_000;

export interface SessionResetBody {
  /** b64u16 of the session the peer failed to decrypt in. */
  readonly failedSessionId: string;
  /** `header.dh` of the first undecryptable message (b64u32). */
  readonly failedChainDh: string;
  /** `header.n` of that message. */
  readonly failedN: number;
  readonly reason: SessionResetReason;
  /** Anchor for the retry window; null only when the sender cannot match it. */
  readonly retryOfClientMessageId: string | null;
}

export function serializeSessionResetBody(body: SessionResetBody): Uint8Array {
  let sessionId: Uint8Array;
  try {
    sessionId = decodeBase64Url(body.failedSessionId, SESSION_ID_BYTES);
  } catch {
    throw invalid('INVALID_PAYLOAD', 'failed_session_id must be canonical b64u16');
  }
  let chainDh: Uint8Array;
  try {
    chainDh = decodeBase64Url(body.failedChainDh, KEY_BYTES);
  } catch {
    throw invalid('INVALID_PAYLOAD', 'failed_chain_dh must be canonical b64u32');
  }
  if (!Number.isInteger(body.failedN) || body.failedN < 0 || body.failedN > MAX_HEADER_COUNTER) {
    throw invalid('INVALID_PAYLOAD', 'failed_n is out of range');
  }
  if (!RESET_REASONS.has(body.reason)) {
    throw invalid('INVALID_PAYLOAD', 'reset reason is unknown');
  }
  if (body.retryOfClientMessageId !== null && !isUuid(body.retryOfClientMessageId)) {
    throw invalid('INVALID_PAYLOAD', 'retry_of_client_message_id must be null or a UUID');
  }
  // Field order is normative for byte-stable payloads (vector L1).
  const json = {
    failed_session_id: encodeBase64Url(sessionId),
    failed_chain_dh: encodeBase64Url(chainDh),
    failed_n: body.failedN,
    reason: body.reason,
    retry_of_client_message_id: body.retryOfClientMessageId,
  };
  return utf8(JSON.stringify(json));
}

export function parseSessionResetBody(body: Uint8Array): SessionResetBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromUtf8(body));
  } catch {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET body is not valid UTF-8 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET body must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const sessionId = record.failed_session_id;
  const chainDh = record.failed_chain_dh;
  if (typeof sessionId !== 'string' || typeof chainDh !== 'string') {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET ids must be strings');
  }
  try {
    decodeBase64Url(sessionId, SESSION_ID_BYTES);
    decodeBase64Url(chainDh, KEY_BYTES);
  } catch {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET ids must be canonical b64u');
  }
  const failedN = record.failed_n;
  if (
    typeof failedN !== 'number' ||
    !Number.isInteger(failedN) ||
    failedN < 0 ||
    failedN > MAX_HEADER_COUNTER
  ) {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET failed_n is out of range');
  }
  const reason = record.reason;
  if (typeof reason !== 'string' || !RESET_REASONS.has(reason)) {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET reason is unknown');
  }
  const retry = record.retry_of_client_message_id;
  let retryOfClientMessageId: string | null;
  if (retry === undefined || retry === null) {
    retryOfClientMessageId = null;
  } else if (typeof retry === 'string' && isUuid(retry)) {
    retryOfClientMessageId = retry;
  } else {
    throw invalid('INVALID_PAYLOAD', 'SESSION_RESET retry id must be null or a UUID');
  }
  return {
    failedSessionId: sessionId,
    failedChainDh: chainDh,
    failedN,
    reason: reason as SessionResetReason,
    retryOfClientMessageId,
  };
}

/** One reset per failed session per 300 s (§4.5); callers persist `lastResetAt`. */
export function isResetAllowed(lastResetAt: number | null, now: number): boolean {
  return lastResetAt === null || now - lastResetAt >= RESET_RATE_LIMIT_MS;
}

/** Builds the exact body needed to signal a failed prekey/ratchet session. */
export function buildSessionResetBody(input: {
  readonly failedSessionId: string;
  readonly failedChainDh: Uint8Array;
  readonly failedN: number;
  readonly reason: SessionResetReason;
  readonly retryOfClientMessageId?: string | null;
}): SessionResetBody {
  return {
    failedSessionId: input.failedSessionId,
    failedChainDh: encodeBase64Url(input.failedChainDh),
    failedN: input.failedN,
    reason: input.reason,
    retryOfClientMessageId: input.retryOfClientMessageId ?? null,
  };
}

/** Guard used by receive paths that surface a reset instead of throwing. */
export function assertResetReason(value: string): SessionResetReason {
  if (!RESET_REASONS.has(value)) {
    throw new E2eeError('INVALID_PAYLOAD', 'unknown SESSION_RESET reason');
  }
  return value as SessionResetReason;
}

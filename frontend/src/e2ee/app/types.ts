/**
 * Public E2EE integration types shared by the store and the UI (E7-F5).
 *
 * These shapes contain metadata only: never plaintext, never key material. The
 * decrypted text of a message lives in the store as the same value the local
 * sealed copy holds; it is never written anywhere else.
 */
import type { WireCryptoEnvelope } from '../api/deviceKeys';
import type {
  ChatModeAction,
  ChatModeEvidence,
  DeviceKeyChangeRecord,
  VerifiedDeviceKeyInfo,
} from '../device/types';
import type { E2eeCoverage, E2eeCoverageWarning } from '../session/send';
import type { SessionResetBody, SessionResetReason } from '../session/reset';

export type E2eeSecurityMode = 'E2EE' | 'MANAGED';

export type E2eeStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface E2eeDeviceView {
  readonly userId: string;
  readonly deviceId: string;
  readonly fingerprint: string;
  readonly isSelf: boolean;
  /**
   * Server attestation scoped to this verifier device (P0-1). It is never a
   * local trust source: key-change state also forces it to `false`.
   */
  readonly verified: boolean;
  readonly verifiedAt?: number | null;
  readonly verificationMethod?: 'QR' | 'MANUAL' | null;
  readonly status: VerifiedDeviceKeyInfo['status'];
}

export interface E2eeKeyChangeView {
  readonly userId: string;
  readonly deviceId: string;
  readonly pinnedFingerprint: string;
  readonly observedFingerprint: string;
  readonly detectedAt: number;
}

export interface E2eeSafetyNumberView {
  readonly userId: string;
  readonly deviceId: string;
  readonly display: string;
  readonly qrPayload: string;
  /** VH v2 b64u attestation value for this verifier-device pair (§7.4). */
  readonly verificationHash?: string;
}

export interface E2eeVerificationResult {
  readonly deviceId: string;
  readonly verified: boolean;
  readonly verifiedAt: number | null;
  readonly method: 'QR' | 'MANUAL';
  readonly keyGeneration: number;
}

export interface E2eeChatSnapshot {
  readonly chatId: string;
  readonly securityMode: E2eeSecurityMode;
  readonly modeAction: ChatModeAction;
  readonly evidence: readonly ChatModeEvidence[];
  readonly selfDeviceId: string;
  readonly selfFingerprint: string;
  readonly devices: readonly E2eeDeviceView[];
  readonly peerDeviceIds: readonly string[];
  readonly selfDeviceIds: readonly string[];
  readonly unavailableDeviceIds: readonly string[];
  readonly keyChanges: readonly E2eeKeyChangeView[];
  readonly safetyNumbers: readonly E2eeSafetyNumberView[];
  readonly loadedAt: number;
}

export interface E2eePreparedSend {
  readonly kind: 'text' | 'reset';
  readonly chatId: string;
  readonly clientMessageId: string;
  readonly localMessageId: string;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  /** Every session id that received an envelope (fan-out). */
  readonly sessionIds: readonly string[];
  readonly text: string | null;
  readonly replyToId: string | null;
  readonly retryOfClientMessageId: string | null;
  readonly envelopes: readonly WireCryptoEnvelope[];
  readonly coverage: E2eeCoverage;
  readonly coverageWarning: E2eeCoverageWarning;
  readonly otpExhausted: boolean;
  readonly createdAt: number;
}

export interface E2eeSendTextInput {
  readonly chatId: string;
  readonly text: string;
  readonly replyToId?: string | null;
  readonly clientMessageId?: string;
  readonly idempotencyKey?: string;
  readonly retryOfClientMessageId?: string | null;
  readonly freshPrekey?: boolean;
  /**
   * E7-F5G P2-30: exact sessions to reuse for the R-15 retry batch. A device
   * without one of these sessions gets a fresh prekey session instead of
   * silently falling back to an old live session.
   */
  readonly reuseSessionIds?: readonly string[];
  readonly createdAt?: number;
}

export interface E2eeSendResetInput {
  readonly chatId: string;
  readonly reset: SessionResetBody;
  readonly clientMessageId?: string;
  readonly idempotencyKey?: string;
  readonly createdAt?: number;
}

export interface E2eeReceivedMessage {
  readonly kind: 'message';
  readonly localMessageId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly replyToId: string | null;
}

export interface E2eeIncomingReset {
  readonly kind: 'control';
  readonly sessionId: string;
  readonly reset: SessionResetBody;
  readonly senderDeviceId: string;
}

export interface E2eeReceiveError {
  readonly kind: 'error';
  /** Client-visible code (§3.6); never raw key/ciphertext material. */
  readonly code: string;
  /** Receiver-side R-15 body when the failed envelope is recoverable. */
  readonly reset: SessionResetBody | null;
  readonly reason: SessionResetReason | null;
}

export type E2eeReceiveOutcome =
  E2eeReceivedMessage | E2eeIncomingReset | E2eeReceiveError | { readonly kind: 'none' };

export interface E2eeRetryCandidate {
  readonly originalClientMessageId: string;
  readonly originalServerMessageId: string | null;
  readonly text: string;
  readonly replyToId: string | null;
}

export type E2eeResetOutcome =
  | {
      readonly status: 'pending';
      readonly failedSessionId: string;
      readonly candidates: readonly E2eeRetryCandidate[];
      readonly remaining: number;
      /** P2-35: corrupt local copies skipped for this window. */
      readonly skipped: number;
    }
  | {
      readonly status: 'ignored';
      readonly reason: 'invalid_session' | 'anchor_unknown' | 'empty' | 'duplicate';
    };

export interface E2eeLocalCopyView {
  readonly text: string | null;
  readonly replyToId: string | null;
  /** 2 = SESSION_RESET control; a restored control must never render as a bubble. */
  readonly contentType?: 1 | 2;
  /** `superseded` copies were replaced by an R-15 retry and must stay hidden. */
  readonly status?: 'pending' | 'sent' | 'received' | 'failed' | 'superseded';
  /** Server row this copy belongs to (P2-04 reload/replay binding). */
  readonly serverMessageId?: string | null;
}

/** Why the chat cannot send at all (rendered by the UI, no raw codes). */
export type E2eeBlockReason =
  | 'flag_disabled'
  | 'mode_alert'
  | 'mode_confirm_required'
  | 'key_change'
  | 'not_ready'
  | 'no_peer_devices'
  | 'unsupported';

/** R-15 retry progress for the in-chat banner (E7-F6 UX). */
export interface E2eeResetProgress {
  readonly status: 'running' | 'completed' | 'failed';
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly remaining: number;
  /** Corrupt local copies skipped for this window (P2-35). */
  readonly skipped: number;
}

export interface E2eeChatState {
  readonly chatId: string;
  readonly status: E2eeStatus;
  readonly error: string | null;
  readonly securityMode: E2eeSecurityMode | 'unknown';
  readonly modeAction: ChatModeAction | null;
  readonly evidence: readonly ChatModeEvidence[];
  readonly selfDeviceId: string | null;
  readonly devices: readonly E2eeDeviceView[];
  readonly peerDeviceIds: readonly string[];
  readonly keyChanges: readonly E2eeKeyChangeView[];
  readonly safetyNumbers: Readonly<Record<string, string>>;
  /** VH v2 b64u per target device, computed locally from the safety number. */
  readonly verificationHashes: Readonly<Record<string, string>>;
  readonly verifyingDeviceId: string | null;
  readonly verificationError: string | null;
  readonly coverageWarning: E2eeCoverageWarning;
  readonly unavailableDeviceIds: readonly string[];
  readonly retryPendingCount: number;
  readonly resetProgress: E2eeResetProgress | null;
  readonly plaintextAlert: boolean;
  readonly loadedAt: number | null;
}

export interface E2eeState {
  readonly enabled: boolean;
  readonly status: E2eeStatus;
  readonly error: string | null;
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly keyGeneration: number | null;
  readonly fingerprint: string | null;
  /** Runtime floor: the browser failed the RFC 8032 Ed25519 probe (ADR-26). */
  readonly browserUnsupported: boolean;
  readonly chats: Readonly<Record<string, E2eeChatState>>;
}

export function createIdleE2eeChatState(chatId: string): E2eeChatState {
  return {
    chatId,
    status: 'idle',
    error: null,
    securityMode: 'unknown',
    modeAction: null,
    evidence: [],
    selfDeviceId: null,
    devices: [],
    peerDeviceIds: [],
    keyChanges: [],
    safetyNumbers: {},
    verificationHashes: {},
    verifyingDeviceId: null,
    verificationError: null,
    coverageWarning: null,
    unavailableDeviceIds: [],
    retryPendingCount: 0,
    resetProgress: null,
    plaintextAlert: false,
    loadedAt: null,
  };
}

export function createE2eeState(enabled: boolean): E2eeState {
  return {
    enabled,
    status: enabled ? 'idle' : 'idle',
    error: null,
    userId: null,
    deviceId: null,
    keyGeneration: null,
    fingerprint: null,
    browserUnsupported: false,
    chats: {},
  };
}

export function keyChangeView(record: DeviceKeyChangeRecord): E2eeKeyChangeView {
  return {
    userId: record.userId,
    deviceId: record.deviceId,
    pinnedFingerprint: record.pinned.fingerprint,
    observedFingerprint: record.observed.fingerprint,
    detectedAt: record.detectedAt,
  };
}

/**
 * Device-key lifecycle types for E7-F3 (§2.3, §3.1–§3.3.1, §5.3, §5.6, §7.5).
 *
 * Everything here is public metadata or a storage reference. Private keys are
 * `CryptoKey`s stored separately in the `keys` store and are never serialised
 * into a registration, prekey-upload or pin record.
 */
import type {
  WireDevice,
  WireDeviceKeyInfo,
  WireDeviceRegistration,
  WireKeyClaimRequest,
  WireKeyClaimResponse,
  WirePrekeyUploadResult,
  WireSignedPrekey,
  WireSignedPrekeyUpload,
} from '../api/deviceKeys';

/** Lifecycle of the local identity pair; drives what F5 may offer next. */
export type DeviceIdentityState =
  'unregistered' | 'registered' | 'revoked' | 'conflict' | 'legacy' | 'invalid';

export interface DeviceIdentityRecord {
  readonly v: 1;
  readonly userId: string | null;
  readonly deviceId: string | null;
  readonly identitySigningKey: string;
  readonly identityDhKey: string;
  readonly identityBindingSignature: string;
  readonly fingerprint: string;
  readonly keyGeneration: number;
  readonly state: DeviceIdentityState;
  readonly createdAt: number;
  readonly registeredAt: number | null;
}

export interface LoadedDeviceIdentity {
  readonly record: DeviceIdentityRecord;
  readonly signingPrivateKey: CryptoKey;
  readonly dhPrivateKey: CryptoKey;
}

export interface PendingDeviceRegistration {
  readonly v: 1;
  readonly idempotencyKey: string;
  readonly userId: string | null;
  readonly body: WireDeviceRegistration;
  readonly createdAt: number;
}

export interface PendingPrekeyUpload {
  readonly v: 1;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly idempotencyKey: string;
  readonly body: WireSignedPrekeyUpload;
  readonly spkKeyId: string | null;
  readonly opkIds: readonly string[];
  readonly createdAt: number;
}

export type TofuPinSource = 'claim' | 'chat_keys';

/** `(user_id, device_id) → identity keys` TOFU pin (§5.6, §7.5). */
export interface TofuPinRecord {
  readonly v: 1;
  readonly userId: string;
  readonly deviceId: string;
  readonly identitySigningKey: string;
  readonly identityDhKey: string;
  readonly identityBindingSignature: string;
  readonly fingerprint: string;
  readonly keyGeneration: number;
  readonly firstSeen: number;
  readonly acceptedAt: number | null;
  readonly verified: boolean;
  readonly verifiedAt: number | null;
  readonly pinSource: TofuPinSource;
}

export interface PinnedKeysSnapshot {
  readonly identitySigningKey: string;
  readonly identityDhKey: string;
  readonly identityBindingSignature: string;
  readonly fingerprint: string;
  readonly keyGeneration: number;
}

/**
 * Persistent key-change state. The pin itself is never overwritten when this
 * record exists; only an explicit `acceptKeyChange` (UI confirmation) may do so.
 */
export interface DeviceKeyChangeRecord {
  readonly v: 1;
  readonly userId: string;
  readonly deviceId: string;
  readonly reason: 'IDENTITY_KEY_CHANGED';
  readonly pinned: PinnedKeysSnapshot;
  readonly observed: PinnedKeysSnapshot;
  readonly detectedAt: number;
  readonly blocked: true;
}

export type TofuPinStatus = 'first_contact' | 'unchanged' | 'key_change';

export interface TofuPinCheck {
  readonly status: TofuPinStatus;
  readonly pin: TofuPinRecord;
  readonly keyChange: DeviceKeyChangeRecord | null;
}

export interface VerifiedDeviceIdentity {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identitySigningKey: Uint8Array;
  readonly identityDhKey: Uint8Array;
  readonly identityBindingSignature: Uint8Array;
  readonly fingerprint: Uint8Array;
  readonly fingerprintBase64Url: string;
}

export interface VerifiedDeviceKeyInfo extends VerifiedDeviceIdentity {
  readonly status: WireDeviceKeyInfo['status'];
  readonly isSelf: boolean;
  readonly signedPrekeyId: string | null;
  /**
   * Server attestation scoped to `(X-Device-Id = verifier, this device, chat)`
   * (P0-1). `true` only when the server row exists for THIS verifier device;
   * it is never used as a local trust source.
   */
  readonly verified: boolean;
  readonly verifiedAt: number | null;
  readonly verificationMethod: 'QR' | 'MANUAL' | null;
}

export interface PinnedDeviceResult {
  readonly userId: string;
  readonly deviceId: string;
  readonly status: TofuPinStatus;
  readonly pin: TofuPinRecord;
  readonly keyChange: DeviceKeyChangeRecord | null;
}

export interface ClaimPinsResult {
  readonly devices: readonly PinnedDeviceResult[];
  readonly unavailable: readonly string[];
  readonly blocked: boolean;
  readonly selfVerified: boolean;
}

export interface ChatKeysPinsResult {
  readonly devices: readonly PinnedDeviceResult[];
  readonly blocked: boolean;
  readonly selfVerified: boolean;
}

export type ChatSecurityMode = 'E2EE' | 'MANAGED';

export interface ChatModePinRecord {
  readonly v: 1;
  readonly chatId: string;
  readonly mode: ChatSecurityMode;
  readonly pinnedAt: number;
  readonly source: 'server' | 'workspace' | 'user' | 'history';
  readonly confirmedByUser: boolean;
  readonly confirmedAt: number | null;
}

export type ChatModeEvidence =
  | 'local_e2ee_mode_pin'
  | 'workspace_e2ee'
  | 'peer_has_e2ee_capable_devices'
  | 'local_e2ee_history_marker';

export type ChatModeAction =
  'allow_e2ee' | 'allow_plaintext' | 'confirm_mode_required' | 'block_security_alert';

export type ChatModeAllowedOutcome = 'E2EE_ONLY' | 'NEW_MANAGED_CHAT';

export interface ChatModeEvaluation {
  readonly action: ChatModeAction;
  readonly chatId: string;
  readonly pin: ChatModePinRecord | null;
  readonly evidence: readonly ChatModeEvidence[];
  readonly allowedOutcomes: readonly ChatModeAllowedOutcome[];
}

export interface ChatModeEvaluationInput {
  readonly chatId: string;
  readonly serverMode: ChatSecurityMode;
  readonly peerHasE2eeCapableDevices?: boolean;
  readonly workspaceMode?: ChatSecurityMode | null;
  readonly e2eeHistoryMarker?: boolean;
}

/**
 * Normalised transport failure kind. The API adapter (`src/api`) implements
 * this structurally; the E2EE layer never imports the network layer.
 */
export type DeviceTransportErrorKind =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'rate_limited'
  | 'server'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'identity_key_conflict'
  | 'idempotency_key_reused'
  | 'idempotency_in_progress'
  | 'device_limit_reached'
  | 'device_revoked'
  | 'invalid_key_format'
  | 'invalid_spk_signature'
  | 'invalid_identity_binding'
  | 'invalid_prekey'
  | 'prekey_id_conflict'
  | 'prekey_limit_exceeded'
  | 'no_prekeys'
  | 'unknown_device'
  | 'key_changed'
  | 'key_generation_mismatch'
  | 'legacy_device'
  | 'too_many_devices'
  | 'mode_not_supported'
  | 'device_id_conflict'
  | 'bad_request'
  | 'unknown';

const DEVICE_TRANSPORT_ERROR_KINDS: ReadonlySet<string> = new Set<DeviceTransportErrorKind>([
  'network',
  'timeout',
  'aborted',
  'rate_limited',
  'server',
  'unauthenticated',
  'forbidden',
  'not_found',
  'identity_key_conflict',
  'idempotency_key_reused',
  'idempotency_in_progress',
  'device_limit_reached',
  'device_revoked',
  'invalid_key_format',
  'invalid_spk_signature',
  'invalid_identity_binding',
  'invalid_prekey',
  'prekey_id_conflict',
  'prekey_limit_exceeded',
  'no_prekeys',
  'unknown_device',
  'key_changed',
  'key_generation_mismatch',
  'legacy_device',
  'too_many_devices',
  'mode_not_supported',
  'device_id_conflict',
  'bad_request',
  'unknown',
]);

export interface DeviceTransportError extends Error {
  readonly kind: DeviceTransportErrorKind;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly field?: string;
  readonly deviceId?: string;
}

export function isDeviceTransportError(value: unknown): value is DeviceTransportError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DeviceTransportError>;
  return (
    typeof candidate.kind === 'string' &&
    DEVICE_TRANSPORT_ERROR_KINDS.has(candidate.kind) &&
    typeof candidate.retryable === 'boolean' &&
    typeof candidate.status === 'number'
  );
}

export function isRetryableDeviceTransportError(value: unknown): boolean {
  return isDeviceTransportError(value) && value.retryable;
}

export interface DeviceRegistrationResponse {
  readonly device: WireDevice;
  readonly replayed: boolean;
}

export interface DeviceRegistrationTransport {
  registerDevice(
    body: WireDeviceRegistration,
    idempotencyKey: string,
  ): Promise<DeviceRegistrationResponse>;
}

export interface PrekeyUploadTransport {
  uploadPrekeys(
    deviceId: string,
    body: WireSignedPrekeyUpload,
    idempotencyKey: string,
  ): Promise<WirePrekeyUploadResult>;
}

export type DeviceTransport = DeviceRegistrationTransport & PrekeyUploadTransport;

export type PreparedDeviceRegistration =
  | {
      readonly kind: 'already_registered';
      readonly deviceId: string;
      readonly keyGeneration: number;
      readonly identity: LoadedDeviceIdentity;
    }
  | {
      readonly kind: 'ready';
      readonly body: WireDeviceRegistration;
      readonly idempotencyKey: string;
      readonly identity: LoadedDeviceIdentity;
      readonly oneTimePrekeyCount: number;
    };

export interface RegisterDeviceResult {
  readonly status: 'registered' | 'already_registered';
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly replayed: boolean;
  readonly device: WireDevice | null;
}

export type PrekeyUploadPlan =
  | {
      readonly kind: 'sufficient';
      readonly availableOpks: number;
    }
  | {
      readonly kind: 'upload';
      readonly pending: PendingPrekeyUpload;
      readonly availableOpks: number;
    };

export interface PrekeyUploadResultSummary {
  readonly status: 'uploaded' | 'sufficient';
  readonly availableOpks: number;
  readonly storedOpks: number;
  readonly spkKeyId: string | null;
}

export interface VerifiedOneTimePrekey {
  readonly keyId: string;
  /** Verified public bytes: the initiator needs them for DH4 and the prekey block. */
  readonly publicKey: Uint8Array;
}

export interface VerifiedClaimedBundle {
  readonly userId: string;
  readonly deviceId: string;
  readonly keyGeneration: number;
  readonly identity: VerifiedDeviceIdentity;
  readonly signedPrekey: WireSignedPrekey;
  readonly oneTimePrekeyId: string | null;
  /**
   * E7-F4: the exact OPK bytes the bundle named. `oneTimePrekeyId` is kept for
   * the F3 API; the initiator must not have to re-decode an unverified bundle
   * to obtain DH4 input or to build the prekey block.
   */
  readonly oneTimePrekey: VerifiedOneTimePrekey | null;
  readonly otpExhausted: boolean;
}

export interface DecodedClaimResponse {
  readonly bundles: readonly VerifiedClaimedBundle[];
  readonly unavailable: readonly string[];
}

export interface ClaimRequestDevice {
  readonly deviceId: string;
  readonly userId: string;
}

export type ClaimRequest = WireKeyClaimRequest;
export type ClaimResponse = WireKeyClaimResponse;

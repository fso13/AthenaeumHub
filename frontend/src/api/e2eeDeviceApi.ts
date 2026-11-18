/**
 * Typed E2EE device API adapter (E7-F3).
 *
 * This is the only layer allowed to talk to the network for device
 * registration, prekey upload/claim and chat-key fetches. It adds no UI and no
 * session logic. Errors are normalised into a stable, secret-free
 * `DeviceApiError` (`kind`/`status`/`retryable`), never logging or echoing the
 * request body or key material.
 */
import type { components } from './schema';
import type { ApiClient } from './http';
import { isApiError, type ApiError } from './problem';
import type { DeviceTransportErrorKind } from '../e2ee/device/types';

export type WireDeviceRegistration = components['schemas']['DeviceRegistration'];
export type WireDevice = components['schemas']['Device'];
export type WireDeviceList = components['schemas']['DeviceList'];
export type WireSignedPrekeyUpload = components['schemas']['SignedPrekeyUpload'];
export type WirePrekeyUploadResult = components['schemas']['PrekeyUploadResult'];
export type WireKeyClaimRequest = components['schemas']['KeyClaimRequest'];
export type WireKeyClaimResponse = components['schemas']['KeyClaimResponse'];
export type WireChatKeysResponse = components['schemas']['ChatKeysResponse'];
export type WireVerificationRequest = components['schemas']['VerificationRequest'];
export type WireVerificationResponse = components['schemas']['VerificationResponse'];

export type DeviceApiErrorKind = DeviceTransportErrorKind;

const RETRYABLE_KINDS: ReadonlySet<DeviceApiErrorKind> = new Set<DeviceApiErrorKind>([
  'network',
  'timeout',
  'rate_limited',
  'server',
  'idempotency_in_progress',
]);

const KIND_MESSAGES: Readonly<Record<DeviceApiErrorKind, string>> = {
  network: 'Device API request failed because the network is unavailable',
  timeout: 'Device API request timed out',
  aborted: 'Device API request was cancelled',
  rate_limited: 'Device API is rate limited; retry later',
  server: 'Device API is temporarily unavailable',
  unauthenticated: 'Authentication is required for the device API',
  forbidden: 'This device is not allowed to perform the operation',
  not_found: 'The requested device was not found',
  identity_key_conflict: 'Device identity keys are already registered elsewhere',
  idempotency_key_reused: 'Idempotency key was reused with a different request',
  idempotency_in_progress: 'An identical device request is already in progress',
  device_limit_reached: 'Device limit reached; revoke a device first',
  device_revoked: 'The device was revoked and cannot be reused',
  invalid_key_format: 'Device key format is invalid',
  invalid_spk_signature: 'Signed prekey signature is invalid',
  invalid_identity_binding: 'Device identity binding signature is invalid',
  invalid_prekey: 'Prekey format or key id is invalid',
  prekey_id_conflict: 'Prekey id is already used with different key material',
  prekey_limit_exceeded: 'Prekey limit exceeded',
  no_prekeys: 'No prekey bundles are available',
  unknown_device: 'The device is unknown or not a chat member',
  key_changed: 'Device keys changed; refresh keys and re-verify',
  key_generation_mismatch: 'Device key generation is stale',
  legacy_device: 'Legacy devices cannot participate in E2EE',
  too_many_devices: 'Too many devices were requested',
  mode_not_supported: 'The chat does not support E2EE keys',
  device_id_conflict: 'Device id conflict',
  bad_request: 'Device API request was rejected',
  unknown: 'Device API request failed',
};

export class DeviceApiError extends Error {
  readonly kind: DeviceApiErrorKind;
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly field?: string;
  readonly deviceId?: string;
  readonly devices?: readonly string[];
  readonly requestId?: string;

  constructor(init: {
    kind: DeviceApiErrorKind;
    status: number;
    code: string;
    retryable: boolean;
    retryAfterSeconds?: number;
    field?: string;
    deviceId?: string;
    devices?: readonly string[];
    requestId?: string;
    cause?: unknown;
  }) {
    super(KIND_MESSAGES[init.kind], init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'DeviceApiError';
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.retryable = init.retryable;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.field = init.field;
    this.deviceId = init.deviceId;
    this.devices = init.devices;
    this.requestId = init.requestId;
  }
}

export function isDeviceApiError(value: unknown): value is DeviceApiError {
  return value instanceof DeviceApiError;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 ? value : undefined;
}

function safeDevices(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 10) return undefined;
  const devices: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length > 64) return undefined;
    devices.push(entry);
  }
  return devices;
}

function kindFor(status: number, code: string): DeviceApiErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status === 410) return 'device_revoked';
  if (status === 409) {
    switch (code) {
      case 'IDENTITY_KEY_CONFLICT':
        return 'identity_key_conflict';
      case 'IDEMPOTENCY_KEY_REUSED':
        return 'idempotency_key_reused';
      case 'IDEMPOTENCY_IN_PROGRESS':
        return 'idempotency_in_progress';
      case 'DEVICE_LIMIT_REACHED':
        return 'device_limit_reached';
      case 'PREKEY_ID_CONFLICT':
        return 'prekey_id_conflict';
      case 'NO_PREKEYS':
        return 'no_prekeys';
      case 'KEY_CHANGED':
        return 'key_changed';
      case 'MODE_NOT_SUPPORTED':
        return 'mode_not_supported';
      case 'DEVICE_ID_CONFLICT':
        return 'device_id_conflict';
      default:
        return 'unknown';
    }
  }
  if (status === 422) {
    switch (code) {
      case 'INVALID_KEY_FORMAT':
        return 'invalid_key_format';
      case 'INVALID_SPK_SIGNATURE':
        return 'invalid_spk_signature';
      case 'INVALID_IDENTITY_BINDING':
        return 'invalid_identity_binding';
      case 'INVALID_PREKEY':
        return 'invalid_prekey';
      case 'PREKEY_LIMIT_EXCEEDED':
        return 'prekey_limit_exceeded';
      case 'E2EE_LEGACY_DEVICE':
      case 'NO_KEYS':
        return 'legacy_device';
      case 'UNKNOWN_DEVICE':
        return 'unknown_device';
      case 'KEY_GENERATION_MISMATCH':
        return 'key_generation_mismatch';
      case 'TOO_MANY_DEVICES':
        return 'too_many_devices';
      default:
        return 'unknown';
    }
  }
  if (status === 400) return 'bad_request';
  return 'unknown';
}

function fromApiError(error: ApiError): DeviceApiError {
  if (error.isAborted) {
    return new DeviceApiError({
      kind: 'aborted',
      status: error.status,
      code: error.code,
      retryable: false,
      requestId: error.requestId,
      cause: error,
    });
  }
  if (error.source === 'timeout') {
    return new DeviceApiError({
      kind: 'timeout',
      status: error.status,
      code: error.code,
      retryable: true,
      requestId: error.requestId,
      cause: error,
    });
  }
  if (error.source === 'network') {
    return new DeviceApiError({
      kind: 'network',
      status: 0,
      code: error.code,
      retryable: true,
      requestId: error.requestId,
      cause: error,
    });
  }
  const kind = kindFor(error.status, error.code);
  const details = error.details ?? {};
  return new DeviceApiError({
    kind,
    status: error.status,
    code: error.code,
    retryable: RETRYABLE_KINDS.has(kind) || error.isRetryable,
    retryAfterSeconds: error.retryAfterSeconds,
    field: safeString(details.field),
    deviceId: safeString(details.device_id),
    devices: safeDevices(details.devices),
    requestId: error.requestId,
    cause: error,
  });
}

/** Normalises any transport failure into a `DeviceApiError`. */
export function toDeviceApiError(error: unknown): DeviceApiError {
  if (error instanceof DeviceApiError) return error;
  if (isApiError(error)) return fromApiError(error);
  return new DeviceApiError({
    kind: 'unknown',
    status: 0,
    code: 'UNKNOWN',
    retryable: false,
    cause: error,
  });
}

export interface E2eeDeviceApi {
  registerDevice(
    body: WireDeviceRegistration,
    idempotencyKey: string,
  ): Promise<{ device: WireDevice; replayed: boolean }>;
  uploadPrekeys(
    deviceId: string,
    body: WireSignedPrekeyUpload,
    idempotencyKey: string,
  ): Promise<WirePrekeyUploadResult>;
  listDevices(): Promise<WireDeviceList>;
  /** Claim is deliberately not idempotent: one call must consume a fresh OPK. */
  claimPrekeys(body: WireKeyClaimRequest): Promise<WireKeyClaimResponse>;
  getChatKeys(chatId: string): Promise<WireChatKeysResponse>;
  /** `PUT /chats/{chatId}/keys/verification` (attestation, verifier = X-Device-Id). */
  verifyDevice(
    chatId: string,
    body: WireVerificationRequest,
    idempotencyKey: string,
  ): Promise<WireVerificationResponse>;
}

export interface E2eeDeviceApiOptions {
  /** Re-authentication hook (F5 wires the existing `withReauth` flow). */
  readonly onUnauthorized?: () => Promise<boolean>;
}

export function createE2eeDeviceApi(
  client: ApiClient,
  options: E2eeDeviceApiOptions = {},
): E2eeDeviceApi {
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (
        isApiError(error) &&
        error.status === 401 &&
        options.onUnauthorized &&
        (await options.onUnauthorized())
      ) {
        try {
          return await operation();
        } catch (retryError) {
          throw toDeviceApiError(retryError);
        }
      }
      throw toDeviceApiError(error);
    }
  }

  return {
    registerDevice(body, idempotencyKey) {
      return run(async () => {
        const response = await client.post<WireDevice>('/devices', body, { idempotencyKey });
        return {
          device: response.data,
          replayed: response.headers.get('Idempotent-Replay') === 'true',
        };
      });
    },

    uploadPrekeys(deviceId, body, idempotencyKey) {
      return run(async () => {
        const response = await client.post<WirePrekeyUploadResult>(
          `/devices/${encodeURIComponent(deviceId)}/prekeys`,
          body,
          { idempotencyKey },
        );
        return response.data;
      });
    },

    listDevices() {
      return run(async () => {
        const response = await client.get<WireDeviceList>('/devices');
        return response.data;
      });
    },

    claimPrekeys(body) {
      return run(async () => {
        const response = await client.post<WireKeyClaimResponse>('/keys/claim', body);
        return response.data;
      });
    },

    getChatKeys(chatId) {
      return run(async () => {
        const response = await client.get<WireChatKeysResponse>(
          `/chats/${encodeURIComponent(chatId)}/keys`,
        );
        return response.data;
      });
    },

    verifyDevice(chatId, body, idempotencyKey) {
      return run(async () => {
        const response = await client.putJson<WireVerificationResponse>(
          `/chats/${encodeURIComponent(chatId)}/keys/verification`,
          body,
          { idempotencyKey },
        );
        return response.data;
      });
    },
  };
}

import { ApiError } from '../api/problem';
import type { PreflightDecision } from '../api/types';

const STATUS_BY_CODE: Record<string, number> = {
  FILE_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 409,
  UNSUPPORTED_TYPE: 415,
  DANGEROUS_TYPE_BLOCKED: 422,
  TOO_MANY_FILES: 422,
  VALIDATION_FAILED: 422,
  CHUNK_CONFLICT: 409,
  CHUNK_HASH_MISMATCH: 422,
  UPLOAD_EXPIRED: 410,
  PRECHECK_EXPIRED: 410,
  ATTACHMENT_NOT_READY: 409,
  ATTACHMENT_QUARANTINED: 423,
  SCAN_PENDING: 409,
  UPLOAD_LOCKED: 423,
  ATTACHMENT_DELETED: 410,
};

export function statusForFileCode(code: string, fallback = 422): number {
  return STATUS_BY_CODE[code] ?? fallback;
}

export function fileError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
  status = statusForFileCode(code),
): ApiError {
  return new ApiError({
    source: 'http',
    status,
    code,
    message,
    ...(details ? { details } : {}),
  });
}

export function preflightDecisionError(decision: PreflightDecision): ApiError {
  const code = decision.error ?? 'PREFLIGHT_DENIED';
  return fileError(code, code, decision.details);
}

/** Part/complete failures that are worth retrying with the same upload id. */
export function isFileRetryable(error: ApiError): boolean {
  if (error.isAborted) return false;
  if (error.isNetwork || error.status >= 500 || error.status === 429) return true;
  if (error.status === 409 && error.code === 'CHUNK_CONFLICT') return true;
  if (error.status === 409 && error.code === 'ATTACHMENT_NOT_READY') return true;
  if (error.status === 422 && error.code === 'CHUNK_HASH_MISMATCH') return true;
  return false;
}

export function isTerminalUploadError(error: ApiError): boolean {
  return (
    error.status === 410 ||
    error.code === 'ATTACHMENT_QUARANTINED' ||
    error.code === 'SCAN_FAILED' ||
    error.code === 'FILE_TOO_LARGE' ||
    error.code === 'UNSUPPORTED_TYPE' ||
    error.code === 'DANGEROUS_TYPE_BLOCKED' ||
    error.code === 'TOO_MANY_FILES'
  );
}

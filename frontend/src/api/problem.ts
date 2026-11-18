import type { ApiErrorBody } from './types';

export type ProblemSource = 'http' | 'network' | 'timeout' | 'client';

/**
 * Normalized transport/server problem. The raw contract code is preserved for
 * the "details" disclosure, but the user always sees a translated message.
 */
export class ApiError extends Error {
  readonly source: ProblemSource;
  readonly status: number;
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  override readonly cause?: unknown;

  constructor(init: {
    source: ProblemSource;
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
    retryAfterSeconds?: number;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.source = init.source;
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.cause = init.cause;
  }

  get isNetwork(): boolean {
    return this.source === 'network' || this.source === 'timeout';
  }

  get isAborted(): boolean {
    return this.code === 'ABORTED';
  }

  get isRetryable(): boolean {
    if (this.isAborted) return false;
    if (this.isNetwork || this.status >= 500) return true;
    if (this.status === 429) return true;
    if (this.status === 409 && this.code === 'IDEMPOTENCY_IN_PROGRESS') return true;
    return false;
  }

  static network(cause?: unknown): ApiError {
    return new ApiError({
      source: 'network',
      status: 0,
      code: 'NETWORK_ERROR',
      message: 'Network request failed',
      cause,
    });
  }

  static timeout(): ApiError {
    return new ApiError({
      source: 'timeout',
      status: 0,
      code: 'TIMEOUT',
      message: 'Request timed out',
    });
  }

  static client(
    code: string,
    message: string,
    status = 0,
    details?: Record<string, unknown>,
  ): ApiError {
    return new ApiError({ source: 'client', status, code, message, details });
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number.parseInt(headerValue.trim(), 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(headerValue);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  }
  return undefined;
}

export function problemFromResponse(
  status: number,
  body: unknown,
  headers: Headers,
  fallbackMessage = '',
): ApiError {
  const errorBody = isErrorBody(body) ? body : undefined;
  return new ApiError({
    source: 'http',
    status,
    code: errorBody?.code || `HTTP_${status}`,
    message: errorBody?.message || fallbackMessage || `HTTP ${status}`,
    details: errorBody?.details,
    requestId: errorBody?.request_id || headers.get('x-request-id') || undefined,
    retryAfterSeconds: parseRetryAfter(headers.get('retry-after')),
  });
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === 'string' && typeof candidate.request_id === 'string';
}

export function toApiError(error: unknown): ApiError {
  if (isApiError(error)) return error;
  if (error instanceof Error) return ApiError.network(error);
  return ApiError.network(error);
}

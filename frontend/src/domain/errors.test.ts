import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/problem';
import { describeError } from './errors';

describe('error mapping', () => {
  it('maps 401 to a session error', () => {
    const described = describeError(
      new ApiError({
        source: 'http',
        status: 401,
        code: 'TOKEN_EXPIRED',
        message: 'expired',
        requestId: 'req_1',
      }),
    );
    expect(described.kind).toBe('session');
    expect(described.requestId).toBe('req_1');
    expect(described.retryable).toBe(true);
  });

  it('maps 403/404 to "no access" without leaking existence', () => {
    for (const status of [403, 404]) {
      const described = describeError(
        new ApiError({ source: 'http', status, code: 'NOT_FOUND', message: 'nope' }),
      );
      expect(described.kind).toBe('no_access');
      expect(described.retryable).toBe(false);
    }
  });

  it('keeps 409 IDEMPOTENCY_IN_PROGRESS retryable and reads Retry-After', () => {
    const described = describeError(
      new ApiError({
        source: 'http',
        status: 409,
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'in progress',
        retryAfterSeconds: 2,
      }),
    );
    expect(described.kind).toBe('conflict');
    expect(described.retryable).toBe(true);
    expect(described.retryAfterSeconds).toBe(2);
    expect(described.message).toContain('2');
  });

  it('does not offer blind retry for a reused idempotency key and allows text restore', () => {
    const described = describeError(
      new ApiError({
        source: 'http',
        status: 409,
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'reused',
      }),
    );
    expect(described.retryable).toBe(false);
    expect(described.canRestoreText).toBe(true);
  });

  it('maps 422 MESSAGE_TOO_LONG to a validation error with text restore', () => {
    const described = describeError(
      new ApiError({
        source: 'http',
        status: 422,
        code: 'MESSAGE_TOO_LONG',
        message: 'too long',
      }),
    );
    expect(described.kind).toBe('too_long');
    expect(described.canRestoreText).toBe(true);
  });

  it('maps 429 and 5xx to retryable states', () => {
    expect(
      describeError(
        new ApiError({
          source: 'http',
          status: 429,
          code: 'RATE_LIMITED',
          message: 'limit',
          retryAfterSeconds: 9,
        }),
      ).kind,
    ).toBe('rate_limit');
    expect(
      describeError(
        new ApiError({
          source: 'http',
          status: 503,
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'down',
        }),
      ).retryable,
    ).toBe(true);
  });

  it('maps network failures to a retryable offline-style state', () => {
    const described = describeError(ApiError.network());
    expect(described.kind).toBe('network');
    expect(described.retryable).toBe(true);
  });

  it('maps file limits and quarantine to distinct UX states', () => {
    const tooLarge = describeError(
      new ApiError({
        source: 'http',
        status: 413,
        code: 'FILE_TOO_LARGE',
        message: 'too large',
        details: { limit: 10, actual: 20 },
      }),
    );
    expect(tooLarge.kind).toBe('limit');
    expect(tooLarge.message).toContain('10 Б');
    expect(tooLarge.canRestoreText).toBe(true);

    const quota = describeError(
      new ApiError({
        source: 'http',
        status: 409,
        code: 'QUOTA_EXCEEDED',
        message: 'quota',
        details: { used: 10, reserved: 0, limit: 10, required: 5 },
      }),
    );
    expect(quota.kind).toBe('limit');
    expect(quota.retryable).toBe(false);

    const quarantined = describeError(
      new ApiError({
        source: 'http',
        status: 423,
        code: 'ATTACHMENT_QUARANTINED',
        message: 'quarantined',
      }),
    );
    expect(quarantined.kind).toBe('attachment');
    expect(quarantined.retryable).toBe(false);
    expect(quarantined.canRestoreText).toBe(true);
  });

  it('keeps ATTACHMENT_NOT_READY and CHUNK_HASH_MISMATCH retryable', () => {
    const notReady = describeError(
      new ApiError({
        source: 'http',
        status: 409,
        code: 'ATTACHMENT_NOT_READY',
        message: 'not ready',
      }),
    );
    expect(notReady.retryable).toBe(true);
    expect(notReady.canRestoreText).toBe(true);

    const hashMismatch = describeError(
      new ApiError({
        source: 'http',
        status: 422,
        code: 'CHUNK_HASH_MISMATCH',
        message: 'hash',
      }),
    );
    expect(hashMismatch.retryable).toBe(true);
  });
});

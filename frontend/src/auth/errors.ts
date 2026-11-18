import { isApiError } from '../api/problem';
import { t, type MessageKey, type Translator } from '../i18n/ru';

/**
 * Normalized Auth BFF failure. Only the documented contract codes are exposed;
 * unknown server details are collapsed into a generic variant so the UI never
 * renders raw responses (and never logs passwords/codes).
 */
export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_SUSPENDED'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'EMAIL_TAKEN'
  | 'RATE_LIMITED'
  | 'REGISTRATION_CLOSED'
  | 'VALIDATION_FAILED'
  | 'AUTH_UNAVAILABLE'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'UNKNOWN';

export interface AuthErrorInfo {
  code: AuthErrorCode;
  status: number;
  /** Present on `EMAIL_NOT_VERIFIED` when the verification is still alive. */
  verificationId?: string;
  /** Present on `CODE_INVALID` (backend `details.attempts_left`). */
  attemptsLeft?: number;
  /** From `Retry-After` on `RATE_LIMITED`. */
  retryAfterSeconds?: number;
  requestId?: string;
}

const CONTRACT_CODES = new Set<AuthErrorCode>([
  'INVALID_CREDENTIALS',
  'EMAIL_NOT_VERIFIED',
  'ACCOUNT_SUSPENDED',
  'CODE_INVALID',
  'CODE_EXPIRED',
  'EMAIL_TAKEN',
  'RATE_LIMITED',
  'REGISTRATION_CLOSED',
  'VALIDATION_FAILED',
  'AUTH_UNAVAILABLE',
  'NOT_FOUND',
]);

function readAttemptsLeft(details: Record<string, unknown> | undefined): number | undefined {
  const value = details?.attempts_left;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readVerificationId(details: Record<string, unknown> | undefined): string | undefined {
  const value = details?.verification_id;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function codeFromStatus(status: number): AuthErrorCode {
  if (status === 401) return 'INVALID_CREDENTIALS';
  if (status === 403) return 'UNKNOWN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'UNKNOWN';
  if (status === 410) return 'CODE_EXPIRED';
  if (status === 422) return 'VALIDATION_FAILED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 503) return 'AUTH_UNAVAILABLE';
  return 'UNKNOWN';
}

export function toAuthError(error: unknown): AuthErrorInfo {
  if (!isApiError(error)) {
    return { code: 'NETWORK', status: 0 };
  }
  if (error.isNetwork) {
    return { code: 'NETWORK', status: 0, requestId: error.requestId };
  }
  const known = CONTRACT_CODES.has(error.code as AuthErrorCode)
    ? (error.code as AuthErrorCode)
    : null;
  const code = known ?? codeFromStatus(error.status);
  const verificationId = readVerificationId(error.details);
  const attemptsLeft = readAttemptsLeft(error.details);
  return {
    code,
    status: error.status,
    ...(verificationId ? { verificationId } : {}),
    ...(attemptsLeft !== undefined ? { attemptsLeft } : {}),
    ...(error.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: error.retryAfterSeconds }
      : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
  };
}

export function authErrorMessage(error: AuthErrorInfo, translator: Translator = t): string {
  const translates = (key: MessageKey, vars?: Record<string, string | number>) =>
    translator(key, vars);

  switch (error.code) {
    case 'INVALID_CREDENTIALS':
      return translates('auth.error.invalidCredentials');
    case 'EMAIL_NOT_VERIFIED':
      return translates('auth.error.emailNotVerified');
    case 'ACCOUNT_SUSPENDED':
      return translates('auth.error.accountSuspended');
    case 'CODE_INVALID':
      return error.attemptsLeft !== undefined
        ? translates('auth.error.codeInvalidAttempts', { attempts: error.attemptsLeft })
        : translates('auth.error.codeInvalid');
    case 'CODE_EXPIRED':
      return translates('auth.error.codeExpired');
    case 'EMAIL_TAKEN':
      return translates('auth.error.emailTaken');
    case 'RATE_LIMITED':
      return error.retryAfterSeconds !== undefined
        ? translates('auth.error.rateLimitedRetry', { seconds: error.retryAfterSeconds })
        : translates('auth.error.rateLimited');
    case 'REGISTRATION_CLOSED':
      return translates('auth.error.registrationClosed');
    case 'VALIDATION_FAILED':
      return translates('auth.error.validation');
    case 'AUTH_UNAVAILABLE':
      return translates('auth.error.authUnavailable');
    case 'NOT_FOUND':
      return translates('auth.error.notFound');
    case 'NETWORK':
      return translates('auth.error.network');
    default:
      return translates('auth.error.generic');
  }
}

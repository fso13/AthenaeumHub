import type { ApiError } from '../api/problem';
import { t, type MessageKey } from '../i18n/ru';

/**
 * P0-3 error copy. The contract codes carry the meaning; the UI never shows a
 * raw server message (it may include internal details) and never invents a
 * success. `ErrorDetails` still exposes code/request id on demand.
 */
export function securityErrorMessage(
  error: ApiError,
  fallbackKey: MessageKey = 'security.error.generic',
): string {
  if (error.status === 401) return t('security.error.session');
  if (error.status === 403 || error.code === 'FORBIDDEN') {
    return t('security.error.forbidden');
  }
  switch (error.code) {
    case 'AUTH_UNAVAILABLE': {
      const seconds = error.retryAfterSeconds;
      return seconds === undefined
        ? t('security.error.authUnavailable')
        : t('security.error.authUnavailableRetry', { seconds });
    }
    case 'DLP_E2EE_UNSUPPORTED':
      return t('security.error.dlpE2ee');
    case 'DLP_POLICY_NAME_TAKEN':
      return t('security.error.nameTaken');
    case 'DLP_POLICY_LIMIT':
      return t('security.error.policyLimit');
    case 'MODE_CHANGE_FORBIDDEN':
      return t('security.error.modeForbidden');
    case 'NOT_FOUND':
      return t('security.error.notFound');
    case 'VALIDATION_FAILED':
      return t('security.error.validation');
    case 'NETWORK_ERROR':
      return t('security.error.network');
    case 'TIMEOUT':
      return t('security.error.timeout');
    default:
      break;
  }
  if (error.status === 404) return t('security.error.notFound');
  if (error.status === 400 || error.status === 422) {
    return t('security.error.validation');
  }
  if (error.status === 429) return t('security.error.rateLimit');
  if (error.status >= 500) return t('security.error.server');
  return t(fallbackKey);
}

export type SecurityActionTone = 'error' | 'warning';

export interface SecurityActionErrorInfo {
  text: string;
  tone: SecurityActionTone;
  retryable: boolean;
  /**
   * `true` when the list was reconciled (404/409 "already gone"): the dialog
   * can close and the card remains the source of truth.
   */
  closeOnError: boolean;
}

/** Session/policy destructive actions: 404 means the row is already gone. */
export function describeSecurityActionError(error: ApiError): SecurityActionErrorInfo {
  if (error.status === 404) {
    return {
      text: t('security.error.notFound'),
      tone: 'warning',
      retryable: false,
      closeOnError: true,
    };
  }
  if (error.status === 503 || error.code === 'AUTH_UNAVAILABLE') {
    return {
      text: securityErrorMessage(error),
      tone: 'error',
      retryable: true,
      closeOnError: false,
    };
  }
  return {
    text: securityErrorMessage(error),
    tone: 'error',
    retryable: error.isRetryable,
    closeOnError: false,
  };
}

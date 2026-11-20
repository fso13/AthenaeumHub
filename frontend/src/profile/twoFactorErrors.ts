import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';

/**
 * P0-4/#93 translated authenticator failures. Only documented contract codes
 * are explained; unknown server details never reach the DOM.
 */
export function twoFactorErrorText(error: ApiError): string {
  if (error.status === 403) return t('profile.twoFactor.reauthFailed');
  if (error.status === 429) return t('profile.twoFactor.rateLimited');
  if (error.status === 503) return t('profile.twoFactor.unavailable');
  if (error.status === 422) return t('profile.twoFactor.codeInvalid');
  if (error.status === 409) {
    if (error.code === 'TWO_FACTOR_ALREADY_ENABLED') return t('profile.twoFactor.alreadyEnabled');
    if (error.code === 'TWO_FACTOR_NOT_SETUP') return t('profile.twoFactor.notSetup');
    return t('profile.twoFactor.notEnabled');
  }
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('profile.twoFactor.genericError');
}

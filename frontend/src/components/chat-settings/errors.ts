import type { ApiError } from '../../api/problem';
import { describeError } from '../../domain/errors';
import { t } from '../../i18n/ru';

/**
 * #79 translated channel-membership failures. The backend owns role ceilings,
 * the last-OWNER guard and self-action rules; the UI only explains the code and
 * never hides a row or invents a successful state.
 */
export function chatMembershipErrorText(error: ApiError): string {
  if (error.status === 403) {
    return error.code === 'ROLE_CHANGE_FORBIDDEN'
      ? t('chatMembers.error.roleForbidden')
      : t('chatMembers.error.forbidden');
  }
  if (error.status === 404) {
    if (error.code === 'USER_NOT_FOUND') return t('chatMembers.error.userNotFound');
    return t('chatMembers.error.memberNotFound');
  }
  if (error.status === 409) {
    switch (error.code) {
      case 'LAST_OWNER':
        return t('chatMembers.error.lastOwner');
      case 'SELF_ACTION_FORBIDDEN':
        return t('chatMembers.error.self');
      case 'ROLE_CHANGE_FORBIDDEN':
        return t('chatMembers.error.roleForbidden');
      default:
        return t('chatMembers.error.conflict');
    }
  }
  if (error.status === 422) {
    if (error.code === 'CHAT_MEMBERSHIP_UNSUPPORTED') {
      return t('chatMembers.error.directUnsupported');
    }
    return t('chatMembers.error.validation');
  }
  if (error.status === 400) return t('chatMembers.error.validation');
  if (error.status === 429) return t('chatMembers.error.rateLimited');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatMembers.error.generic');
}

/** #79 invite-link failures (create/revoke/list). */
export function chatInviteErrorText(error: ApiError): string {
  if (error.status === 403) return t('chatInvites.error.forbidden');
  if (error.status === 404) return t('chatInvites.error.notFound');
  if (error.status === 422) {
    if (error.code === 'CHAT_MEMBERSHIP_UNSUPPORTED') {
      return t('chatInvites.error.directUnsupported');
    }
    return t('chatInvites.error.validation');
  }
  if (error.status === 400) return t('chatInvites.error.validation');
  if (error.status === 409) return t('chatInvites.error.conflict');
  if (error.status === 429) return t('chatInvites.error.rateLimited');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('chatInvites.error.generic');
}

/** #79 self-service block failures. */
export function blockErrorText(error: ApiError): string {
  if (error.status === 400) return t('blocked.error.validation');
  if (error.status === 403) return t('blocked.error.forbidden');
  if (error.status === 404) return t('blocked.error.notFound');
  if (error.isNetwork || error.status >= 500) return describeError(error).message;
  return t('blocked.error.generic');
}

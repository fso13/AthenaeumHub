import type { ApiError } from '../../api/problem';
import { describeError } from '../../domain/errors';
import { t } from '../../i18n/ru';

export type AdminActionTone = 'error' | 'warning';

export interface AdminActionErrorInfo {
  text: string;
  /** `warning` = the desired state already holds / list was refreshed. */
  tone: AdminActionTone;
  /** The same request can be retried safely (503, network, 5xx). */
  retryable: boolean;
  /**
   * `true` when the dialog should close: the server state is authoritative and
   * the store already refreshed the list (409 "already …", 404).
   */
  closeOnError: boolean;
}

export type AdminActionSubject = 'user' | 'chat';

/**
 * E11-F error copy. The mapping follows the documented contract codes
 * (`docs/TASKS-ADMIN-V2.md` E11, `backend/E11-B-REPORT.md`): the server is the
 * source of truth, so a repeat action or a missing row is presented as a
 * reconciled state (warning) rather than a generic failure.
 */
export function describeAdminActionError(
  error: ApiError,
  subject: AdminActionSubject,
): AdminActionErrorInfo {
  if (error.status === 403) {
    return {
      text: t('admin.actions.error.forbidden'),
      tone: 'error',
      retryable: false,
      closeOnError: false,
    };
  }

  if (error.status === 404) {
    return {
      text: t(
        subject === 'user'
          ? 'admin.actions.error.userNotFound'
          : 'admin.actions.error.chatNotFound',
      ),
      tone: 'warning',
      retryable: false,
      closeOnError: true,
    };
  }

  if (error.status === 503) {
    return {
      text: t('admin.actions.error.unavailable'),
      tone: 'error',
      retryable: true,
      closeOnError: false,
    };
  }

  if (error.status === 409) {
    switch (error.code) {
      case 'SELF_ACTION_FORBIDDEN':
        return {
          text: t('admin.actions.error.self'),
          tone: 'warning',
          retryable: false,
          closeOnError: true,
        };
      case 'LAST_PLATFORM_ADMIN':
        return {
          text: t('admin.actions.error.lastAdmin'),
          tone: 'warning',
          retryable: false,
          closeOnError: true,
        };
      case 'USER_ALREADY_SUSPENDED':
        return {
          text: t('admin.actions.error.alreadySuspended'),
          tone: 'warning',
          retryable: false,
          closeOnError: true,
        };
      case 'USER_ALREADY_ACTIVE':
        return {
          text: t('admin.actions.error.alreadyActive'),
          tone: 'warning',
          retryable: false,
          closeOnError: true,
        };
      case 'CHAT_ALREADY_DELETED':
        return {
          text: t('admin.actions.error.chatAlreadyDeleted'),
          tone: 'warning',
          retryable: false,
          closeOnError: true,
        };
      default:
        return {
          text: t('admin.actions.error.conflict'),
          tone: 'error',
          retryable: false,
          closeOnError: false,
        };
    }
  }

  if (error.isNetwork || error.status >= 500) {
    return {
      text: describeError(error).message,
      tone: 'error',
      retryable: true,
      closeOnError: false,
    };
  }

  return {
    text: t('admin.actions.error.generic'),
    tone: 'error',
    retryable: false,
    closeOnError: false,
  };
}

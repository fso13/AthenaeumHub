import type { ApiError } from '../api/problem';
import { t } from '../i18n/ru';

/**
 * #96 error vocabulary shared by the workspace and chat bot surfaces.
 *
 * The server stays authoritative; these strings only explain the contract
 * codes. Credentials/tokens never appear in an error message.
 */
export function botErrorText(error: ApiError): string {
  switch (error.code) {
    case 'BOT_NOT_FOUND':
      return t('bots.notFound');
    case 'BOT_DISABLED':
      return t('bots.disabledError');
    case 'BOT_SCOPE_FORBIDDEN':
      return t('chatSettings.bots.error.scope');
    case 'BOT_E2EE_UNSUPPORTED':
      return t('chatSettings.bots.error.e2ee');
    case 'BOT_NOT_INSTALLED':
      return t('chatSettings.bots.error.notInstalled');
    case 'BOT_AVATAR_INVALID':
      return t('bots.validation');
    default:
      break;
  }
  if (error.status === 403) return t('bots.forbidden');
  if (error.status === 404) return t('bots.notFound');
  if (error.status === 429) return t('bots.rateLimited');
  if (error.status === 400 || error.status === 422) return t('bots.validation');
  if (error.status === 503 || error.isNetwork) return t('bots.unavailable');
  return t('bots.createError');
}

/** Chat-scoped install/uninstall failures (chat OWNER/ADMIN, E2EE, disabled). */
export function chatBotErrorText(error: ApiError): string {
  switch (error.code) {
    case 'BOT_NOT_FOUND':
      return t('chatSettings.bots.error.notFound');
    case 'BOT_DISABLED':
      return t('chatSettings.bots.error.disabled');
    case 'BOT_NOT_INSTALLED':
      return t('chatSettings.bots.error.notInstalled');
    case 'BOT_SCOPE_FORBIDDEN':
      return t('chatSettings.bots.error.scope');
    case 'BOT_E2EE_UNSUPPORTED':
      return t('chatSettings.bots.error.e2ee');
    default:
      break;
  }
  if (error.status === 403) return t('chatSettings.bots.error.forbidden');
  if (error.status === 404) return t('chatSettings.bots.error.notFound');
  if (error.status === 429) return t('chatSettings.bots.error.rateLimited');
  if (error.status === 422) return t('chatSettings.bots.error.generic');
  if (error.status === 503 || error.isNetwork) return t('bots.unavailable');
  return t('chatSettings.bots.error.generic');
}

/**
 * #98 event/secret/delivery failures. Credentials never appear in the copy:
 * the server's message is not echoed, only its contract code/honest status.
 */
export function botEventErrorText(error: ApiError): string {
  switch (error.code) {
    case 'BOT_EVENTS_URL_INVALID':
      return t('bots.events.error.url');
    case 'BOT_EVENTS_NOT_CONFIGURED':
      return t('bots.events.error.notConfigured');
    case 'BOT_NOT_FOUND':
      return t('bots.notFound');
    case 'BOT_E2EE_UNSUPPORTED':
      return t('chatSettings.bots.error.e2ee');
    default:
      break;
  }
  if (error.status === 403) return t('bots.forbidden');
  if (error.status === 404) return t('bots.notFound');
  if (error.status === 429) return t('bots.rateLimited');
  if (error.status === 400 || error.status === 422) return t('bots.events.error.validation');
  if (error.status === 503 || error.isNetwork) return t('bots.unavailable');
  return t('bots.events.error.generic');
}

/** #98 slash-command invocation failures (the 202 path has no error body). */
export function botCommandErrorText(error: ApiError): string {
  switch (error.code) {
    case 'BOT_COMMAND_NOT_FOUND':
      return t('composer.command.error.notFound');
    case 'BOT_COMMAND_AMBIGUOUS':
      return t('composer.command.error.ambiguous');
    case 'BOT_EVENTS_NOT_CONFIGURED':
      return t('composer.command.error.notConfigured');
    case 'BOT_E2EE_UNSUPPORTED':
      return t('composer.command.error.e2ee');
    default:
      break;
  }
  if (error.status === 403) return t('composer.command.error.forbidden');
  if (error.status === 404) return t('composer.command.error.notFound');
  if (error.status === 409) return t('composer.command.error.ambiguous');
  if (error.status === 429) return t('composer.command.error.rateLimited');
  if (error.status === 400 || error.status === 422) return t('composer.command.error.invalid');
  if (error.status === 503 || error.isNetwork) return t('composer.command.error.unavailable');
  return t('composer.command.error.generic');
}

import type { ApiError } from '../api/problem';
import { describeError } from '../domain/errors';
import { t } from '../i18n/ru';

export type PluginActionErrorContext =
  'poll' | 'task' | 'translation' | 'pollCreate' | 'taskCreate';

/**
 * Honest, translated plugin-action errors. The 503 translation case and the
 * plugin-gate codes are contract-defined, so they get specific copy instead of
 * the generic server/validation text.
 */
export function pluginActionErrorText(error: ApiError, context: PluginActionErrorContext): string {
  switch (error.code) {
    case 'PLUGIN_NOT_ENABLED':
      return t('pluginActions.errorPluginDisabled');
    case 'PLUGIN_DISABLED':
      return t('pluginActions.errorPluginCatalogDisabled');
    case 'PLUGIN_NOT_AVAILABLE':
      return t('pluginActions.errorPluginUnavailable');
    case 'PLUGIN_NOT_FOUND':
      return t('pluginActions.errorPluginNotFound');
    case 'TRANSLATION_UNAVAILABLE':
      return t('pluginActions.translateUnavailable', {
        seconds: error.retryAfterSeconds ?? 30,
      });
    case 'MESSAGE_NOT_TRANSLATABLE':
      return t('pluginActions.translateNotText');
    case 'E2EE_METADATA_FORBIDDEN':
      return t('pluginActions.translateE2ee');
    case 'POLL_CLOSED':
      return t('pluginActions.errorPollClosed');
    case 'POLL_OPTION_INVALID':
      return t('pluginActions.errorPollOption');
    case 'POLL_STATE_INVALID':
      return t('pluginActions.errorPollState');
    case 'TASK_ASSIGNEE_INVALID':
      return t('pluginActions.errorTaskAssignee');
    default:
      break;
  }
  if (error.status === 403) return t('pluginActions.errorForbidden');
  if (error.status === 400 && (context === 'pollCreate' || context === 'taskCreate')) {
    return t('pluginActions.errorValidation');
  }
  return describeError(error).message;
}

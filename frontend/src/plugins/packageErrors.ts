import type { ApiError } from '../api/problem';
import { t, type MessageKey } from '../i18n/ru';
import type { PluginPackageClientError } from './assets';

/**
 * D1.2 (#86): user-facing copy for archive/manifest failures. The server's
 * structural validator is the authority; these mappings only translate the
 * stable contract codes into what an administrator can act on, never the raw
 * archive bytes or server stack.
 */
export function packageClientErrorText(error: PluginPackageClientError): string {
  const keys: Record<PluginPackageClientError, MessageKey> = {
    empty: 'admin.plugins.validation.empty',
    extension: 'admin.plugins.validation.extension',
    'too-large': 'admin.plugins.validation.tooLarge',
    'not-zip-mime': 'admin.plugins.validation.notZip',
  };
  return t(keys[error]);
}

export function packageInstallErrorText(error: ApiError): string {
  switch (error.code) {
    case 'PLUGIN_PACKAGE_INVALID':
      return t('admin.plugins.validation.invalid');
    case 'PLUGIN_PACKAGE_TOO_LARGE':
      return t('admin.plugins.validation.tooLarge');
    case 'PLUGIN_ALREADY_INSTALLED':
      return t('admin.plugins.validation.already');
    case 'PLUGIN_ID_RESERVED':
      return t('admin.plugins.validation.reserved');
    case 'PLUGIN_STORAGE_UNAVAILABLE':
      return t('admin.plugins.validation.storage');
    default:
      break;
  }
  if (error.status === 403) return t('admin.plugins.validation.forbidden');
  if (error.status === 413) return t('admin.plugins.validation.tooLarge');
  return t('admin.plugins.validation.generic');
}

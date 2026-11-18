import type { MessageKey } from '../../i18n/ru';

/** `/admin` sections (FR-ADM-14). Tabs live in the URL as `?tab=<id>`. */
export type AdminTab = 'overview' | 'users' | 'chats' | 'audit' | 'storage' | 'settings';

export interface AdminTabDefinition {
  id: AdminTab;
  label: MessageKey;
}

export const ADMIN_TABS: readonly AdminTabDefinition[] = [
  { id: 'overview', label: 'admin.tab.overview' },
  { id: 'users', label: 'admin.tab.users' },
  { id: 'chats', label: 'admin.tab.chats' },
  { id: 'audit', label: 'admin.tab.audit' },
  { id: 'storage', label: 'admin.tab.storage' },
  { id: 'settings', label: 'admin.tab.settings' },
];

export const DEFAULT_ADMIN_TAB: AdminTab = 'overview';

export function isAdminTab(value: string | null): value is AdminTab {
  return value !== null && ADMIN_TABS.some((tab) => tab.id === value);
}

/** Reads `?tab=` from a `pathname+search` location string; unknown values fall back. */
export function adminTabFromLocation(location: string): AdminTab {
  const queryStart = location.indexOf('?');
  if (queryStart === -1) return DEFAULT_ADMIN_TAB;
  const value = new URLSearchParams(location.slice(queryStart + 1)).get('tab');
  return isAdminTab(value) ? value : DEFAULT_ADMIN_TAB;
}

export function adminTabPath(tab: AdminTab): string {
  return tab === DEFAULT_ADMIN_TAB ? '/admin' : `/admin?tab=${tab}`;
}

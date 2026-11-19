import type {
  ChatPluginState,
  ChatPluginUnavailableReason,
  Plugin,
  PluginMode,
  PluginPermission,
  SecurityMode,
} from '../api/types';
import type { MessageKey } from '../i18n/ru';

/**
 * D1.1 (#69) closed dictionaries from the contract. Permissions and modes are
 * descriptive tokens; they are never turned into capability grants or invented
 * values in the UI.
 */
export const PLUGIN_PERMISSION_LABEL: Record<PluginPermission, MessageKey> = {
  MESSAGES: 'plugins.perms.messages',
  MEMBERS: 'plugins.perms.members',
  FILES: 'plugins.perms.files',
  WEBHOOKS: 'plugins.perms.webhooks',
};

export const PLUGIN_MODE_LABEL: Record<PluginMode, MessageKey> = {
  MANAGED: 'plugins.modeManaged',
  E2EE: 'plugins.modeE2ee',
};

export const UNAVAILABLE_REASON_LABEL: Record<ChatPluginUnavailableReason, MessageKey> = {
  PLUGIN_NOT_AVAILABLE: 'plugins.reasonNotAvailable',
  PLUGIN_DISABLED: 'plugins.reasonDisabled',
};

/**
 * The same policy the backend applies in `PluginAvailabilityPolicy`: the kill
 * switch wins over the mode check. Used by the mock backend and as a defensive
 * fallback when a chat state row is not loaded yet; the server response is
 * always preferred for rendering.
 */
export function pluginUnavailableReason(
  plugin: Pick<Plugin, 'modes' | 'state'>,
  mode: SecurityMode,
): ChatPluginUnavailableReason | null {
  if (plugin.state === 'DISABLED') return 'PLUGIN_DISABLED';
  return plugin.modes.includes(mode) ? null : 'PLUGIN_NOT_AVAILABLE';
}

/** Per-chat state indexed by `plugin_id` for card rendering. */
export function pluginStateMap(
  items: ReadonlyArray<ChatPluginState>,
): Map<string, ChatPluginState> {
  return new Map(items.map((item) => [item.plugin_id, item]));
}

/**
 * Count the switches the server reports as enabled. Availability is rendered
 * separately, and the current data cannot produce an enabled+unavailable row.
 */
export function enabledPluginCount(items: ReadonlyArray<ChatPluginState>): number {
  return items.filter((item) => item.enabled).length;
}

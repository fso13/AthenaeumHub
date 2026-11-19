import { useMemo } from 'react';
import { usePluginsState } from '../store/ChatProvider';

export interface PluginGate {
  /** Per-chat plugin rows are loaded for this chat and the chat is managed. */
  ready: boolean;
  /** Server-reported `enabled && available` for the closed plugin id. */
  enabled: (pluginId: string) => boolean;
}

/**
 * D1.1 (#69/#76) action gate. Action UI is rendered only when the server says
 * the plugin is both enabled in this chat and available for its mode; E2EE
 * chats never pass because the server marks every server-side plugin
 * unavailable there. Nothing is inferred from the catalog alone.
 */
export function usePluginGate(chatId: string | null, e2ee: boolean): PluginGate {
  const state = usePluginsState();
  return useMemo(() => {
    const ready =
      chatId !== null && !e2ee && state.chatId === chatId && state.chatStatus === 'ready';
    return {
      ready,
      enabled: (pluginId: string) =>
        ready &&
        state.chatStates.some(
          (item) => item.plugin_id === pluginId && item.enabled && item.available,
        ),
    };
  }, [chatId, e2ee, state.chatId, state.chatStatus, state.chatStates]);
}

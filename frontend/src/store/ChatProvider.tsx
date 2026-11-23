import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState, ChatStore } from './chatStore';
import type { FilesState, FilesStore } from './filesStore';
import type { AdminDirectoryState, AdminDirectoryStore } from '../ops/adminDirectory';
import type { OpsState, OpsStore } from '../ops/store';
import type { PluginsState, PluginsStore } from '../plugins/store';
import type { PluginActionsState, PluginActionsStore } from '../plugins/actionsStore';
import type { StickersState, StickersStore } from '../stickers/store';
import type { SecurityState, SecurityStore } from '../security/securityStore';
import type {
  ProfileWorkspaceState,
  ProfileWorkspaceStore,
} from '../profile/profileWorkspaceStore';
import type { WorkspaceOverviewState, WorkspaceOverviewStore } from '../workspace/overviewStore';
import type { AvatarStore, AvatarsState } from '../avatars/avatarStore';
import type { BotsState, BotsStore } from '../bots/botsStore';
import type { RoomsState, RoomsStore } from '../rooms/roomsStore';

const ChatStoreContext = createContext<ChatStore | null>(null);

export function ChatProvider({ store, children }: { store: ChatStore; children: ReactNode }) {
  return <ChatStoreContext.Provider value={store}>{children}</ChatStoreContext.Provider>;
}

export function useChatStore(): ChatStore {
  const store = useContext(ChatStoreContext);
  if (!store) throw new Error('useChatStore must be used inside <ChatProvider>');
  return store;
}

export function useChatState(): AppState {
  const store = useChatStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useFilesStore(): FilesStore {
  return useChatStore().files;
}

export function useFilesState(): FilesState {
  const store = useFilesStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useStickersStore(): StickersStore {
  return useChatStore().stickers;
}

export function useStickersState(): StickersState {
  const store = useStickersStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** D1.1 (#69): built-in plugin catalog and per-chat switches. */
export function usePluginsStore(): PluginsStore {
  return useChatStore().plugins;
}

export function usePluginsState(): PluginsState {
  const store = usePluginsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** D1.1 (#76): poll/task/translation actions for the active managed chat. */
export function usePluginActionsStore(): PluginActionsStore {
  return useChatStore().pluginActions;
}

export function usePluginActionsState(): PluginActionsState {
  const store = usePluginActionsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useOpsStore(): OpsStore {
  return useChatStore().ops;
}

export function useOpsState(): OpsState {
  const store = useOpsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useAdminDirectoryStore(): AdminDirectoryStore {
  return useOpsStore().directory;
}

/** P0-3 (#81): workspace security has its own subscription surface. */
export function useSecurityStore(): SecurityStore {
  return useChatStore().security;
}

export function useSecurityState(): SecurityState {
  const store = useSecurityStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** P0-4 (#82): avatar/TOTP and workspace settings/invites/permissions. */
export function useProfileWorkspaceStore(): ProfileWorkspaceStore {
  return useChatStore().profile;
}

export function useProfileWorkspaceState(): ProfileWorkspaceState {
  const store = useProfileWorkspaceStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Per-id chat/workspace avatar bytes with initials fallback at the call site. */
export function useAvatarsStore(): AvatarStore {
  return useChatStore().avatars;
}

export function useAvatarsState(): AvatarsState {
  const store = useAvatarsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** #96: workspace bots (one-time token stays in memory) + chat installs. */
export function useBotsStore(): BotsStore {
  return useChatStore().bots;
}

export function useBotsState(): BotsState {
  const store = useBotsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** #84: workspace overview aggregates for the dashboard page. */
export function useWorkspaceOverviewStore(): WorkspaceOverviewStore {
  return useChatStore().workspaceOverview;
}

export function useWorkspaceOverviewState(): WorkspaceOverviewState {
  const store = useWorkspaceOverviewStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** E9-F: users/chats/storage slices have their own subscription surface. */
export function useAdminDirectoryState(): AdminDirectoryState {
  const store = useAdminDirectoryStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** #105 rooms: workspace room list, TTL presence and the mesh-call bridge. */
export function useRoomsStore(): RoomsStore {
  return useChatStore().rooms;
}

export function useRoomsState(): RoomsState {
  const store = useRoomsStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

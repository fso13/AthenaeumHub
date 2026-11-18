import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react';
import type { AppState, ChatStore } from './chatStore';
import type { FilesState, FilesStore } from './filesStore';
import type { AdminDirectoryState, AdminDirectoryStore } from '../ops/adminDirectory';
import type { OpsState, OpsStore } from '../ops/store';
import type { StickersState, StickersStore } from '../stickers/store';

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

/** E9-F: users/chats/storage slices have their own subscription surface. */
export function useAdminDirectoryState(): AdminDirectoryState {
  const store = useAdminDirectoryStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

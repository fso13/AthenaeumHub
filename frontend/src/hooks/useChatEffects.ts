import { useEffect } from 'react';
import type { ChatStore } from '../store/chatStore';

export function useAppBootstrap(store: ChatStore, bootstrapKey: string | null = null): void {
  useEffect(() => {
    void store.bootstrap();
  }, [store, bootstrapKey]);
}

export function useOnlineStatus(store: ChatStore): void {
  useEffect(() => {
    const handleOnline = () => {
      // `setOnline` resumes WS (sync → ticket → subscribe) or syncs directly
      // when realtime is disabled; do not issue a second /sync here.
      store.setOnline(true);
    };
    const handleOffline = () => store.setOnline(false);

    store.setOnline(typeof navigator === 'undefined' ? true : navigator.onLine);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [store]);
}

/**
 * Reconnect path for this slice: no WebSocket, only GET /sync plus REST catch-up.
 * Runs on visibility change, on reconnect (store.setOnline triggers sync) and
 * periodically while the tab is visible.
 */
export function useReconnectSync(store: ChatStore, enabled: boolean, intervalMs: number): void {
  useEffect(() => {
    if (!enabled) return;

    const syncIfVisible = () => {
      if (document.visibilityState === 'visible') void store.sync();
    };

    const interval = setInterval(syncIfVisible, intervalMs);
    document.addEventListener('visibilitychange', syncIfVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', syncIfVisible);
    };
  }, [store, enabled, intervalMs]);
}

export function useReadReceipt(
  store: ChatStore,
  chatId: string | null,
  maxVisibleSeq: number,
  enabled: boolean,
  debounceMs: number,
): void {
  useEffect(() => {
    if (!enabled || !chatId || maxVisibleSeq <= 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === 'visible') {
          void store.markRead(chatId, maxVisibleSeq);
        }
      }, debounceMs);
    };

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [store, chatId, maxVisibleSeq, enabled, debounceMs]);
}

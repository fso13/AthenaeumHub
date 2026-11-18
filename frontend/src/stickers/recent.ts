/**
 * Local "recent stickers" cache (E5-F).
 *
 * E5-D-03: favorites are server-side (cross-device), recent stickers are local.
 * We persist only sticker ids/metadata — never tokens — in IndexedDB, and fall
 * back to an in-memory list when IndexedDB is unavailable (jsdom, private mode,
 * blocked storage). A failed read/write must never break the picker.
 */
import type { StickerRef } from '../api/types';

export interface RecentSticker {
  id: string;
  pack_id: string;
  alt: string;
  url: string;
}

export const MAX_RECENT_STICKERS = 24;
export const RECENT_DB_NAME = 'krug-stickers';
export const RECENT_STORE_NAME = 'recent';

export interface RecentStorage {
  load(): Promise<RecentSticker[]>;
  save(items: readonly RecentSticker[]): Promise<void>;
}

export function toRecentSticker(
  sticker: Pick<StickerRef, 'id' | 'pack_id' | 'alt' | 'url'>,
): RecentSticker {
  return {
    id: sticker.id,
    pack_id: sticker.pack_id,
    alt: sticker.alt,
    url: sticker.url,
  };
}

export function mergeRecent(
  current: readonly RecentSticker[],
  sticker: StickerRef,
  limit = MAX_RECENT_STICKERS,
): RecentSticker[] {
  const next = toRecentSticker(sticker);
  return [next, ...current.filter((entry) => entry.id !== next.id)].slice(0, Math.max(0, limit));
}

function isRecentSticker(value: unknown): value is RecentSticker {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.pack_id === 'string' &&
    typeof candidate.alt === 'string' &&
    typeof candidate.url === 'string'
  );
}

export function normalizeRecent(value: unknown, limit = MAX_RECENT_STICKERS): RecentSticker[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const items: RecentSticker[] = [];
  for (const entry of value) {
    if (!isRecentSticker(entry) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    items.push(toRecentSticker(entry));
    if (items.length >= limit) break;
  }
  return items;
}

export function createMemoryRecentStorage(initial: readonly RecentSticker[] = []): RecentStorage {
  let items = normalizeRecent(initial);
  return {
    load: () => Promise.resolve(items.map((entry) => ({ ...entry }))),
    save: (next) => {
      items = normalizeRecent(next);
      return Promise.resolve();
    },
  };
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(RECENT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(RECENT_STORE_NAME)) {
        database.createObjectStore(RECENT_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

/**
 * IndexedDB-backed recent storage, scoped per user. Falls back to the memory
 * implementation on any failure so a broken storage API never blocks sending.
 */
export function createRecentStorage(owner: string): RecentStorage {
  if (typeof indexedDB === 'undefined') return createMemoryRecentStorage();

  const memory = createMemoryRecentStorage();
  const key = `recent:${owner || 'anonymous'}`;
  let databasePromise: Promise<IDBDatabase> | null = null;

  const database = (): Promise<IDBDatabase> => {
    databasePromise ??= openDatabase().catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
    return databasePromise;
  };

  return {
    async load() {
      try {
        const db = await database();
        const transaction = db.transaction(RECENT_STORE_NAME, 'readonly');
        const result = await requestToPromise(transaction.objectStore(RECENT_STORE_NAME).get(key));
        return normalizeRecent(result);
      } catch {
        return memory.load();
      }
    },

    async save(items) {
      const normalized = normalizeRecent(items);
      try {
        const db = await database();
        const transaction = db.transaction(RECENT_STORE_NAME, 'readwrite');
        transaction.objectStore(RECENT_STORE_NAME).put(normalized, key);
        await new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(transaction.error ?? new Error('IndexedDB transaction failed'));
          transaction.onabort = () =>
            reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        });
      } catch {
        await memory.save(normalized);
      }
    },
  };
}

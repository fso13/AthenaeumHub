/**
 * Local-only song artwork cache (D1-FE2).
 *
 * Artwork parsed from a client-side ID3 `APIC` frame is never uploaded: the
 * contract only carries `media.artwork_url`, and server-side extraction is
 * D1.1. To still show a cover immediately (and after a reload in the same
 * browser) the bytes are stored in IndexedDB keyed by attachment id. E2EE
 * keeps exactly the same local-only path — no plaintext artwork is sent.
 *
 * IndexedDB is best-effort: private mode / blocked storage / jsdom fall back
 * to an in-memory map, and any failure must never break the message feed.
 */
import type { Id3Artwork } from './id3';

export const ARTWORK_DB_NAME = 'krug-media';
export const ARTWORK_STORE_NAME = 'artwork';
export const MAX_ARTWORK_ENTRIES = 100;

export interface LocalArtwork {
  mime: string;
  bytes: Uint8Array;
  addedAt: number;
}

interface StoredArtwork {
  mime: string;
  bytes: Uint8Array | ArrayBuffer;
  addedAt: number;
}

const memory = new Map<string, LocalArtwork>();
const objectUrls = new Map<string, string>();
let databasePromise: Promise<IDBDatabase | null> | null = null;

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(ARTWORK_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(ARTWORK_STORE_NAME)) {
        database.createObjectStore(ARTWORK_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function database(): Promise<IDBDatabase | null> {
  databasePromise ??= openDatabase().catch(() => null);
  return databasePromise;
}

function isStoredArtwork(value: unknown): value is StoredArtwork {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.mime === 'string' &&
    typeof candidate.addedAt === 'number' &&
    (candidate.bytes instanceof Uint8Array || candidate.bytes instanceof ArrayBuffer)
  );
}

function normalizeStored(value: StoredArtwork): LocalArtwork | null {
  const bytes =
    value.bytes instanceof Uint8Array ? value.bytes.slice() : new Uint8Array(value.bytes.slice(0));
  if (bytes.length === 0 || !value.mime.startsWith('image/')) return null;
  return { mime: value.mime, bytes, addedAt: value.addedAt };
}

/** Store parsed artwork for an attachment. Safe to call for every upload. */
export async function putLocalArtwork(
  attachmentId: string,
  artwork: Id3Artwork | null | undefined,
): Promise<void> {
  if (!attachmentId || !artwork || artwork.bytes.length === 0) return;
  const entry: LocalArtwork = {
    mime: artwork.mime,
    bytes: artwork.bytes.slice(),
    addedAt: Date.now(),
  };
  memory.set(attachmentId, entry);
  // A new image invalidates the old object URL for this id.
  revokeObjectUrl(attachmentId);

  const db = await database();
  if (!db) return;
  try {
    const transaction = db.transaction(ARTWORK_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(ARTWORK_STORE_NAME);
    store.put(entry, attachmentId);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('artwork put failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('artwork put aborted'));
    });
    await prune(db);
  } catch {
    // Memory fallback already holds the entry.
  }
}

async function prune(db: IDBDatabase): Promise<void> {
  try {
    const transaction = db.transaction(ARTWORK_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(ARTWORK_STORE_NAME);
    const entries = await requestToPromise(store.getAll());
    if (entries.length <= MAX_ARTWORK_ENTRIES) return;
    const rows = entries
      .filter((value): value is StoredArtwork => isStoredArtwork(value))
      .sort((a, b) => a.addedAt - b.addedAt);
    const keys = await requestToPromise(store.getAllKeys());
    if (keys.length !== rows.length) return; // concurrent update; skip pruning
    const keep = new Set<string>();
    for (
      let index = Math.max(0, rows.length - MAX_ARTWORK_ENTRIES);
      index < rows.length;
      index += 1
    ) {
      const key = keys[index];
      if (key !== undefined) keep.add(String(key));
    }
    for (const key of keys) {
      if (!keep.has(String(key))) store.delete(key);
    }
  } catch {
    // Best effort.
  }
}

async function readLocalArtwork(attachmentId: string): Promise<LocalArtwork | null> {
  const cached = memory.get(attachmentId);
  if (cached) return cached;
  const db = await database();
  if (!db) return null;
  try {
    const transaction = db.transaction(ARTWORK_STORE_NAME, 'readonly');
    const value = await requestToPromise(
      transaction.objectStore(ARTWORK_STORE_NAME).get(attachmentId),
    );
    if (!isStoredArtwork(value)) return null;
    const normalized = normalizeStored(value);
    if (normalized) memory.set(attachmentId, normalized);
    return normalized;
  } catch {
    return null;
  }
}

function revokeObjectUrl(attachmentId: string): void {
  const url = objectUrls.get(attachmentId);
  if (url === undefined) return;
  objectUrls.delete(attachmentId);
  try {
    URL.revokeObjectURL(url);
  } catch {
    // Object URLs may be unavailable in the test environment.
  }
}

function makeObjectUrl(attachmentId: string, artwork: LocalArtwork): string | null {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    const copy = new Uint8Array(artwork.bytes);
    const blob = new Blob([copy.buffer as ArrayBuffer], { type: artwork.mime });
    const url = URL.createObjectURL(blob);
    objectUrls.set(attachmentId, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Resolve a local cover as an object URL. Returns `null` when no artwork was
 * cached (default cover) or the environment cannot create object URLs.
 */
export async function getLocalArtworkUrl(attachmentId: string): Promise<string | null> {
  if (!attachmentId) return null;
  const existing = objectUrls.get(attachmentId);
  if (existing) return existing;
  const artwork = await readLocalArtwork(attachmentId);
  if (!artwork) return null;
  return makeObjectUrl(attachmentId, artwork);
}

export async function clearLocalArtwork(attachmentId: string): Promise<void> {
  memory.delete(attachmentId);
  revokeObjectUrl(attachmentId);
  const db = await database();
  if (!db) return;
  try {
    const transaction = db.transaction(ARTWORK_STORE_NAME, 'readwrite');
    transaction.objectStore(ARTWORK_STORE_NAME).delete(attachmentId);
  } catch {
    // Best effort.
  }
}

/** Test hook: drop memory state and close the cached connection. */
export function resetArtworkCacheForTests(): void {
  for (const id of [...objectUrls.keys()]) revokeObjectUrl(id);
  memory.clear();
  databasePromise = null;
}

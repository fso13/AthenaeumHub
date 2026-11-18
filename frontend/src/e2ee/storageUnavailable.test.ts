/**
 * IndexedDB is not available in every embedding (jsdom, hardened browser
 * modes). The adapter must fail with the protocol's `KEY_STORAGE_UNAVAILABLE`,
 * never silently fall back to localStorage/in-memory persistence.
 */
import { describe, expect, it } from 'vitest';
import { createIndexedDbStorage } from './storage/indexedDb';

describe('IndexedDB unavailable', () => {
  it('has no global indexedDB in this environment', () => {
    expect((globalThis as { indexedDB?: unknown }).indexedDB).toBeUndefined();
  });

  it('rejects operations with KEY_STORAGE_UNAVAILABLE', async () => {
    const storage = createIndexedDbStorage({ databaseName: 'krug-e2ee-unavailable' });
    await expect(storage.get('keys', 'a')).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
    await expect(storage.put('keys', 'a', 1)).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });

  it('wraps a broken IDBFactory into the same typed error', async () => {
    const factory = {
      open: () => {
        throw new Error('IDBFactory exploded');
      },
    } as unknown as IDBFactory;
    const storage = createIndexedDbStorage({ databaseName: 'krug-e2ee-broken', factory });
    await expect(storage.keys('keys')).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });

  it('reports a blocked upgrade as KEY_STORAGE_UNAVAILABLE', async () => {
    const factory = {
      open: () => {
        const request = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
          onblocked: null,
        } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => {
          (request.onblocked as (() => void) | null)?.();
        });
        return request;
      },
    } as unknown as IDBFactory;
    const storage = createIndexedDbStorage({ databaseName: 'krug-e2ee-blocked', factory });
    await expect(storage.get('keys', 'a')).rejects.toMatchObject({
      code: 'KEY_STORAGE_UNAVAILABLE',
    });
  });
});

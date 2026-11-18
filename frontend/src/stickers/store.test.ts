import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/problem';
import type { StickerPack, StickerRef } from '../api/types';
import { buildStickerPacks } from '../mocks/fixtures';
import { createMemoryRecentStorage, toRecentSticker } from './recent';
import { createStickersStore } from './store';

function packs(): StickerPack[] {
  return JSON.parse(JSON.stringify(buildStickerPacks())) as StickerPack[];
}

function firstSticker(catalog: StickerPack[]): StickerRef {
  const sticker = catalog[0]?.stickers[0];
  if (!sticker) throw new Error('Fixture pack is empty');
  return sticker;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('StickersStore', () => {
  it('loads packs and hydrates recent ids against the catalog', async () => {
    const catalog = packs();
    const target = firstSticker(catalog);
    const storage = createMemoryRecentStorage([toRecentSticker(target)]);
    const api = {
      listStickerPacks: vi.fn().mockResolvedValue({ items: catalog }),
      favoriteSticker: vi.fn(),
      unfavoriteSticker: vi.fn(),
    };
    const store = createStickersStore({ api, storage });
    store.setOwner('user-1');
    await flush();
    await store.load('chat-1');
    await flush();

    const state = store.getSnapshot();
    expect(state.status).toBe('ready');
    expect(state.packs).toHaveLength(2);
    expect(state.recent).toHaveLength(1);
    expect(store.stickerById(target.id)?.alt).toBe(target.alt);
    store.dispose();
  });

  it('optimistically favorites a sticker and rolls back on server failure', async () => {
    const catalog = packs();
    const target = firstSticker(catalog);
    const request = deferred<void>();
    const api = {
      listStickerPacks: vi.fn().mockResolvedValue({ items: catalog }),
      favoriteSticker: vi.fn().mockReturnValue(request.promise),
      unfavoriteSticker: vi.fn(),
    };
    const store = createStickersStore({ api, storage: createMemoryRecentStorage() });
    await store.load('chat-1');

    const pending = store.toggleFavorite(store.stickerById(target.id)!);
    expect(store.stickerById(target.id)?.favorite).toBe(true);
    expect(store.getSnapshot().pendingFavoriteIds).toContain(target.id);

    request.resolve();
    await pending;
    expect(store.getSnapshot().pendingFavoriteIds).not.toContain(target.id);
    expect(api.favoriteSticker).toHaveBeenCalledWith(target.id);
    store.dispose();
  });

  it('rolls a failed favorite back to the previous state', async () => {
    const catalog = packs();
    const target = firstSticker(catalog);
    const api = {
      listStickerPacks: vi.fn().mockResolvedValue({ items: catalog }),
      favoriteSticker: vi
        .fn()
        .mockRejectedValue(
          new ApiError({ source: 'http', status: 500, code: 'INTERNAL', message: 'x' }),
        ),
      unfavoriteSticker: vi.fn(),
    };
    const store = createStickersStore({ api, storage: createMemoryRecentStorage() });
    await store.load('chat-1');

    await store.toggleFavorite(store.stickerById(target.id)!);

    expect(store.stickerById(target.id)?.favorite).toBe(false);
    expect(store.getSnapshot().favoriteError?.status).toBe(500);
    store.dispose();
  });

  it('hides a disabled pack from the picker and recent resolution', async () => {
    const catalog = packs();
    const target = firstSticker(catalog);
    const api = {
      listStickerPacks: vi.fn().mockResolvedValue({ items: catalog }),
      favoriteSticker: vi.fn(),
      unfavoriteSticker: vi.fn(),
    };
    const store = createStickersStore({ api, storage: createMemoryRecentStorage() });
    await store.load('chat-1');
    store.recordRecent(target);
    store.disablePack(target.pack_id);

    expect(store.packsForPicker()).toHaveLength(1);
    expect(store.stickerById(target.id)).toBeNull();
    expect(store.getSnapshot().disabledPackIds).toEqual([target.pack_id]);
    store.dispose();
  });

  it('rehydrates recent from local storage after logout/reset for the same user', async () => {
    const catalog = packs();
    const target = firstSticker(catalog);
    const storage = createMemoryRecentStorage();
    const api = {
      listStickerPacks: vi.fn().mockResolvedValue({ items: catalog }),
      favoriteSticker: vi.fn(),
      unfavoriteSticker: vi.fn(),
    };
    const store = createStickersStore({ api, storage });
    store.setOwner('user-1');
    store.recordRecent(target);
    await flush();

    store.reset();
    expect(store.getSnapshot().recent).toHaveLength(0);

    store.setOwner('user-1');
    await flush();
    expect(store.getSnapshot().recent.map((entry) => entry.id)).toEqual([target.id]);
    store.dispose();
  });

  it('records recent stickers once, newest first', async () => {
    const catalog = packs();
    const [first, second] = catalog[0]!.stickers;
    const api = {
      listStickerPacks: vi.fn().mockResolvedValue({ items: catalog }),
      favoriteSticker: vi.fn(),
      unfavoriteSticker: vi.fn(),
    };
    const store = createStickersStore({ api, storage: createMemoryRecentStorage() });
    store.recordRecent(first!);
    store.recordRecent(second!);
    store.recordRecent(first!);

    expect(store.getSnapshot().recent.map((entry) => entry.id)).toEqual([first!.id, second!.id]);
    store.dispose();
  });
});

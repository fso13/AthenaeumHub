import { describe, expect, it } from 'vitest';
import type { StickerRef } from '../api/types';
import {
  MAX_RECENT_STICKERS,
  createMemoryRecentStorage,
  mergeRecent,
  normalizeRecent,
  toRecentSticker,
  type RecentSticker,
} from './recent';

function sticker(id: string, alt = `alt ${id}`): StickerRef {
  return {
    id,
    pack_id: 'pack-1',
    alt,
    url: `/stickers/krug/${id}.png`,
    favorite: false,
  };
}

describe('recent sticker cache', () => {
  it('moves a reused sticker to the front without duplicates', () => {
    const first = sticker('01');
    const second = sticker('02');
    const recent = mergeRecent(mergeRecent([], first), second);
    const reused = mergeRecent(recent, first);

    expect(reused.map((entry) => entry.id)).toEqual(['01', '02']);
    expect(reused[0]).toEqual(toRecentSticker(first));
  });

  it('caps the list and keeps only valid unique entries', () => {
    const items: RecentSticker[] = Array.from({ length: MAX_RECENT_STICKERS + 5 }, (_, index) => ({
      id: String(index),
      pack_id: 'pack-1',
      alt: `alt ${index}`,
      url: `/stickers/${index}.png`,
    }));

    expect(normalizeRecent(items)).toHaveLength(MAX_RECENT_STICKERS);
    expect(normalizeRecent([...items, items[0], { id: 1, alt: null }])).toHaveLength(
      MAX_RECENT_STICKERS,
    );
  });

  it('round-trips through the memory fallback storage', async () => {
    const storage = createMemoryRecentStorage();
    await storage.save([toRecentSticker(sticker('07')), toRecentSticker(sticker('08'))]);
    const loaded = await storage.load();

    expect(loaded.map((entry) => entry.id)).toEqual(['07', '08']);
    expect(loaded[0]).not.toBeUndefined();
  });
});

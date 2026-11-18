import type { ApiMessage, StickerPack, StickerRef } from '../api/types';
import type { RecentSticker } from './recent';

const STICKER_TYPE: ApiMessage['type'] = 'STICKER';

/**
 * Contract E5: `Message.type=STICKER` and `Message.sticker` carry the media.
 * `sticker_id` alone is tolerated (the contract allows `sticker: null`) so the
 * UI can still recognise the message kind even without the resolved ref.
 */
export function isStickerMessage(message: ApiMessage): boolean {
  return message.type === STICKER_TYPE || Boolean(message.sticker_id) || Boolean(message.sticker);
}

export function stickerOf(message: ApiMessage): StickerRef | null {
  if (!isStickerMessage(message)) return null;
  return message.sticker ?? null;
}

export function stickerPreviewAlt(message: ApiMessage): string | null {
  const sticker = stickerOf(message);
  return sticker?.alt?.trim() || null;
}

export function allStickers(packs: readonly StickerPack[]): StickerRef[] {
  return packs.flatMap((pack) => pack.stickers);
}

export function availablePacks(
  packs: readonly StickerPack[],
  disabledPackIds: readonly string[],
): StickerPack[] {
  if (disabledPackIds.length === 0) return [...packs];
  const disabled = new Set(disabledPackIds);
  return packs.filter((pack) => !disabled.has(pack.id));
}

export function favoriteStickers(
  packs: readonly StickerPack[],
  disabledPackIds: readonly string[],
): StickerRef[] {
  return allStickers(availablePacks(packs, disabledPackIds)).filter((sticker) => sticker.favorite);
}

/**
 * Recent entries are resolved against the freshly loaded catalog: a sticker
 * from a disabled/removed pack must not stay reachable through "recent".
 */
export function recentStickers(
  packs: readonly StickerPack[],
  disabledPackIds: readonly string[],
  recent: readonly RecentSticker[],
): StickerRef[] {
  const byId = new Map(allStickers(packs).map((sticker) => [sticker.id, sticker]));
  const disabled = new Set(disabledPackIds);
  const resolved: StickerRef[] = [];
  for (const entry of recent) {
    if (disabled.has(entry.pack_id)) continue;
    const sticker = byId.get(entry.id);
    if (sticker) resolved.push(sticker);
  }
  return resolved;
}

/** Alt-text search is case-insensitive and trims repeated whitespace. */
export function filterStickers(stickers: readonly StickerRef[], query: string): StickerRef[] {
  const needle = query.trim().toLocaleLowerCase('ru');
  if (!needle) return [...stickers];
  return stickers.filter((sticker) => sticker.alt.toLocaleLowerCase('ru').includes(needle));
}

export function stickerButtonLabel(sticker: StickerRef): string {
  return sticker.alt.trim();
}

export function findSticker(packs: readonly StickerPack[], stickerId: string): StickerRef | null {
  for (const pack of packs) {
    const sticker = pack.stickers.find((item) => item.id === stickerId);
    if (sticker) return sticker;
  }
  return null;
}

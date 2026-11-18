import type { ChatApi } from '../api/endpoints';
import { toApiError, type ApiError } from '../api/problem';
import type { StickerPack, StickerRef } from '../api/types';
import { availablePacks, findSticker } from './model';
import { createRecentStorage, mergeRecent, type RecentSticker, type RecentStorage } from './recent';

export interface StickersState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  chatId: string | null;
  packs: StickerPack[];
  /** Locally persisted ids/metadata; resolved against `packs` for rendering. */
  recent: RecentSticker[];
  /** Packs the server rejected with 409 STICKER_PACK_DISABLED during this session. */
  disabledPackIds: string[];
  pendingFavoriteIds: string[];
  error: ApiError | null;
  favoriteError: ApiError | null;
}

export interface StickersStoreDeps {
  api: Pick<ChatApi, 'listStickerPacks' | 'favoriteSticker' | 'unfavoriteSticker'>;
  /** Test seam; production creates a per-user IndexedDB adapter. */
  storage?: RecentStorage;
}

const EMPTY_STATE: StickersState = {
  status: 'idle',
  chatId: null,
  packs: [],
  recent: [],
  disabledPackIds: [],
  pendingFavoriteIds: [],
  error: null,
  favoriteError: null,
};

export class StickersStore {
  private readonly api: StickersStoreDeps['api'];
  private readonly injectedStorage: RecentStorage | undefined;
  private storage: RecentStorage;
  private state: StickersState = { ...EMPTY_STATE };
  private readonly listeners = new Set<() => void>();
  private loadPromise: Promise<void> | null = null;
  private loadChatId: string | null = null;
  private owner = '';
  private storageGeneration = 0;
  private disposed = false;

  constructor(deps: StickersStoreDeps) {
    this.api = deps.api;
    this.injectedStorage = deps.storage;
    this.storage = deps.storage ?? createRecentStorage('');
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): StickersState => this.state;

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  /**
   * Recent stickers are local to the signed-in user. Changing owner swaps the
   * storage namespace and drops the previous user's list from memory.
   */
  setOwner(owner: string | null): void {
    const next = owner ?? '';
    if (next === this.owner) return;
    this.owner = next;
    this.storageGeneration += 1;
    const generation = this.storageGeneration;
    this.storage = this.injectedStorage ?? createRecentStorage(next);
    this.patch({ recent: [] });
    void this.hydrateRecent(generation);
  }

  private async hydrateRecent(generation = this.storageGeneration): Promise<void> {
    try {
      const stored = await this.storage.load();
      if (this.disposed || generation !== this.storageGeneration) return;
      this.patch({ recent: stored });
    } catch {
      // Local recent cache is best-effort; the picker works without it.
    }
  }

  private emit(): void {
    if (this.disposed) return;
    for (const listener of this.listeners) listener();
  }

  private patch(patch: Partial<StickersState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  async ensure(chatId: string): Promise<void> {
    if (this.state.status === 'loading' && this.loadChatId === chatId) {
      return this.loadPromise ?? Promise.resolve();
    }
    if (this.state.status === 'ready' && this.state.chatId === chatId) return;
    return this.load(chatId);
  }

  async load(chatId: string, force = false): Promise<void> {
    if (!force && this.state.status === 'ready' && this.state.chatId === chatId) return;
    if (this.state.status === 'loading' && this.loadChatId === chatId && this.loadPromise) {
      return this.loadPromise;
    }

    this.loadChatId = chatId;
    this.patch({
      status: 'loading',
      chatId,
      error: null,
      ...(this.state.chatId === chatId ? {} : { packs: [], favoriteError: null }),
    });

    this.loadPromise = this.runLoad(chatId).finally(() => {
      this.loadPromise = null;
      this.loadChatId = null;
    });
    return this.loadPromise;
  }

  private async runLoad(chatId: string): Promise<void> {
    try {
      const response = await this.api.listStickerPacks(chatId);
      if (this.disposed) return;
      if (this.state.chatId !== chatId) return;
      this.patch({
        status: 'ready',
        packs: response.items,
        error: null,
      });
    } catch (error) {
      if (this.disposed) return;
      const apiError = toApiError(error);
      this.patch({
        status: 'error',
        error: apiError,
        ...(this.state.packs.length === 0 ? { chatId } : {}),
      });
    }
  }

  async toggleFavorite(sticker: StickerRef): Promise<void> {
    if (this.state.pendingFavoriteIds.includes(sticker.id)) return;
    const nextFavorite = !sticker.favorite;
    const previous = this.state.packs;

    this.patch({
      packs: this.setFavorite(previous, sticker.id, nextFavorite),
      pendingFavoriteIds: [...this.state.pendingFavoriteIds, sticker.id],
      favoriteError: null,
    });

    try {
      if (nextFavorite) {
        await this.api.favoriteSticker(sticker.id);
      } else {
        await this.api.unfavoriteSticker(sticker.id);
      }
      if (this.disposed) return;
      this.patch({
        pendingFavoriteIds: this.state.pendingFavoriteIds.filter((id) => id !== sticker.id),
      });
    } catch (error) {
      if (this.disposed) return;
      this.patch({
        packs: previous,
        pendingFavoriteIds: this.state.pendingFavoriteIds.filter((id) => id !== sticker.id),
        favoriteError: toApiError(error),
      });
    }
  }

  private setFavorite(
    packs: readonly StickerPack[],
    stickerId: string,
    favorite: boolean,
  ): StickerPack[] {
    return packs.map((pack) => ({
      ...pack,
      stickers: pack.stickers.map((sticker) =>
        sticker.id === stickerId ? { ...sticker, favorite } : sticker,
      ),
    }));
  }

  /**
   * A 409 STICKER_PACK_DISABLED means new stickers from the pack are rejected.
   * Hide the pack for this session; history keeps rendering (server contract).
   */
  disablePack(packId: string): void {
    if (!packId || this.state.disabledPackIds.includes(packId)) return;
    this.patch({ disabledPackIds: [...this.state.disabledPackIds, packId] });
  }

  recordRecent(sticker: StickerRef): void {
    const recent = mergeRecent(this.state.recent, sticker);
    this.patch({ recent });
    const generation = this.storageGeneration;
    void this.storage.save(recent).catch(() => {
      if (this.disposed || generation !== this.storageGeneration) return;
      // Persistence is best-effort; the in-memory list is still usable.
    });
  }

  clearFavoriteError(): void {
    if (!this.state.favoriteError) return;
    this.patch({ favoriteError: null });
  }

  /** Available packs for the picker (disabled packs are hidden). */
  packsForPicker(): StickerPack[] {
    return availablePacks(this.state.packs, this.state.disabledPackIds);
  }

  stickerById(stickerId: string): StickerRef | null {
    return findSticker(this.packsForPicker(), stickerId);
  }

  reset(): void {
    this.storageGeneration += 1;
    // Drop the owner sentinel so a subsequent login re-hydrates the persisted
    // recent list for the same user instead of staying permanently empty.
    this.owner = '';
    this.storage = this.injectedStorage ?? createRecentStorage('');
    this.state = { ...EMPTY_STATE, disabledPackIds: [], pendingFavoriteIds: [] };
    this.loadPromise = null;
    this.loadChatId = null;
    this.emit();
  }
}

export function createStickersStore(deps: StickersStoreDeps): StickersStore {
  return new StickersStore(deps);
}

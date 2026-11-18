package ru.krug.backend.sticker.domain.repository;

import java.util.Collection;
import java.util.Set;
import java.util.UUID;

/** Server-side cross-device favorites (E5-D-03); rows are protected by per-user RLS. */
public interface StickerFavoriteRepository {

    Set<UUID> findStickerIds(UUID userId, Collection<UUID> stickerIds);

    /** Idempotent insert (ON CONFLICT DO NOTHING). */
    void add(UUID userId, UUID stickerId);

    /** Idempotent delete. */
    void remove(UUID userId, UUID stickerId);
}

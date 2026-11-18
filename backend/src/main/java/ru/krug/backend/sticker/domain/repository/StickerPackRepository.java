package ru.krug.backend.sticker.domain.repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.sticker.domain.model.StickerPack;
import ru.krug.backend.sticker.domain.model.StickerRecord;

/** Read-only repository of the global built-in sticker catalog. */
public interface StickerPackRepository {

    /** ACTIVE packs with every sticker row (disabled stickers included for rendering). */
    List<StickerPack> findActiveWithStickers();

    Optional<StickerRecord> findSticker(UUID stickerId);

    /** Catalog lookup for message enrichment; missing/inactive rows are simply absent. */
    List<StickerRecord> findStickers(Collection<UUID> stickerIds);
}

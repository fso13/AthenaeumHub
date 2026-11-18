package ru.krug.backend.sticker.application.model;

import java.util.UUID;

/**
 * Published sticker read model matching OpenAPI {@code StickerRef}: id, pack_id, alt, url,
 * favorite. Consumed by the message context through {@code StickerCatalogPort}.
 */
public record StickerRefView(
        UUID id,
        UUID packId,
        String alt,
        String url,
        boolean favorite) {
}

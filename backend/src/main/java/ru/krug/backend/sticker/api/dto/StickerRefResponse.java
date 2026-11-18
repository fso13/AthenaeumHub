package ru.krug.backend.sticker.api.dto;

import java.util.UUID;

/** OpenAPI {@code StickerRef}. */
public record StickerRefResponse(
        UUID id,
        UUID packId,
        String alt,
        String url,
        boolean favorite) {
}

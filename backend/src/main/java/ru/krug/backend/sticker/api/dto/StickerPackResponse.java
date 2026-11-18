package ru.krug.backend.sticker.api.dto;

import java.util.List;
import java.util.UUID;

/** OpenAPI {@code StickerPack}. */
public record StickerPackResponse(
        UUID id,
        String name,
        String coverUrl,
        List<StickerRefResponse> stickers) {
}

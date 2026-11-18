package ru.krug.backend.message.api.dto;

import java.util.UUID;

/** OpenAPI {@code StickerRef} as embedded in {@code Message.sticker}. */
public record MessageStickerResponse(
        UUID id,
        UUID packId,
        String alt,
        String url,
        boolean favorite) {
}

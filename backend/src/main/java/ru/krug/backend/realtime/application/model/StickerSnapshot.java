package ru.krug.backend.realtime.application.model;

import java.util.UUID;

/** Projection of a sticker for WS payloads (matches OpenAPI StickerRef). */
public record StickerSnapshot(
        UUID id,
        UUID packId,
        String alt,
        String url,
        boolean favorite) {
}

package ru.krug.backend.sticker.api.dto;

import java.util.List;

/** OpenAPI {@code StickerPackList}. */
public record StickerPackListResponse(List<StickerPackResponse> items) {
}

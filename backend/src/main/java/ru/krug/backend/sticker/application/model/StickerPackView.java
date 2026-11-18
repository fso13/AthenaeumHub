package ru.krug.backend.sticker.application.model;

import java.util.List;
import java.util.UUID;

/** Picker read model matching OpenAPI {@code StickerPack}. */
public record StickerPackView(
        UUID id,
        String name,
        String coverUrl,
        List<StickerRefView> stickers) {

    public StickerPackView {
        stickers = stickers == null ? List.of() : List.copyOf(stickers);
    }
}

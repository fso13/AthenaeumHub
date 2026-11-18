package ru.krug.backend.message.application.model;

import java.util.UUID;

import ru.krug.backend.sticker.application.model.StickerRefView;

/**
 * Sticker projection owned by the message context. The sticker context publishes
 * {@link StickerRefView}; message maps it so API DTOs never import another context.
 */
public record MessageStickerView(
        UUID id,
        UUID packId,
        String alt,
        String url,
        boolean favorite) {

    public static MessageStickerView from(StickerRefView sticker) {
        return new MessageStickerView(sticker.id(), sticker.packId(), sticker.alt(),
                sticker.url(), sticker.favorite());
    }
}

package ru.krug.backend.sticker.application.port;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;

import ru.krug.backend.sticker.application.model.StickerRefView;

/**
 * Published catalog port consumed by the message context.
 *
 * <p>{@link #resolveForMessage} is the send gate: unknown → 404 STICKER_NOT_FOUND,
 * inactive → 410 STICKER_NOT_FOUND, non-ACTIVE pack → 409 STICKER_PACK_DISABLED.
 * {@link #findForMessage} is a non-throwing enrichment read used for history/replay:
 * already-sent stickers keep rendering after their pack is disabled.</p>
 */
public interface StickerCatalogPort {

    StickerRefView resolveForMessage(UUID viewerId, UUID stickerId);

    Map<UUID, StickerRefView> findForMessage(UUID viewerId, Collection<UUID> stickerIds);
}

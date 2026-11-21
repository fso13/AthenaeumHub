package ru.krug.backend.bot.application.port;

import java.util.UUID;

/**
 * Optional bot avatar validation. The bot references an existing workspace image attachment;
 * there is no separate upload pipeline and no avatar serving endpoint in the MVP.
 */
public interface BotAvatarPort {

    /**
     * @return the attachment id when it is a usable image of the same workspace
     * @throws ru.krug.backend.shared.error.DomainException 404 unknown/foreign/deleted
     *         attachment, 422 {@code BOT_AVATAR_INVALID} for a non-image or an unscanned file
     */
    UUID requireImage(UUID workspaceId, UUID attachmentId);
}

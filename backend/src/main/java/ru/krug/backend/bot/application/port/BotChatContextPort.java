package ru.krug.backend.bot.application.port;

import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.bot.application.model.BotChatContext;

/**
 * Bot-side chat lookup for {@code POST /bots/{botId}/messages}. It never requires the bot to
 * be a user/member: it reads the live chat and the installation row under the tenant GUC.
 */
public interface BotChatContextPort {

    /** Empty when the chat does not exist, belongs to another workspace or is soft-deleted. */
    Optional<BotChatContext> find(UUID workspaceId, UUID chatId, UUID botId);
}

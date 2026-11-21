package ru.krug.backend.bot.application.usecase;

import java.util.Map;
import java.util.UUID;

import ru.krug.backend.shared.error.DomainException;
import ru.krug.backend.shared.error.ErrorCode;

/** Shared not-found envelope for bot management operations (existence is not disclosed). */
final class BotErrors {

    private BotErrors() {
    }

    static DomainException notFound(UUID workspaceId, UUID botId) {
        return DomainException.notFound(ErrorCode.BOT_NOT_FOUND, "Bot not found",
                Map.of("workspace_id", workspaceId.toString(), "bot_id", botId.toString()));
    }
}

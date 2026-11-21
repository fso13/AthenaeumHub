package ru.krug.backend.bot.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.Bot;

/**
 * API/read projection of a bot. It contains no token and no token hash: a credential is
 * returned only once by create/rotate, never by a read endpoint.
 */
public record BotView(
        UUID id,
        UUID workspaceId,
        String name,
        UUID avatarFileId,
        List<String> scopes,
        String status,
        UUID createdBy,
        Instant createdAt,
        Instant updatedAt,
        Instant tokenRotatedAt) {

    public BotView {
        scopes = scopes == null ? List.of() : List.copyOf(scopes);
    }

    public static BotView from(Bot bot) {
        return new BotView(bot.id(), bot.workspaceId(), bot.name(), bot.avatarFileId(),
                bot.scopes(), bot.status().name(), bot.createdBy(), bot.createdAt(),
                bot.updatedAt(), bot.tokenRotatedAt());
    }
}

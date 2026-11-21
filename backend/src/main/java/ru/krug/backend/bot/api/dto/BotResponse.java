package ru.krug.backend.bot.api.dto;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** Bot metadata. Never contains a token or a token hash. */
public record BotResponse(
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
}

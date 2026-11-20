package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.UUID;

/**
 * Validated search criteria passed to infrastructure. {@code cursorCreatedAt}/{@code cursorId}
 * implement a stable keyset over candidates (not over hits), so a page that contains no
 * match still advances.
 */
public record MessageSearchCriteria(
        UUID workspaceId,
        UUID userId,
        UUID chatId,
        Instant from,
        Instant to,
        Instant cursorCreatedAt,
        UUID cursorId,
        int fetchLimit) {
}

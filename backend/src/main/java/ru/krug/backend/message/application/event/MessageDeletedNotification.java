package ru.krug.backend.message.application.event;

import java.time.Instant;
import java.util.UUID;

/**
 * After-commit signal for WS {@code message.deleted}. {@code scope} is {@code all} for the
 * broadcast tombstone; delete-for-me intentionally produces no notification.
 */
public record MessageDeletedNotification(
        UUID workspaceId,
        UUID chatId,
        UUID messageId,
        long seq,
        Instant deletedAt,
        UUID deletedBy,
        String scope,
        boolean e2ee) {
}

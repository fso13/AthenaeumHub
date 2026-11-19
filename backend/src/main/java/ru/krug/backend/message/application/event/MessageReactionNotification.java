package ru.krug.backend.message.application.event;

import java.util.UUID;

/**
 * After-commit signal for WS {@code message.reaction.changed}. Reactions are managed-only,
 * so no envelope or plaintext message content travels with the event.
 */
public record MessageReactionNotification(
        UUID workspaceId,
        UUID chatId,
        UUID messageId,
        long seq,
        UUID userId,
        String emoji,
        String action,
        long count,
        boolean e2ee) {
}

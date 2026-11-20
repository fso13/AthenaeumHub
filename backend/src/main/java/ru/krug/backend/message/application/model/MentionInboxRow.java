package ru.krug.backend.message.application.model;

import java.time.Instant;
import java.util.UUID;

/** One row of {@code GET /me/mentions}: message/chat/sender metadata and read state only. */
public record MentionInboxRow(
        UUID id,
        UUID chatId,
        String chatName,
        UUID messageId,
        UUID senderId,
        String senderDisplayName,
        boolean mentionAll,
        Instant readAt,
        Instant createdAt) {
}

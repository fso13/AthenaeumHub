package ru.krug.backend.message.api.dto;

import java.time.Instant;
import java.util.UUID;

/**
 * OpenAPI {@code Mention}: mention inbox metadata. Deliberately no message body, so the
 * inbox cannot be used as a content backdoor.
 */
public record MentionResponse(
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

package ru.krug.backend.message.domain.event;

import java.time.Instant;
import java.util.UUID;

/**
 * Domain event EVT-01. Payload is metadata only: never the plaintext body.
 */
public record MessageCreatedEvent(
        UUID messageId,
        UUID workspaceId,
        UUID chatId,
        long seq,
        UUID senderId,
        Instant createdAt,
        int sizeBytes) {
}

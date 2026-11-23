package ru.krug.backend.bot.api.dto;

import java.time.Instant;
import java.util.UUID;

/** Content-free delivery status: no payload, URL or signing secret. */
public record BotDeliveryResponse(
        UUID id,
        String eventType,
        UUID eventId,
        UUID chatId,
        String status,
        int attemptCount,
        Instant nextAttemptAt,
        Integer lastStatusCode,
        String lastError,
        Instant createdAt,
        Instant updatedAt,
        Instant deliveredAt) {
}

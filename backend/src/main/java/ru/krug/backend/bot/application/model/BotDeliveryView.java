package ru.krug.backend.bot.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.bot.domain.model.BotEventDelivery;

/** Content-free delivery status. Never includes the payload, URL or signing secret. */
public record BotDeliveryView(
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

    public static BotDeliveryView from(BotEventDelivery delivery) {
        return new BotDeliveryView(delivery.id(), delivery.eventType().wire(),
                delivery.eventId(), delivery.chatId(), delivery.status().name(),
                delivery.attemptCount(), delivery.nextAttemptAt(), delivery.lastStatusCode(),
                delivery.lastError(), delivery.createdAt(), delivery.updatedAt(),
                delivery.deliveredAt());
    }
}

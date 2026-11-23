package ru.krug.backend.bot.domain.model;

import java.time.Instant;
import java.util.UUID;

/**
 * One durable webhook delivery. {@code eventId} is the producer identity used by the unique
 * de-duplication key; {@code payloadEncrypted} is the AES-GCM envelope JSON and is never
 * exposed by a read API.
 */
public record BotEventDelivery(
        UUID id,
        UUID workspaceId,
        UUID botId,
        UUID chatId,
        BotEventType eventType,
        UUID eventId,
        byte[] payloadEncrypted,
        BotDeliveryStatus status,
        int attemptCount,
        Instant nextAttemptAt,
        Integer lastStatusCode,
        String lastError,
        Instant createdAt,
        Instant updatedAt,
        Instant deliveredAt) {

    public BotEventDelivery {
        if (payloadEncrypted != null) {
            payloadEncrypted = payloadEncrypted.clone();
        }
    }

    @Override
    public byte[] payloadEncrypted() {
        return payloadEncrypted == null ? null : payloadEncrypted.clone();
    }
}

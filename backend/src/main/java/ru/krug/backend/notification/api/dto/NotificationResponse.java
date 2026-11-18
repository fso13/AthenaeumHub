package ru.krug.backend.notification.api.dto;

import java.time.Instant;
import java.util.UUID;

public record NotificationResponse(
        UUID id,
        String type,
        UUID chatId,
        String chatName,
        String title,
        String body,
        Instant createdAt,
        boolean read) {
}

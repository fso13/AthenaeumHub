package ru.krug.backend.notification.api.dto;

import java.util.UUID;

public record NotificationPreferenceResponse(
        UUID chatId,
        String type,
        String channel,
        String mode) {
}

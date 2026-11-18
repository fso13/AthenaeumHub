package ru.krug.backend.notification.api.dto;

import java.util.UUID;

/**
 * PATCH body. Strings (not enums) are deliberate: an unknown value is a semantic 422, not
 * a Jackson deserialization 400, and the API layer stays independent of domain enums.
 */
public record NotificationPreferencePatchRequest(
        UUID chatId,
        String type,
        String channel,
        String mode) {
}

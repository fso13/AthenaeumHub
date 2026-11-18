package ru.krug.backend.notification.domain.model;

import java.util.Objects;
import java.util.UUID;

/**
 * Per-user notification preference. {@code chatId == null} is the workspace-global default;
 * a chat-scoped row overrides it for that chat.
 */
public record NotificationPreference(
        UUID userId,
        UUID workspaceId,
        UUID chatId,
        NotificationType type,
        Channel channel,
        Mode mode) {

    public NotificationPreference {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(workspaceId, "workspaceId");
        Objects.requireNonNull(type, "type");
        Objects.requireNonNull(channel, "channel");
        Objects.requireNonNull(mode, "mode");
    }

    public boolean global() {
        return chatId == null;
    }
}

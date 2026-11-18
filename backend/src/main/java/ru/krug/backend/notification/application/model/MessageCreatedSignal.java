package ru.krug.backend.notification.application.model;

import java.time.Instant;
import java.util.UUID;

import ru.krug.backend.notification.domain.model.NotificationType;

/** Event-shaped input consumed by {@link ru.krug.backend.notification.application.usecase.NotifyUseCase}. */
public record MessageCreatedSignal(
        UUID workspaceId,
        UUID chatId,
        UUID messageId,
        UUID senderId,
        Instant createdAt) {
}

package ru.krug.backend.notification.application.model;

import java.util.UUID;

import ru.krug.backend.notification.domain.model.NotificationType;

/**
 * Content-free email descriptor handed to the sender port. It intentionally has no title,
 * body or chat name: the dev stub only logs delivery metadata.
 */
public record EmailNotification(
        UUID notificationId,
        UUID userId,
        UUID chatId,
        NotificationType type) {
}

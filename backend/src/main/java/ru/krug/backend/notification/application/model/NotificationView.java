package ru.krug.backend.notification.application.model;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.model.NotificationType;

/**
 * Read model returned to the API. {@code chatName} is resolved through the chat directory
 * at read time (it is not part of the notification row).
 */
public record NotificationView(
        UUID id,
        NotificationType type,
        UUID chatId,
        String chatName,
        String title,
        String body,
        Instant createdAt,
        boolean read) {

    /** API-safe enum name; keeps api.* free of direct domain references. */
    public String typeName() {
        return type.name();
    }

    public static NotificationView from(Notification notification, String chatName) {
        return new NotificationView(notification.id(), notification.type(),
                notification.chatId(), chatName, notification.title(), notification.body(),
                notification.createdAt(), notification.isRead());
    }

    public static List<NotificationView> withChatNames(List<Notification> notifications,
                                                       ChatNameResolver resolver) {
        return notifications.stream()
                .map(notification -> from(notification,
                        resolver.resolve(notification.workspaceId(), notification.chatId())))
                .toList();
    }

    @FunctionalInterface
    public interface ChatNameResolver {
        String resolve(UUID workspaceId, UUID chatId);
    }
}

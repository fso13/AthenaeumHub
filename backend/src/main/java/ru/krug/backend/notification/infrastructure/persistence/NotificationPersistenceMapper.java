package ru.krug.backend.notification.infrastructure.persistence;

import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.model.Channel;
import ru.krug.backend.notification.domain.model.Mode;
import ru.krug.backend.notification.domain.model.NotificationType;

/** Entity ↔ domain mapping; entities never leave this package. */
final class NotificationPersistenceMapper {

    private NotificationPersistenceMapper() {
    }

    static Notification toDomain(NotificationEntity entity) {
        return Notification.reconstitute(entity.getId(), entity.getUserId(),
                entity.getWorkspaceId(), entity.getChatId(),
                NotificationType.valueOf(entity.getType()), entity.getTitle(), entity.getBody(),
                entity.getDedupeKey(), entity.getReadAt(), entity.getCreatedAt());
    }

    static NotificationPreference toDomain(NotificationPreferenceEntity entity) {
        return new NotificationPreference(entity.getUserId(), entity.getWorkspaceId(),
                entity.getChatId(), NotificationType.valueOf(entity.getType()),
                Channel.valueOf(entity.getChannel()), Mode.valueOf(entity.getMode()));
    }
}

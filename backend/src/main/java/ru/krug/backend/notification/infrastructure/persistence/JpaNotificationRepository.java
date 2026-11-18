package ru.krug.backend.notification.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Repository;

import ru.krug.backend.notification.domain.model.Notification;
import ru.krug.backend.notification.domain.repository.NotificationRepository;

@Repository
public class JpaNotificationRepository implements NotificationRepository {

    private final NotificationJpaRepository jpaRepository;

    public JpaNotificationRepository(NotificationJpaRepository jpaRepository) {
        this.jpaRepository = jpaRepository;
    }

    @Override
    public boolean saveIfAbsent(Notification notification) {
        return jpaRepository.insertIfAbsent(notification.id(), notification.userId(),
                notification.workspaceId(), notification.chatId(), notification.type().name(),
                notification.title(), notification.body(), notification.dedupeKey(),
                Timestamp.from(notification.createdAt())) > 0;
    }

    @Override
    public List<Notification> findPage(UUID userId, Instant beforeCreatedAt, UUID beforeId,
                                       int limit) {
        return jpaRepository.page(userId, beforeCreatedAt, beforeId, limit).stream()
                .map(NotificationPersistenceMapper::toDomain)
                .toList();
    }

    @Override
    public long countUnread(UUID userId) {
        return jpaRepository.countUnread(userId);
    }

    @Override
    public int markRead(UUID userId, List<UUID> ids, Instant readAt) {
        if (ids == null || ids.isEmpty()) {
            return 0;
        }
        return jpaRepository.markRead(userId, ids, Timestamp.from(readAt));
    }

    @Override
    public int markAllRead(UUID userId, Instant readAt) {
        return jpaRepository.markAllRead(userId, Timestamp.from(readAt));
    }

    @Override
    public int deleteCreatedBefore(Instant cutoff, int limit) {
        return jpaRepository.deleteCreatedBefore(Timestamp.from(cutoff), limit);
    }
}

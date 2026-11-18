package ru.krug.backend.notification.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.notification.domain.model.Notification;

/**
 * Inbox persistence. All reads/writes are user-scoped by RLS; the adapter additionally
 * filters by {@code user_id} so a bug can never cross users even under a worker setting.
 */
public interface NotificationRepository {

    /**
     * @return {@code true} when the row was inserted, {@code false} on a dedupe conflict.
     */
    boolean saveIfAbsent(Notification notification);

    List<Notification> findPage(UUID userId, Instant beforeCreatedAt, UUID beforeId, int limit);

    long countUnread(UUID userId);

    int markRead(UUID userId, List<UUID> ids, Instant readAt);

    int markAllRead(UUID userId, Instant readAt);

    /** Retention worker only: deletes at most {@code limit} rows older than the cutoff. */
    int deleteCreatedBefore(Instant cutoff, int limit);
}

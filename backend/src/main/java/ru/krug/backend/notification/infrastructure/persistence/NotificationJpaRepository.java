package ru.krug.backend.notification.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface NotificationJpaRepository extends JpaRepository<NotificationEntity, UUID> {

    @Query(value = """
            SELECT * FROM notification.notifications
             WHERE user_id = :userId
             ORDER BY created_at DESC, id DESC
             LIMIT :limit
            """, nativeQuery = true)
    List<NotificationEntity> findFirstPage(@Param("userId") UUID userId,
                                           @Param("limit") int limit);

    @Query(value = """
            SELECT * FROM notification.notifications
             WHERE user_id = :userId
               AND (created_at, id) < (:beforeCreatedAt, :beforeId)
             ORDER BY created_at DESC, id DESC
             LIMIT :limit
            """, nativeQuery = true)
    List<NotificationEntity> findPageBefore(@Param("userId") UUID userId,
                                            @Param("beforeCreatedAt") Timestamp beforeCreatedAt,
                                            @Param("beforeId") UUID beforeId,
                                            @Param("limit") int limit);

    @Query(value = """
            SELECT count(*) FROM notification.notifications
             WHERE user_id = :userId AND read_at IS NULL
            """, nativeQuery = true)
    long countUnread(@Param("userId") UUID userId);

    @Modifying
    @Query(value = """
            INSERT INTO notification.notifications
                   (id, user_id, workspace_id, chat_id, type, title, body, dedupe_key,
                    read_at, created_at)
            VALUES (:id, :userId, :workspaceId, :chatId, :type, :title, :body, :dedupeKey,
                    NULL, :createdAt)
            ON CONFLICT (dedupe_key) DO NOTHING
            """, nativeQuery = true)
    int insertIfAbsent(@Param("id") UUID id, @Param("userId") UUID userId,
                       @Param("workspaceId") UUID workspaceId, @Param("chatId") UUID chatId,
                       @Param("type") String type, @Param("title") String title,
                       @Param("body") String body, @Param("dedupeKey") String dedupeKey,
                       @Param("createdAt") Timestamp createdAt);

    @Modifying
    @Query(value = """
            UPDATE notification.notifications
               SET read_at = :readAt
             WHERE user_id = :userId AND read_at IS NULL AND id IN (:ids)
            """, nativeQuery = true)
    int markRead(@Param("userId") UUID userId, @Param("ids") Collection<UUID> ids,
                 @Param("readAt") Timestamp readAt);

    @Modifying
    @Query(value = """
            UPDATE notification.notifications
               SET read_at = :readAt
             WHERE user_id = :userId AND read_at IS NULL
            """, nativeQuery = true)
    int markAllRead(@Param("userId") UUID userId, @Param("readAt") Timestamp readAt);

    @Modifying
    @Query(value = """
            DELETE FROM notification.notifications
             WHERE id IN (
                 SELECT id FROM notification.notifications
                  WHERE created_at < :cutoff
                  ORDER BY created_at ASC
                  LIMIT :limit
             )
            """, nativeQuery = true)
    int deleteCreatedBefore(@Param("cutoff") Timestamp cutoff, @Param("limit") int limit);

    default List<NotificationEntity> page(UUID userId, Instant beforeCreatedAt, UUID beforeId,
                                          int limit) {
        return beforeCreatedAt == null
                ? findFirstPage(userId, limit)
                : findPageBefore(userId, Timestamp.from(beforeCreatedAt), beforeId, limit);
    }
}

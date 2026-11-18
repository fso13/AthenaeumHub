package ru.krug.backend.notification.infrastructure.persistence;

import java.sql.Timestamp;
import java.util.List;
import java.util.UUID;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface NotificationPreferenceJpaRepository
        extends JpaRepository<NotificationPreferenceEntity, UUID> {

    @Query(value = """
            SELECT * FROM notification.notification_preferences
             WHERE user_id = :userId
             ORDER BY type, channel, chat_id NULLS FIRST
            """, nativeQuery = true)
    List<NotificationPreferenceEntity> findByUser(@Param("userId") UUID userId);

    @Modifying
    @Query(value = """
            INSERT INTO notification.notification_preferences
                   (id, user_id, workspace_id, chat_id, type, channel, mode,
                    created_at, updated_at)
            VALUES (:id, :userId, :workspaceId, :chatId, :type, :channel, :mode,
                    :updatedAt, :updatedAt)
            ON CONFLICT ON CONSTRAINT uq_notification_preferences_scope
            DO UPDATE SET mode = EXCLUDED.mode, updated_at = EXCLUDED.updated_at
            """, nativeQuery = true)
    int upsert(@Param("id") UUID id, @Param("userId") UUID userId,
               @Param("workspaceId") UUID workspaceId, @Param("chatId") UUID chatId,
               @Param("type") String type, @Param("channel") String channel,
               @Param("mode") String mode, @Param("updatedAt") Timestamp updatedAt);

    @Query(value = """
            SELECT * FROM notification.notification_preferences
             WHERE user_id = :userId
               AND workspace_id = :workspaceId
               AND chat_id IS NOT DISTINCT FROM CAST(:chatId AS uuid)
               AND type = :type
               AND channel = :channel
            """, nativeQuery = true)
    NotificationPreferenceEntity findOne(@Param("userId") UUID userId,
                                         @Param("workspaceId") UUID workspaceId,
                                         @Param("chatId") UUID chatId,
                                         @Param("type") String type,
                                         @Param("channel") String channel);
}

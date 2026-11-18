package ru.krug.backend.notification.domain.repository;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import ru.krug.backend.notification.domain.model.NotificationPreference;

public interface NotificationPreferenceRepository {

    List<NotificationPreference> findByUser(UUID userId);

    /**
     * Idempotent upsert keyed by (user_id, workspace_id, chat_id, type, channel). A null
     * chat_id is treated as an equal key, hence the NULLS NOT DISTINCT constraint.
     */
    NotificationPreference upsert(NotificationPreference preference, Instant updatedAt);
}

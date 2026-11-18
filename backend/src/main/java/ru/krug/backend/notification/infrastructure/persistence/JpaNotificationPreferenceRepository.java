package ru.krug.backend.notification.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import org.springframework.stereotype.Repository;

import ru.krug.backend.notification.domain.model.NotificationPreference;
import ru.krug.backend.notification.domain.repository.NotificationPreferenceRepository;

@Repository
public class JpaNotificationPreferenceRepository implements NotificationPreferenceRepository {

    private final NotificationPreferenceJpaRepository jpaRepository;

    public JpaNotificationPreferenceRepository(NotificationPreferenceJpaRepository jpaRepository) {
        this.jpaRepository = jpaRepository;
    }

    @Override
    public List<NotificationPreference> findByUser(UUID userId) {
        return jpaRepository.findByUser(userId).stream()
                .map(NotificationPersistenceMapper::toDomain)
                .toList();
    }

    @Override
    public NotificationPreference upsert(NotificationPreference preference, Instant updatedAt) {
        jpaRepository.upsert(UUID.randomUUID(), preference.userId(), preference.workspaceId(),
                preference.chatId(), preference.type().name(), preference.channel().name(),
                preference.mode().name(), Timestamp.from(updatedAt));
        NotificationPreferenceEntity entity = jpaRepository.findOne(preference.userId(),
                preference.workspaceId(), preference.chatId(), preference.type().name(),
                preference.channel().name());
        return NotificationPersistenceMapper.toDomain(entity);
    }
}

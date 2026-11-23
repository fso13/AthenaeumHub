package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.repository.SessionActivityRepository;

/**
 * Self-scoped persistence of {@code auth.session_activity}. The RLS policy compares
 * {@code user_id} with the transaction GUC set by {@link
 * ru.krug.backend.auth.application.usecase.SessionActivityService}; the explicit user
 * predicate is a second guard.
 */
@Repository
public class SessionActivityRepositoryAdapter implements SessionActivityRepository {

    private final EntityManager entityManager;

    public SessionActivityRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public void touch(UUID userId, String sessionId, Instant at) {
        // Two statements keep the self-scoped RLS intact: DO NOTHING never reads another
        // user's row, and the UPDATE can only see the caller's own row. A session id that
        // belongs to another user is therefore neither read nor overwritten.
        entityManager.createNativeQuery("""
                        INSERT INTO auth.session_activity
                               (session_id, user_id, first_seen_at, last_activity_at)
                        VALUES (?1, ?2, ?3, ?3)
                        ON CONFLICT (session_id) DO NOTHING
                        """)
                .setParameter(1, sessionId)
                .setParameter(2, userId)
                .setParameter(3, Timestamp.from(at))
                .executeUpdate();
        entityManager.createNativeQuery("""
                        UPDATE auth.session_activity
                           SET last_activity_at = ?3
                         WHERE session_id = ?1 AND user_id = ?2
                        """)
                .setParameter(1, sessionId)
                .setParameter(2, userId)
                .setParameter(3, Timestamp.from(at))
                .executeUpdate();
    }

    @Override
    public Optional<Instant> lastActivity(UUID userId, String sessionId) {
        @SuppressWarnings("unchecked")
        List<Object> rows = entityManager.createNativeQuery("""
                        SELECT last_activity_at
                          FROM auth.session_activity
                         WHERE user_id = ?1 AND session_id = ?2
                        """)
                .setParameter(1, userId)
                .setParameter(2, sessionId)
                .getResultList();
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        return Optional.ofNullable(toInstant(rows.get(0)));
    }

    private static Instant toInstant(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof OffsetDateTime offset) {
            return offset.toInstant();
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof LocalDateTime local) {
            return local.toInstant(ZoneOffset.UTC);
        }
        throw new IllegalStateException("Unexpected session_activity timestamp type");
    }
}

package ru.krug.backend.auth.infrastructure.persistence;

import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.auth.domain.model.UserBlock;
import ru.krug.backend.auth.domain.model.UserBlockMutation;
import ru.krug.backend.auth.domain.repository.UserBlockRepository;

/**
 * Native-SQL block persistence (#79). The list read is protected by the self-only RLS
 * policy on {@code auth.user_blocks}; mutations run through the narrow
 * {@code auth.set_user_block} function (target existence without a cross-RLS read).
 */
@Repository
public class UserBlockRepositoryAdapter implements UserBlockRepository {

    private final EntityManager entityManager;

    public UserBlockRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public List<UserBlock> findBlocked(UUID blockerId) {
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT blocked_id, created_at
                          FROM auth.user_blocks
                         WHERE blocker_id = ?1
                         ORDER BY created_at DESC, blocked_id ASC
                        """)
                .setParameter(1, blockerId)
                .getResultList();
        return rows.stream()
                .map(row -> new UserBlock((UUID) row[0], instant(row[1])))
                .toList();
    }

    @Override
    public UserBlockMutation setBlocked(UUID blockerId, UUID blockedId, boolean blocked) {
        String outcome = (String) entityManager.createNativeQuery("""
                        SELECT auth.set_user_block(CAST(?1 AS uuid), CAST(?2 AS uuid),
                                                   CAST(?3 AS boolean))
                        """)
                .setParameter(1, blockerId)
                .setParameter(2, blockedId)
                .setParameter(3, blocked)
                .getSingleResult();
        return UserBlockMutation.parse(outcome);
    }

    private static Instant instant(Object value) {
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported timestamp type: " + value);
    }
}

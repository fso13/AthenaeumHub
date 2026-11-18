package ru.krug.backend.ops.infrastructure.persistence;

import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.EntityManager;

import org.springframework.stereotype.Repository;

import ru.krug.backend.ops.domain.model.IdempotencyKey;
import ru.krug.backend.ops.domain.repository.IdempotencyKeyRepository;

@Repository
public class IdempotencyKeyRepositoryAdapter implements IdempotencyKeyRepository {

    private final EntityManager entityManager;

    public IdempotencyKeyRepositoryAdapter(EntityManager entityManager) {
        this.entityManager = entityManager;
    }

    @Override
    public boolean tryLockKey(UUID userId, String scope, String key) {
        // 64-bit key derived deterministically from the idempotency identity. Hash
        // collisions only serialise unrelated requests; they never merge records.
        long lockId = UUID.nameUUIDFromBytes(
                        (userId + "\n" + scope + "\n" + key).getBytes(StandardCharsets.UTF_8))
                .getMostSignificantBits();
        Object result = entityManager.createNativeQuery(
                        "SELECT pg_try_advisory_xact_lock(?1)")
                .setParameter(1, lockId)
                .getSingleResult();
        return Boolean.TRUE.equals(result);
    }

    @Override
    public boolean insertIfAbsent(IdempotencyKey key) {
        int inserted = entityManager.createNativeQuery("""
                        INSERT INTO ops.idempotency_keys
                               (user_id, scope, key, request_hash, status, created_at, expires_at)
                        VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)
                        ON CONFLICT (user_id, scope, key) DO NOTHING
                        """)
                .setParameter(1, key.userId())
                .setParameter(2, key.scope())
                .setParameter(3, key.key())
                .setParameter(4, key.requestHash())
                .setParameter(5, Timestamp.from(key.createdAt()))
                .setParameter(6, Timestamp.from(key.expiresAt()))
                .executeUpdate();
        return inserted == 1;
    }

    @Override
    public Optional<IdempotencyKey> find(UUID userId, String scope, String key) {
        // Native read: the reservation service deletes/re-inserts stale rows in the same
        // transaction, so a JPA persistence-context cache would return a deleted entity.
        @SuppressWarnings("unchecked")
        List<Object[]> rows = entityManager.createNativeQuery("""
                        SELECT user_id, scope, key, request_hash, status, resource_id,
                               created_at, expires_at
                          FROM ops.idempotency_keys
                         WHERE user_id = ?1 AND scope = ?2 AND key = ?3
                        """)
                .setParameter(1, userId)
                .setParameter(2, scope)
                .setParameter(3, key)
                .getResultList();
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Object[] row = rows.get(0);
        return Optional.of(IdempotencyKey.reconstitute(
                (UUID) row[0],
                (String) row[1],
                (String) row[2],
                (byte[]) row[3],
                row[4] == null ? null : ((Number) row[4]).intValue(),
                (UUID) row[5],
                toInstant(row[6]),
                toInstant(row[7])));
    }

    @Override
    public void complete(IdempotencyKey key) {
        entityManager.createNativeQuery("""
                        INSERT INTO ops.idempotency_keys
                               (user_id, scope, key, request_hash, status, resource_id,
                                created_at, expires_at)
                        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                        ON CONFLICT (user_id, scope, key) DO UPDATE
                           SET status = EXCLUDED.status,
                               resource_id = EXCLUDED.resource_id,
                               request_hash = CASE
                                 WHEN ops.idempotency_keys.status IS NULL
                                   THEN EXCLUDED.request_hash
                                 ELSE ops.idempotency_keys.request_hash
                               END
                        """)
                .setParameter(1, key.userId())
                .setParameter(2, key.scope())
                .setParameter(3, key.key())
                .setParameter(4, key.requestHash())
                .setParameter(5, key.status())
                .setParameter(6, key.resourceId())
                .setParameter(7, Timestamp.from(key.createdAt()))
                .setParameter(8, Timestamp.from(key.expiresAt()))
                .executeUpdate();
    }

    @Override
    public void delete(UUID userId, String scope, String key) {
        entityManager.createNativeQuery("""
                        DELETE FROM ops.idempotency_keys
                         WHERE user_id = ?1 AND scope = ?2 AND key = ?3
                        """)
                .setParameter(1, userId)
                .setParameter(2, scope)
                .setParameter(3, key)
                .executeUpdate();
    }

    @Override
    public int deleteExpired(Instant now, Instant inProgressCutoff, int batchSize) {
        return entityManager.createNativeQuery("""
                        DELETE FROM ops.idempotency_keys
                         WHERE ctid IN (
                               SELECT ctid FROM ops.idempotency_keys
                                WHERE expires_at < ?1
                                   OR (status IS NULL AND created_at < ?2)
                                LIMIT ?3
                         )
                        """)
                .setParameter(1, Timestamp.from(now))
                .setParameter(2, Timestamp.from(inProgressCutoff))
                .setParameter(3, batchSize)
                .executeUpdate();
    }

    private static Instant toInstant(Object value) {
        if (value instanceof Timestamp timestamp) {
            return timestamp.toInstant();
        }
        if (value instanceof Instant instant) {
            return instant;
        }
        if (value instanceof OffsetDateTime offsetDateTime) {
            return offsetDateTime.toInstant();
        }
        throw new IllegalStateException("Unsupported idempotency timestamp type: "
                + (value == null ? "null" : value.getClass().getName()));
    }
}

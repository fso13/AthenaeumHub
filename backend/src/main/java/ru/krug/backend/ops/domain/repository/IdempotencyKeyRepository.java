package ru.krug.backend.ops.domain.repository;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

import ru.krug.backend.ops.domain.model.IdempotencyKey;

public interface IdempotencyKeyRepository {

    /**
     * Transaction-scoped advisory lock for one (user, scope, key). Returns false when
     * another transaction is currently handling the same key, which maps to the
     * contract's 409 IDEMPOTENCY_IN_PROGRESS. The lock is released on commit/rollback.
     */
    boolean tryLockKey(UUID userId, String scope, String key);

    boolean insertIfAbsent(IdempotencyKey key);

    Optional<IdempotencyKey> find(UUID userId, String scope, String key);

    /**
     * Stores the completed result. Upserts because the caller may be recovering a key
     * whose original transaction rolled back (same key/body retried after a failure).
     */
    void complete(IdempotencyKey key);

    void delete(UUID userId, String scope, String key);

    /**
     * Deletes one batch of expired keys and stale in-progress reservations. Called under
     * the explicit retention worker role so it can purge every user's rows.
     */
    int deleteExpired(Instant now, Instant inProgressCutoff, int batchSize);
}
